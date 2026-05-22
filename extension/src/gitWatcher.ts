import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

// ── Public commit shape ────────────────────────────────────────────────────────

export interface RawCommit {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    subject: string;
    body: string;
    timestamp: number;         // ms since epoch
    branch: string;
    filesChanged: string[];
    insertions: number;
    deletions: number;
}

// ── Git queries ────────────────────────────────────────────────────────────────

/** Fetch the N most recent commits across all local branches. */
export async function getRecentCommits(repoRoot: string, n = 100): Promise<RawCommit[]> {
    return runLog(repoRoot, [`--max-count=${n}`, '--all']);
}

/** Fetch only commits that appeared after `sinceHash` on the current branch. */
export async function getCommitsSince(repoRoot: string, sinceHash: string): Promise<RawCommit[]> {
    return runLog(repoRoot, [`${sinceHash}..HEAD`]);
}

/** Current HEAD hash. */
export async function headHash(repoRoot: string): Promise<string> {
    try {
        const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
        return stdout.trim();
    } catch { return ''; }
}

/** Direct parent hashes of a commit (>1 means a merge commit). */
export async function parentHashes(repoRoot: string, hash: string): Promise<string[]> {
    try {
        const { stdout } = await exec('git', ['log', '--format=%P', '-1', hash], { cwd: repoRoot });
        return stdout.trim().split(/\s+/).filter(Boolean);
    } catch { return []; }
}

/** Total number of commits reachable from HEAD. */
export async function countCommits(repoRoot: string): Promise<number> {
    try {
        const { stdout } = await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: repoRoot });
        return parseInt(stdout.trim(), 10) || 0;
    } catch { return 0; }
}

/** Best-effort branch name for a commit. */
export async function branchForCommit(repoRoot: string, hash: string): Promise<string> {
    try {
        const { stdout } = await exec(
            'git', ['branch', '--contains', hash, '--format=%(refname:short)'],
            { cwd: repoRoot },
        );
        return stdout.trim().split('\n')[0]?.trim() || 'unknown';
    } catch { return 'unknown'; }
}

// ── Watcher ────────────────────────────────────────────────────────────────────

export class GitWatcher {
    private disposables: vscode.Disposable[] = [];
    private lastHead = '';

    start(repoRoot: string, onCommit: (commits: RawCommit[]) => void): void {
        this.stop();
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

        const local = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/COMMIT_EDITMSG'));
        local.onDidChange(trigger);
        local.onDidCreate(trigger);

        const fetched = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/FETCH_HEAD'));
        fetched.onDidChange(trigger);

        const refs = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(repoRoot, '.git/refs/heads/**'));
        refs.onDidChange(trigger);
        refs.onDidCreate(trigger);

        this.disposables.push(local, fetched, refs);
    }

    stop(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}

// ── Parsing ────────────────────────────────────────────────────────────────────

// Use ^^HASH as a per-commit marker so we can correlate numstat with metadata.
const HASH_MARKER = '^^';

async function runLog(repoRoot: string, extraArgs: string[]): Promise<RawCommit[]> {
    try {
        // Two passes: metadata and numstat, both keyed by full hash.
        const metaArgs = ['log', ...extraArgs,
            '--format=' + HASH_MARKER + '%H%n%h%n%an%n%ae%n%at%n%s%n%b%n'];
        const statArgs = ['log', ...extraArgs,
            '--format=' + HASH_MARKER + '%H', '--numstat'];

        const [{ stdout: metaOut }, { stdout: statOut }] = await Promise.all([
            exec('git', metaArgs, { cwd: repoRoot }),
            exec('git', statArgs, { cwd: repoRoot }),
        ]);

        const statMap = parseNumstat(statOut);
        return parseMeta(metaOut, statMap);
    } catch { return []; }
}

interface FileStat { files: string[]; insertions: number; deletions: number; }

/** Parse numstat output keyed by full commit hash. */
function parseNumstat(raw: string): Map<string, FileStat> {
    const map = new Map<string, FileStat>();
    let current: FileStat | null = null;
    let currentHash = '';

    for (const line of raw.split('\n')) {
        if (line.startsWith(HASH_MARKER)) {
            currentHash = line.slice(HASH_MARKER.length).trim();
            current = { files: [], insertions: 0, deletions: 0 };
            map.set(currentHash, current);
            continue;
        }
        if (!current || !line.trim()) { continue; }
        const parts = line.split('\t');
        if (parts.length === 3) {
            const ins = parseInt(parts[0] ?? '0', 10);
            const del = parseInt(parts[1] ?? '0', 10);
            const file = parts[2]?.trim() ?? '';
            if (!isNaN(ins)) { current.insertions += ins; }
            if (!isNaN(del)) { current.deletions += del; }
            if (file) { current.files.push(file); }
        }
    }
    return map;
}

/** Parse metadata output and join with numstat. */
function parseMeta(raw: string, statMap: Map<string, FileStat>): RawCommit[] {
    const commits: RawCommit[] = [];
    const lines = raw.split('\n');
    let i = 0;

    while (i < lines.length) {
        if (!lines[i].startsWith(HASH_MARKER)) { i++; continue; }

        const hash        = lines[i].slice(HASH_MARKER.length).trim();
        const shortHash   = lines[i + 1]?.trim() ?? '';
        const authorName  = lines[i + 2]?.trim() ?? '';
        const authorEmail = lines[i + 3]?.trim() ?? '';
        const tsRaw       = lines[i + 4]?.trim() ?? '0';
        const subject     = lines[i + 5]?.trim() ?? '';

        // Body = everything between subject and next marker
        let j = i + 6;
        const bodyLines: string[] = [];
        while (j < lines.length && !lines[j].startsWith(HASH_MARKER)) {
            bodyLines.push(lines[j]);
            j++;
        }
        const body = bodyLines.join('\n').trim();
        i = j;

        if (!hash) { continue; }

        const stat = statMap.get(hash) ?? { files: [], insertions: 0, deletions: 0 };
        commits.push({
            hash,
            shortHash,
            authorName,
            authorEmail,
            subject,
            body,
            timestamp: parseInt(tsRaw, 10) * 1000,
            branch: '',
            filesChanged: stat.files,
            insertions: stat.insertions,
            deletions: stat.deletions,
        });
    }
    return commits;
}
