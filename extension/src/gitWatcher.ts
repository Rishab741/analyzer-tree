import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RawCommit } from './agentDetector';

const exec = promisify(execFile);

// ── Git log parsing ────────────────────────────────────────────────────────────

const SEP = '----COMMIT_SEP----';

/** Fetch the N most recent commits on all local branches. */
export async function getRecentCommits(
    repoRoot: string,
    n = 50,
): Promise<RawCommit[]> {
    try {
        // %H = full hash, %h = short, %an = author name, %ae = author email,
        // %at = unix timestamp, %s = subject, %b = body
        const { stdout: logOut } = await exec(
            'git',
            ['log', `--max-count=${n}`, '--all', '--format=%H%n%h%n%an%n%ae%n%at%n%s%n%b%n' + SEP],
            { cwd: repoRoot },
        );

        // Get numstat for the same commits (insertions/deletions + files)
        const { stdout: statOut } = await exec(
            'git',
            ['log', `--max-count=${n}`, '--all', '--numstat', '--format=' + SEP],
            { cwd: repoRoot },
        );

        return parseLogOutput(logOut, statOut, repoRoot);
    } catch {
        return [];
    }
}

/** Fetch only commits that appeared after `sinceHash` on the current branch. */
export async function getCommitsSince(
    repoRoot: string,
    sinceHash: string,
): Promise<RawCommit[]> {
    try {
        const { stdout: logOut } = await exec(
            'git',
            ['log', `${sinceHash}..HEAD`, '--format=%H%n%h%n%an%n%ae%n%at%n%s%n%b%n' + SEP],
            { cwd: repoRoot },
        );
        const { stdout: statOut } = await exec(
            'git',
            ['log', `${sinceHash}..HEAD`, '--numstat', '--format=' + SEP],
            { cwd: repoRoot },
        );
        return parseLogOutput(logOut, statOut, repoRoot);
    } catch {
        return [];
    }
}

/** Get the current HEAD hash. */
export async function headHash(repoRoot: string): Promise<string> {
    try {
        const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
        return stdout.trim();
    } catch {
        return '';
    }
}

/** Get the parent hash(es) of a commit. Returns empty array for the initial commit. */
export async function parentHashes(repoRoot: string, hash: string): Promise<string[]> {
    try {
        const { stdout } = await exec(
            'git',
            ['log', '--format=%P', '-1', hash],
            { cwd: repoRoot },
        );
        return stdout.trim().split(/\s+/).filter(Boolean);
    } catch {
        return [];
    }
}

/** Determine which branch a commit belongs to (best effort). */
export async function branchForCommit(repoRoot: string, hash: string): Promise<string> {
    try {
        const { stdout } = await exec(
            'git',
            ['branch', '--contains', hash, '--format=%(refname:short)'],
            { cwd: repoRoot },
        );
        return stdout.trim().split('\n')[0] ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

// ── Watcher ────────────────────────────────────────────────────────────────────

export class GitWatcher {
    private disposables: vscode.Disposable[] = [];
    private lastHead = '';

    /**
     * Start watching a repo. Fires `onCommit` for every new commit that arrives
     * (local or fetched from remote) that was NOT previously seen.
     */
    start(
        repoRoot: string,
        onCommit: (commits: RawCommit[]) => void,
    ): void {
        this.stop();

        // Seed the last-known HEAD so we don't replay history on startup
        headHash(repoRoot).then(h => { this.lastHead = h; });

        const trigger = async () => {
            const current = await headHash(repoRoot);
            if (!current || current === this.lastHead) { return; }

            const commits = this.lastHead
                ? await getCommitsSince(repoRoot, this.lastHead)
                : await getRecentCommits(repoRoot, 1);

            this.lastHead = current;
            if (commits.length > 0) { onCommit(commits); }
        };

        // Local commits: COMMIT_EDITMSG is rewritten after every `git commit`
        const localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/COMMIT_EDITMSG'),
        );
        localWatcher.onDidChange(trigger);
        localWatcher.onDidCreate(trigger);

        // Fetched commits: FETCH_HEAD is updated after every `git fetch/pull`
        const fetchWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/FETCH_HEAD'),
        );
        fetchWatcher.onDidChange(trigger);

        // Branch ref changes (push --force, rebase, etc.)
        const refWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/refs/heads/**'),
        );
        refWatcher.onDidChange(trigger);
        refWatcher.onDidCreate(trigger);

        this.disposables.push(localWatcher, fetchWatcher, refWatcher);
    }

    stop(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

// ── Parsing internals ──────────────────────────────────────────────────────────

function parseLogOutput(logOut: string, statOut: string, _repoRoot: string): RawCommit[] {
    const stats = parseNumstat(statOut);
    const blocks = logOut.split(SEP).map(b => b.trim()).filter(Boolean);
    const result: RawCommit[] = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 5) { continue; }

        const hash = lines[0]?.trim() ?? '';
        const shortHash = lines[1]?.trim() ?? '';
        const authorName = lines[2]?.trim() ?? '';
        const authorEmail = lines[3]?.trim() ?? '';
        const timestamp = parseInt(lines[4]?.trim() ?? '0', 10) * 1000;
        const subject = lines[5]?.trim() ?? '';
        const body = lines.slice(6).join('\n').trim();

        const stat = stats[hash] ?? { files: [], insertions: 0, deletions: 0 };

        result.push({
            hash,
            shortHash,
            authorName,
            authorEmail,
            subject,
            body,
            timestamp,
            branch: '',  // filled in by caller when needed
            filesChanged: stat.files,
            insertions: stat.insertions,
            deletions: stat.deletions,
        });
    }

    return result;
}

interface NumstatEntry {
    files: string[];
    insertions: number;
    deletions: number;
}

function parseNumstat(statOut: string): Record<string, NumstatEntry> {
    // statOut alternates: SEP (for commit header) then lines of "ins\tdel\tfile"
    const result: Record<string, NumstatEntry> = {};
    // Since we used --format=SEP before numstat, the hash isn't in statOut.
    // We correlate by index to the log blocks — simpler to just aggregate all.
    // Return a single key '' for aggregation; the caller can distribute if needed.
    // For the purposes of the tree this level of granularity is sufficient.
    const entry: NumstatEntry = { files: [], insertions: 0, deletions: 0 };
    for (const line of statOut.split('\n')) {
        const parts = line.split('\t');
        if (parts.length === 3 && parts[0] !== SEP) {
            const ins = parseInt(parts[0] ?? '0', 10);
            const del = parseInt(parts[1] ?? '0', 10);
            const file = parts[2]?.trim() ?? '';
            if (!isNaN(ins)) { entry.insertions += ins; }
            if (!isNaN(del)) { entry.deletions += del; }
            if (file) { entry.files.push(file); }
        }
    }
    result[''] = entry;
    return result;
}
