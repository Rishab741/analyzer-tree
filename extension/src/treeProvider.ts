import * as vscode from 'vscode';
import { DecisionNode, SerializableTree, NODE_ICONS, AGENT_ICONS, CommitMeta } from './types';

export class AnalyzerTreeProvider implements vscode.TreeDataProvider<string> {
    private _onDidChangeTreeData = new vscode.EventEmitter<string | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private treeData: SerializableTree | null = null;
    private nodeMap = new Map<string, DecisionNode>();
    private childMap = new Map<string, string[]>();

    // ── Public API ────────────────────────────────────────────────────────────

    refresh(structureJson: string): void {
        try {
            this.treeData = JSON.parse(structureJson) as SerializableTree;
            this.nodeMap.clear();
            this.childMap.clear();
            for (const sn of this.treeData.nodes) {
                this.nodeMap.set(sn.node.uuid, sn.node);
                this.childMap.set(sn.node.uuid, sn.children);
            }
        } catch {
            this.treeData = null;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    get activeLeafUuid(): string | null {
        return this.treeData?.active_leaf_uuid ?? null;
    }

    // ── TreeDataProvider ──────────────────────────────────────────────────────

    getTreeItem(uuid: string): vscode.TreeItem {
        const node = this.nodeMap.get(uuid);
        if (!node) { return new vscode.TreeItem('(unknown)'); }

        const children = this.childMap.get(uuid) ?? [];
        const collapsible = children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const rolePrefix = node.role === 'primary'
            ? '← '
            : node.role === 'alternative'
                ? '→ '
                : '';

        const nodeIcon = node.node_type === 'agent_commit'
            ? agentIcon(node)
            : NODE_ICONS[node.node_type];

        const item = new vscode.TreeItem(
            `${nodeIcon} ${rolePrefix}${node.label}`,
            collapsible,
        );

        item.id = uuid;
        item.description = buildDescription(node);
        item.tooltip = buildTooltip(node);
        item.contextValue = node.is_pruned ? 'pruned' : node.node_type;

        if (uuid === this.treeData?.active_leaf_uuid) {
            item.iconPath = new vscode.ThemeIcon(
                'circle-filled',
                new vscode.ThemeColor('charts.green'),
            );
        } else if (node.role === 'alternative') {
            item.iconPath = new vscode.ThemeIcon('git-branch');
        }

        item.command = {
            command: 'analyzer-tree.selectNode',
            title: 'Select Node',
            arguments: [uuid],
        };

        return item;
    }

    getChildren(uuid?: string): string[] {
        if (!this.treeData) { return []; }
        if (!uuid) { return [this.treeData.root_uuid]; }
        return this.childMap.get(uuid) ?? [];
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentIcon(node: DecisionNode): string {
    if (!node.metadata) { return '📦'; }
    try {
        const meta = JSON.parse(node.metadata) as CommitMeta;
        return AGENT_ICONS[meta.agent] ?? '🤖';
    } catch {
        return '📦';
    }
}

function buildDescription(node: DecisionNode): string {
    if (node.node_type === 'agent_commit' && node.metadata) {
        try {
            const meta = JSON.parse(node.metadata) as CommitMeta;
            return `${meta.short_hash}  +${meta.insertions}/-${meta.deletions}  ${node.token_count}tok`;
        } catch { /* fall through */ }
    }
    return `${node.token_count} tok`;
}

function buildTooltip(node: DecisionNode): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = false;

    if (node.node_type === 'agent_commit' && node.metadata) {
        try {
            const meta = JSON.parse(node.metadata) as CommitMeta;
            md.appendMarkdown(`**${AGENT_ICONS[meta.agent]} ${meta.agent_display}** — \`${meta.short_hash}\`\n\n`);
            md.appendMarkdown(`> ${meta.message}\n\n`);
            md.appendMarkdown(`| | |\n|---|---|\n`);
            md.appendMarkdown(`| Branch | \`${meta.branch}\` |\n`);
            md.appendMarkdown(`| Author | ${meta.author_name} |\n`);
            md.appendMarkdown(`| Changes | +${meta.insertions} / -${meta.deletions} |\n`);
            md.appendMarkdown(`| Files | ${meta.files_changed.length} |\n`);
            md.appendMarkdown(`| Tokens | ${node.token_count} |\n`);
            if (meta.files_changed.length > 0) {
                md.appendMarkdown(`\n**Files changed:**\n`);
                for (const f of meta.files_changed.slice(0, 10)) {
                    md.appendMarkdown(`- \`${f}\`\n`);
                }
                if (meta.files_changed.length > 10) {
                    md.appendMarkdown(`- *(${meta.files_changed.length - 10} more…)*\n`);
                }
            }
            return md;
        } catch { /* fall through to generic */ }
    }

    md.appendMarkdown(`**${node.label}**\n\n`);
    md.appendMarkdown(`- Type: \`${node.node_type}\`  Role: \`${node.role}\`\n`);
    md.appendMarkdown(`- Tokens: \`${node.token_count}\`  Depth: \`${node.depth}\`\n`);
    if (node.is_pruned) {
        md.appendMarkdown(`- *(pruned)*\n\n`);
        md.appendCodeblock(node.summary ?? '[pruned]', 'text');
    } else {
        md.appendCodeblock(node.content.slice(0, 400), 'text');
    }
    return md;
}
