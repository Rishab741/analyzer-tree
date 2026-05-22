import { KnownAgent, CommitMeta } from './types';

// ── Detection rules ────────────────────────────────────────────────────────────
// Each entry: arrays of patterns tested against author name, author email,
// commit body (Co-Authored-By trailers), and commit subject.

interface AgentRule {
    agent: KnownAgent;
    display: string;
    namePatterns: RegExp[];
    emailPatterns: RegExp[];
    bodyPatterns: RegExp[];
    subjectPatterns: RegExp[];
}

const RULES: AgentRule[] = [
    {
        agent: 'claude',
        display: 'Claude (Anthropic)',
        namePatterns: [/claude/i, /claude[\s-]code/i],
        emailPatterns: [/anthropic\.com$/i, /claude/i],
        bodyPatterns: [
            /co-authored-by:\s*claude/i,
            /generated with \[claude\s*code\]/i,
            /🤖.*claude/i,
        ],
        subjectPatterns: [],
    },
    {
        agent: 'gemini',
        display: 'Gemini (Google)',
        namePatterns: [/gemini/i],
        emailPatterns: [/google\.com$/i, /gemini/i],
        bodyPatterns: [/co-authored-by:\s*gemini/i, /google gemini/i],
        subjectPatterns: [],
    },
    {
        agent: 'copilot',
        display: 'GitHub Copilot',
        namePatterns: [/copilot/i, /github copilot/i],
        emailPatterns: [/copilot@github\.com/i, /github\.com$/i],
        bodyPatterns: [/co-authored-by:\s*copilot/i, /co-authored-by:\s*github copilot/i],
        subjectPatterns: [],
    },
    {
        agent: 'codex',
        display: 'OpenAI Codex',
        namePatterns: [/codex/i, /openai/i],
        emailPatterns: [/openai\.com$/i, /codex/i],
        bodyPatterns: [/co-authored-by:\s*codex/i, /openai codex/i],
        subjectPatterns: [],
    },
    {
        agent: 'cursor',
        display: 'Cursor AI',
        namePatterns: [/cursor/i],
        emailPatterns: [/cursor\.sh$/i, /cursor/i],
        bodyPatterns: [/co-authored-by:\s*cursor/i, /cursor ai/i],
        subjectPatterns: [/\[cursor\]/i],
    },
    {
        agent: 'aider',
        display: 'Aider',
        namePatterns: [/aider/i],
        emailPatterns: [/aider/i],
        bodyPatterns: [/aider/i, /co-authored-by:\s*aider/i],
        subjectPatterns: [],
    },
    {
        agent: 'devin',
        display: 'Devin (Cognition AI)',
        namePatterns: [/devin/i, /devin\[bot\]/i],
        emailPatterns: [/cognition/i, /devin/i],
        bodyPatterns: [/co-authored-by:\s*devin/i],
        subjectPatterns: [],
    },
    {
        agent: 'coderabbit',
        display: 'CodeRabbit',
        namePatterns: [/coderabbit/i],
        emailPatterns: [/coderabbit\.ai$/i],
        bodyPatterns: [/co-authored-by:\s*coderabbit/i],
        subjectPatterns: [],
    },
];

// ── Public API ─────────────────────────────────────────────────────────────────

export interface RawCommit {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    subject: string;
    body: string;
    timestamp: number;
    branch: string;
    filesChanged: string[];
    insertions: number;
    deletions: number;
}

/** Returns null if the commit was NOT made by any known AI agent. */
export function detectAgent(commit: RawCommit): KnownAgent | null {
    for (const rule of RULES) {
        if (matchesRule(rule, commit)) {
            return rule.agent;
        }
    }
    return null;
}

/** Build the full CommitMeta record for a detected agent commit. */
export function buildCommitMeta(commit: RawCommit, agent: KnownAgent): CommitMeta {
    const rule = RULES.find(r => r.agent === agent);
    const coAuthors = extractCoAuthors(commit.body);
    return {
        commit_hash: commit.hash,
        short_hash: commit.shortHash,
        agent,
        agent_display: rule?.display ?? agent,
        branch: commit.branch,
        author_name: commit.authorName,
        author_email: commit.authorEmail,
        message: commit.subject,
        files_changed: commit.filesChanged,
        insertions: commit.insertions,
        deletions: commit.deletions,
        co_authors: coAuthors,
        timestamp: commit.timestamp,
    };
}

/** Human-readable label for a commit node. */
export function commitLabel(commit: RawCommit, agent: KnownAgent): string {
    const rule = RULES.find(r => r.agent === agent);
    const display = rule?.display ?? agent;
    const msg = commit.subject.slice(0, 60);
    return `${display}: ${msg}`;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function matchesRule(rule: AgentRule, commit: RawCommit): boolean {
    const { authorName, authorEmail, body, subject } = commit;

    return (
        rule.namePatterns.some(p => p.test(authorName)) ||
        rule.emailPatterns.some(p => p.test(authorEmail)) ||
        rule.bodyPatterns.some(p => p.test(body)) ||
        rule.subjectPatterns.some(p => p.test(subject))
    );
}

function extractCoAuthors(body: string): string[] {
    const matches = body.match(/co-authored-by:\s*.+/gi) ?? [];
    return matches.map(m => m.replace(/co-authored-by:\s*/i, '').trim());
}
