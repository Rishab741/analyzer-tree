import * as vscode from 'vscode';
import * as path from 'path';
import { AnalyzerTreeProvider } from './treeProvider';
import { GitWatcher, getRecentCommits, headHash, parentHashes, countCommits, RawCommit } from './gitWatcher';
import { detectAgent, RawCommit as DetectorCommit } from './agentDetector';
import { CommitMeta, KnownAgent } from './types';

type WasmModule = typeof import('./wasm/analyzer_core');

// ── State ─────────────────────────────────────────────────────────────────────

let wasm: WasmModule | null = null;
let bridge: InstanceType<WasmModule['AnalyzerBridge']> | null = null;
let activeNodeUuid: string | null = null;
let extensionCtx: vscode.ExtensionContext;
let isBatchImporting = false;

const provider = new AnalyzerTreeProvider();
const gitWatcher = new GitWatcher();
let statusBar: vscode.StatusBarItem;

// ── Activation ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionCtx = context;

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'analyzer-tree.showStats';
    statusBar.tooltip = 'Analyzer Tree — click for token stats';
    statusBar.show();

    const treeView = vscode.window.createTreeView('analyzerTree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    // Register commands FIRST — so they always exist regardless of WASM state
    const cmds: [string, (...args: unknown[]) => unknown][] = [
        ['analyzer-tree.initialize',   cmdInitialize],
        ['analyzer-tree.scanHistory',  cmdScanHistory],
        ['analyzer-tree.addDecision',  cmdAddDecision],
        ['analyzer-tree.selectNode',   cmdSelectNode],
        ['analyzer-tree.pruneNode',    cmdPruneNode],
        ['analyzer-tree.exportTree',   cmdExportTree],
        ['analyzer-tree.showStats',    cmdShowStats],
        ['analyzer-tree.saveContext',  cmdSaveContext],
    ];
    for (const [id, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    }

    context.subscriptions.push(treeView, statusBar, { dispose: () => gitWatcher.stop() });

    // Load WASM engine — commands remain registered even if this fails
    try {
        wasm = require('./wasm/analyzer_core') as WasmModule;
    } catch (err) {
        vscode.window.showErrorMessage(
            `Analyzer Tree: WASM engine failed to load — ${err}\n\nTry reinstalling the extension.`
        );
        return;
    }

    // Restore persisted tree
    const saved = context.workspaceState.get<string>('analyzerTree.snapshot');
    if (saved) {
        bridge = new wasm.AnalyzerBridge();
        if (bridge.import_tree(saved)) {
            const ctx = JSON.parse(bridge.get_active_context()) as Array<{ uuid: string }>;
            activeNodeUuid = ctx.at(-1)?.uuid ?? null;
            refreshAll();
        } else {
            bridge = null;
        }
    }

    startGitWatcher();
}

export function deactivate(): void { gitWatcher.stop(); }

// ── Commit ingestion ──────────────────────────────────────────────────────────

function startGitWatcher(): void {
    const root = repoPath();
    if (!root) { return; }
    gitWatcher.start(root, onNewCommits);
}

/**
 * Ingest every commit — human or AI — into the binary tree.
 * Agent detection is used only for enriching the label, not for filtering.
 */
async function onNewCommits(commits: RawCommit[]): Promise<void> {
    if (!bridge) { return; }
    const root = repoPath();

    for (const commit of commits) {
        // Build metadata for ALL commits; agent is null for human authors
        const asDetector = commit as unknown as DetectorCommit;
        const agent: KnownAgent | null = detectAgent(asDetector);
        const meta = buildAllCommitMeta(commit, agent);
        const label = buildLabel(commit, agent);

        // Compact content — what an LLM reads from this node
        const content = buildContent(meta);
        const metaJson = JSON.stringify(meta);

        // Locate parent node via git parent hash → tree node UUID mapping
        const parents = root ? await parentHashes(root, commit.hash) : [];
        const parentNodeUuid = findParentNode(parents) ?? activeNodeUuid;
        if (!parentNodeUuid) { continue; }

        // Try primary slot first; fall back to alternative (branch scenario)
        let uuid = bridge.add_primary_commit(parentNodeUuid, label, content, commit.hash, metaJson);

        if (uuid.startsWith('error:primary-already-exists')) {
            uuid = bridge.add_alternative_commit(parentNodeUuid, label, content, commit.hash, metaJson);
        }

        if (!uuid.startsWith('error')) {
            activeNodeUuid = uuid;
        }
    }

    persistAndRefresh();
}

function findParentNode(hashes: string[]): string | null {
    if (!bridge) { return null; }
    for (const h of hashes) {
        const uuid = bridge.uuid_for_commit(h);
        if (uuid) { return uuid; }
    }
    return null;
}

// ── Commit metadata builders ──────────────────────────────────────────────────

function buildAllCommitMeta(commit: RawCommit, agent: KnownAgent | null): CommitMeta {
    const coAuthors = (commit.body.match(/co-authored-by:\s*.+/gi) ?? [])
        .map(m => m.replace(/co-authored-by:\s*/i, '').trim());

    return {
        commit_hash: commit.hash,
        short_hash: commit.shortHash,
        agent,
        agent_display: agent ? agentDisplay(agent) : null,
        branch: commit.branch || 'unknown',
        author_name: commit.authorName,
        author_email: commit.authorEmail,
        message: commit.subject,
        body: commit.body,
        files_changed: commit.filesChanged,
        insertions: commit.insertions,
        deletions: commit.deletions,
        co_authors: coAuthors,
        timestamp: commit.timestamp,
    };
}

function buildLabel(commit: RawCommit, agent: KnownAgent | null): string {
    const who = agent ? agentDisplay(agent) : commit.authorName;
    const msg = commit.subject.slice(0, 55);
    return `${who}: ${msg}`;
}

/**
 * The content field is what an LLM reads when it analyzes a node.
 * Compact but complete: no wasted tokens.
 */
function buildContent(meta: CommitMeta): string {
    const lines = [
        `hash: ${meta.short_hash}`,
        `author: ${meta.author_name} <${meta.author_email}>`,
        meta.agent ? `agent: ${meta.agent_display}` : null,
        `branch: ${meta.branch}`,
        `message: ${meta.message}`,
        meta.body ? `body:\n${meta.body}` : null,
        `changes: +${meta.insertions} -${meta.deletions}`,
        meta.files_changed.length
            ? `files:\n${meta.files_changed.map(f => `  ${f}`).join('\n')}`
            : null,
        meta.co_authors.length
            ? `co-authors: ${meta.co_authors.join(', ')}`
            : null,
    ];
    return lines.filter(Boolean).join('\n');
}

const AGENT_DISPLAYS: Record<KnownAgent, string> = {
    claude: 'Claude', gemini: 'Gemini', copilot: 'GitHub Copilot',
    codex: 'OpenAI Codex', cursor: 'Cursor', aider: 'Aider',
    devin: 'Devin', coderabbit: 'CodeRabbit',
};
function agentDisplay(a: KnownAgent): string { return AGENT_DISPLAYS[a] ?? a; }

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInitialize(): Promise<void> {
    if (!wasm) {
        vscode.window.showErrorMessage('Analyzer Tree: WASM engine not loaded. Reinstall the extension and reload VS Code.');
        return;
    }

    const root = repoPath();
    const autoName = root ? path.basename(root) : 'Project Root';
    const commitCount = root ? await countCommits(root) : 0;
    const autoBudget = Math.max(200000, commitCount * 500);

    const choice = await vscode.window.showInformationMessage(
        `Initialize Analyzer Tree for "${autoName}"? (${commitCount} commits detected)`,
        { modal: false },
        'Initialize + Import History',
        'Customize',
    );
    if (!choice) { return; }

    let label = autoName;
    let budget = autoBudget;
    let nToImport = commitCount;

    if (choice === 'Customize') {
        const customLabel = await vscode.window.showInputBox({
            prompt: 'Project / repository name',
            value: autoName,
        });
        if (!customLabel) { return; }
        label = customLabel;

        const budgetStr = await vscode.window.showInputBox({
            prompt: `Token budget (detected ${commitCount} commits, recommended ≥ ${autoBudget.toLocaleString()})`,
            value: String(autoBudget),
            validateInput: v => isNaN(Number(v)) ? 'Must be a number' : null,
        });
        if (!budgetStr) { return; }
        budget = Number(budgetStr);

        const nStr = await vscode.window.showInputBox({
            prompt: 'How many recent commits to import? (0 = skip)',
            value: String(commitCount),
            validateInput: v => isNaN(Number(v)) ? 'Must be a number' : null,
        });
        if (nStr === undefined) { return; }
        nToImport = Number(nStr);
    }

    bridge = new wasm.AnalyzerBridge();
    const rootUuid = bridge.initialize_tree(label, `Repository: ${label}`, budget);
    activeNodeUuid = rootUuid;

    if (root) {
        const head = await headHash(root);
        if (head) { bridge.index_commit(head, rootUuid); }
    }

    persistAndRefresh();
    startGitWatcher();

    if (nToImport > 0 && root) {
        await runHistoryScan(root, nToImport);
    }
}

/**
 * Retroactively import N commits from git history into the tree.
 * Every commit — human or AI — becomes a node.
 */
async function cmdScanHistory(): Promise<void> {
    if (!bridge || !wasm) {
        vscode.window.showWarningMessage('Run "Analyzer Tree: Initialize" first.');
        return;
    }
    const root = repoPath();
    if (!root) { return; }

    const existing = root ? await countCommits(root) : 0;
    const nStr = await vscode.window.showInputBox({
        prompt: `How many recent commits to import? (repo has ${existing})`,
        value: String(existing),
        validateInput: v => isNaN(Number(v)) ? 'Must be a number' : null,
    });
    if (nStr === undefined) { return; }
    await runHistoryScan(root, Number(nStr));
}

async function runHistoryScan(root: string, n: number): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Importing git history…', cancellable: false },
        async progress => {
            progress.report({ message: `Fetching ${n} commits…` });
            const commits = (await getRecentCommits(root, n)).reverse();
            progress.report({ message: `Building tree from ${commits.length} commits…` });
            isBatchImporting = true;
            await onNewCommits(commits);
            isBatchImporting = false;
            const aiCount = commits.filter(c => detectAgent(c as unknown as DetectorCommit)).length;
            const total = bridge?.get_total_tokens() ?? 0;
            const budgetVal = bridge?.get_token_budget() ?? 0;
            vscode.window.showInformationMessage(
                `Imported ${commits.length} commits (${aiCount} AI) — ${total.toLocaleString()}/${budgetVal.toLocaleString()} tokens.`
            );
        }
    );
}

async function cmdAddDecision(): Promise<void> {
    if (!bridge || !activeNodeUuid) {
        vscode.window.showWarningMessage('Initialize the tree first.');
        return;
    }
    const label = await vscode.window.showInputBox({ prompt: 'Decision label' });
    if (!label) { return; }
    const content = await vscode.window.showInputBox({ prompt: 'Rationale / content' });
    if (!content) { return; }
    const uuid = bridge.add_agent_decision(activeNodeUuid, label, content);
    if (!uuid.startsWith('error')) { activeNodeUuid = uuid; persistAndRefresh(); }
}

function cmdSelectNode(...args: unknown[]): void {
    const uuid = args[0] as string;
    if (!bridge || !uuid) { return; }
    bridge.set_active_leaf(uuid);
    activeNodeUuid = uuid;
    updateStatusBar();
    provider.refresh(bridge.get_tree_structure());
}

async function cmdPruneNode(): Promise<void> {
    if (!bridge) { return; }
    const target = provider.activeLeafUuid ?? activeNodeUuid;
    if (!target) { return; }
    const summary = await vscode.window.showInputBox({
        prompt: 'Short summary to replace this node (reclaims tokens)',
    });
    if (!summary) { return; }
    bridge.prune_node(target, summary);
    persistAndRefresh();
}

async function cmdExportTree(): Promise<void> {
    if (!bridge) { return; }
    const doc = await vscode.workspace.openTextDocument({
        content: bridge.export_tree(),
        language: 'json',
    });
    vscode.window.showTextDocument(doc);
}

function cmdShowStats(): void {
    if (!bridge) { vscode.window.showInformationMessage('No tree initialized.'); return; }
    const total  = bridge.get_total_tokens();
    const path   = bridge.get_active_path_tokens();
    const budget = bridge.get_token_budget();
    const pct = budget > 0 ? ((total / budget) * 100).toFixed(1) : '—';
    vscode.window.showInformationMessage(
        `Total: ${total}/${budget} tok (${pct}%)  |  Active path: ${path} tok`
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function persistAndRefresh(): void {
    if (bridge) {
        extensionCtx.workspaceState.update('analyzerTree.snapshot', bridge.export_tree());
        writeContextFile(bridge.export_tree());   // keep .analyzer-tree/context.json fresh
    }
    refreshAll();
}

/** Write the tree JSON to disk so agents (Claude, etc.) can read it directly. */
async function writeContextFile(json: string): Promise<void> {
    const root = repoPath();
    if (!root) { return; }
    try {
        const dir  = vscode.Uri.joinPath(vscode.Uri.file(root), '.analyzer-tree');
        const file = vscode.Uri.joinPath(dir, 'context.json');
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(file, Buffer.from(json, 'utf8'));
    } catch { /* non-fatal */ }
}

async function cmdSaveContext(): Promise<void> {
    if (!bridge) { vscode.window.showWarningMessage('Initialize the tree first.'); return; }
    await writeContextFile(bridge.export_tree());
    vscode.window.showInformationMessage('Context saved to .analyzer-tree/context.json');
}

function refreshAll(): void {
    if (!bridge) { return; }
    provider.refresh(bridge.get_tree_structure());
    updateStatusBar();
    if (!isBatchImporting && bridge.needs_pruning()) {
        vscode.window
            .showWarningMessage(
                `Token budget exceeded (${bridge.get_total_tokens().toLocaleString()}/${bridge.get_token_budget().toLocaleString()}). Prune a node?`,
                'Prune active node',
            )
            .then(c => { if (c) { vscode.commands.executeCommand('analyzer-tree.pruneNode'); } });
    }
}

function updateStatusBar(): void {
    if (!statusBar) { return; }
    if (!bridge) { statusBar.text = '🌳 —'; return; }
    const total  = bridge.get_total_tokens();
    const budget = bridge.get_token_budget();
    statusBar.text = `🌳 ${total}/${budget}`;
    statusBar.backgroundColor = total > budget
        ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

function repoPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
