export type NodeType =
    | 'root'
    | 'user_prompt'
    | 'agent_decision'
    | 'agent_commit'
    | 'file_change'
    | 'tool_call'
    | 'tool_result'
    | 'pruned_checkpoint';

export type ChildRole = 'primary' | 'alternative' | 'unset';

export interface DecisionNode {
    uuid: string;
    label: string;
    node_type: NodeType;
    content: string;
    summary: string | null;
    metadata: string | null;  // JSON-encoded CommitMeta for agent_commit nodes
    token_count: number;
    timestamp: number;
    depth: number;
    is_pruned: boolean;
    role: ChildRole;
}

export interface SerializableNode {
    node: DecisionNode;
    parent_uuid: string | null;
    children: string[];
}

export interface SerializableTree {
    nodes: SerializableNode[];
    root_uuid: string;
    active_leaf_uuid: string;
    commit_index: Record<string, string>;
    total_tokens: number;
    token_budget: number;
    counter: number;
}

// ── Agent commit metadata ──────────────────────────────────────────────────────

export type KnownAgent =
    | 'claude'
    | 'gemini'
    | 'copilot'
    | 'codex'
    | 'cursor'
    | 'aider'
    | 'devin'
    | 'coderabbit'
    | 'unknown_ai';

export interface CommitMeta {
    commit_hash: string;
    short_hash: string;
    agent: KnownAgent;
    agent_display: string;
    branch: string;
    author_name: string;
    author_email: string;
    message: string;
    files_changed: string[];
    insertions: number;
    deletions: number;
    co_authors: string[];
    timestamp: number;
}

export const AGENT_ICONS: Record<KnownAgent, string> = {
    claude: '🤖',
    gemini: '✨',
    copilot: '🐙',
    codex: '🧠',
    cursor: '🖱',
    aider: '🛠',
    devin: '🦾',
    coderabbit: '🐇',
    unknown_ai: '🤖',
};

export const NODE_ICONS: Record<NodeType, string> = {
    root: '🌳',
    user_prompt: '💬',
    agent_decision: '🤖',
    agent_commit: '📦',
    file_change: '📄',
    tool_call: '⚙',
    tool_result: '↩',
    pruned_checkpoint: '✂',
};
