import * as vscode from 'vscode';
import { AnalyzerTreeProvider } from './treeProvider';
import { GitWatcher, getRecentCommits, headHash, parentHashes } from './gitWatcher';
import { detectAgent, buildCommitMeta, commitLabel, RawCommit } from './agentDetector';

type WasmModule = typeof import('./wasm/analyzer_core');

// ── State ─────────────────────────────────────────────────────────────────────

let wasm: WasmModule | null = null;
let bridge: InstanceType<WasmModule['AnalyzerBridge']> | null = null;
let activeNodeUuid: string | null = null;
let extensionCtx: vscode.ExtensionContext;

const provider = new AnalyzerTreeProvider();
const gitWatcher = new GitWatcher();
let statusBar: vscode.StatusBarItem;

// ── Activation ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionCtx = context;

    try {
        wasm = await import('./wasm/analyzer_core');
    } catch (err) {
        vscode.window.showErrorMessage(`Analyzer Tree: failed to load Rust engine — ${err}`);
        return;
    }

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'analyzer-tree.showStats';
    statusBar.tooltip = 'Analyzer Tree — click for token stats';
    statusBar.show();

    const treeView = vscode.window.createTreeView('analyzerTree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

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

    // Commands
    const cmds: [string, (...args: unknown[]) => unknown][] = [
        ['analyzer-tree.initialize',  cmdInitialize],
        ['analyzer-tree.addDecision', cmdAddDecision],
        ['analyzer-tree.selectNode',  cmdSelectNode],
        ['analyzer-tree.pruneNode',   cmdPruneNode],
        ['analyzer-tree.exportTree',  cmdExportTree],
        ['analyzer-tree.showStats',   cmdShowStats],
        ['analyzer-tree.scanHistory', cmdScanHistory],
    ];
    for (const [id, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    }

    // Start git watcher if we have a workspace
    startGitWatcher();

    context.subscriptions.push(treeView, statusBar, {
        dispose: () => gitWatcher.stop(),
    });
}

export function deactivate(): void {
    gitWatcher.stop();
}

// ── Git commit ingestion ──────────────────────────────────────────────────────

function startGitWatcher(): void {
    const repoRoot = repoPath();
    if (!repoRoot) { return; }
    gitWatcher.start(repoRoot, onNewCommits);
}

async function onNewCommits(commits: RawCommit[]): Promise<void> {
    if (!bridge || !wasm) { return; }

    for (const commit of commits) {
        const agent = detectAgent(commit);
        if (!agent) { continue; }  // not an AI agent — skip

        const meta = buildCommitMeta(commit, agent);
        const label = commitLabel(commit, agent);
        const content = [
            `Agent: ${meta.agent_display}`,
            `Branch: ${meta.branch}`,
            `Files: ${meta.files_changed.join(', ') || 'none'}`,
            `+${meta.insertions} -${meta.deletions}`,
            `Message: ${meta.message}`,
        ].join('\n');

        const metaJson = JSON.stringify(meta);

        // Find the tree parent: look up the git parent commit in the commit index
        const parents = await parentHashes(repoPath()!, commit.hash);
        const parentNodeUuid = findParentNodeUuid(parents) ?? activeNodeUuid ?? null;

        if (!parentNodeUuid) { continue; }

        // Try to insert as primary; if that slot is taken, insert as alternative
        let uuid = bridge.add_primary_commit(
            parentNodeUuid, label, content, commit.hash, metaJson,
        );

        if (uuid.startsWith('error:primary-already-exists')) {
            uuid = bridge.add_alternative_commit(
                parentNodeUuid, label, content, commit.hash, metaJson,
            );
        }

        if (!uuid.startsWith('error')) {
            activeNodeUuid = uuid;
        }
    }

    persistAndRefresh();
}

/** Walk parent hashes until we find one that exists in the commit index. */
function findParentNodeUuid(parentHashes: string[]): string | null {
    if (!bridge) { return null; }
    for (const hash of parentHashes) {
        const uuid = bridge.uuid_for_commit(hash);
        if (uuid) { return uuid; }
    }
    return null;
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdInitialize(): Promise<void> {
    if (!wasm) { return; }

    const label = await vscode.window.showInputBox({
        prompt: 'Project / task name for the root node',
        value: 'Project Root',
    });
    if (!label) { return; }

    const budgetStr = await vscode.window.showInputBox({
        prompt: 'Token budget (default 8000)',
        value: '8000',
        validateInput: v => (isNaN(Number(v)) ? 'Must be a number' : null),
    });
    const budget = Number(budgetStr ?? '8000');

    bridge = new wasm.AnalyzerBridge();
    const rootUuid = bridge.initialize_tree(label, `Root: ${label}`, budget);
    activeNodeUuid = rootUuid;

    // Seed the commit index with the current HEAD so future commits can find their parent
    const root = repoPath();
    if (root) {
        const head = await headHash(root);
        if (head) { bridge.index_commit(head, rootUuid); }
    }

    vscode.window.showInformationMessage(
        `Analyzer Tree initialized. Watching for AI commits (Claude, Gemini, Copilot, Codex…)`,
    );
    persistAndRefresh();
    startGitWatcher();
}

/** Scan the last N commits of the repo history and import any AI agent commits. */
async function cmdScanHistory(): Promise<void> {
    if (!bridge || !wasm) {
        vscode.window.showWarningMessage('Initialize the tree first.');
        return;
    }
    const root = repoPath();
    if (!root) { return; }

    const nStr = await vscode.window.showInputBox({
        prompt: 'How many recent commits to scan?',
        value: '50',
        validateInput: v => (isNaN(Number(v)) ? 'Must be a number' : null),
    });
    const n = Number(nStr ?? '50');

    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning git history…', cancellable: false },
        async () => {
            const commits = await getRecentCommits(root, n);
            const aiCommits = commits.filter(c => detectAgent(c) !== null);
            await onNewCommits(aiCommits);
            vscode.window.showInformationMessage(
                `Scan complete. Found ${aiCommits.length} AI agent commit(s) out of ${commits.length}.`,
            );
        },
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
    if (!uuid.startsWith('error')) {
        activeNodeUuid = uuid;
        persistAndRefresh();
    }
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
        prompt: 'Compact summary to replace node content (saves tokens)',
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
    if (!bridge) {
        vscode.window.showInformationMessage('No tree initialized.');
        return;
    }
    const total = bridge.get_total_tokens();
    const path  = bridge.get_active_path_tokens();
    const budget = bridge.get_token_budget();
    const pct = budget > 0 ? ((total / budget) * 100).toFixed(1) : '—';
    vscode.window.showInformationMessage(
        `Total: ${total}/${budget} tok (${pct}%)  |  Active path: ${path} tok`,
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function persistAndRefresh(): void {
    if (bridge) {
        extensionCtx.workspaceState.update('analyzerTree.snapshot', bridge.export_tree());
    }
    refreshAll();
}

function refreshAll(): void {
    if (!bridge) { return; }
    provider.refresh(bridge.get_tree_structure());
    updateStatusBar();
    if (bridge.needs_pruning()) {
        vscode.window
            .showWarningMessage(
                `Token budget exceeded (${bridge.get_total_tokens()}/${bridge.get_token_budget()}). Prune a node?`,
                'Prune active node',
            )
            .then(choice => {
                if (choice) { vscode.commands.executeCommand('analyzer-tree.pruneNode'); }
            });
    }
}

function updateStatusBar(): void {
    if (!statusBar) { return; }
    if (!bridge) { statusBar.text = '🌳 —'; return; }
    const total = bridge.get_total_tokens();
    const budget = bridge.get_token_budget();
    statusBar.text = `🌳 ${total}/${budget}`;
    statusBar.backgroundColor = total > budget
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
}

function repoPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
