# Analyzer Tree

A VS Code extension that turns your git history into a binary decision tree — so LLMs can understand a project in one structured read instead of scanning every file.

Every commit (human or AI) becomes a node. Branches create left/right splits. AI agent commits (Claude, Gemini, Copilot, Codex, Cursor, Aider, Devin, CodeRabbit) are automatically labelled with their agent. The tree is always exportable as compact JSON ready to paste into any LLM context window.

---

## How it works

```
main branch
    root (project start)
     ├── [👤] Alice: initial scaffold           ← primary
     │    ├── [🤖] Claude: add auth module      ← primary
     │    │    └── [👤] Bob: fix typo           ← primary
     │    └── [✨] Gemini: alternative auth     ← alternative (feature branch)
     └── [🐙] Copilot: add tests               ← primary
```

- **Primary (←)** — the commit that followed on the same branch
- **Alternative (→)** — the first commit on a diverging branch
- Each node stores: commit hash, author, message, files changed, insertions/deletions, token count
- Pruning replaces heavy nodes with a short summary, reclaiming tokens immediately (O(1))

The Rust/WASM core maintains a running token count so budget checks are always O(1) — no tree walks.

---

## Requirements

| Tool | Version | Install |
|---|---|---|
| VS Code | 1.85+ | [code.visualstudio.com](https://code.visualstudio.com) |
| Rust + Cargo | stable | `rustup install stable` |
| wasm-pack | latest | `cargo install wasm-pack` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| Git | any | already installed |

---

## Installation (two ways)

### Option A — Install the `.vsix` (recommended for using it)

```bash
# 1. Clone the repo
git clone https://github.com/Rishab741/analyzer-tree.git
cd analyzer-tree

# 2. Install Node dependencies
npm install
cd extension && npm install && cd ..

# 3. Build Rust core → WASM
npm run build:core

# 4. Bundle the extension
npm run compile:extension

# 5. Package as .vsix
cd extension
npx @vscode/vsce package --no-dependencies
cd ..

# 6. Install into VS Code
code --install-extension extension/analyzer-tree-extension-0.1.0.vsix
```

Restart VS Code after step 6. The extension is now permanently installed.

---

### Option B — F5 dev mode (for development / testing)

```bash
# 1–4 same as above, then open the root folder in VS Code:
code .

# Press F5  →  a second VS Code window opens with the extension loaded
```

---

## Running it on a project — step by step

### Step 1 — Open your project in VS Code

Open any git repository in VS Code. The extension works on the **currently open workspace**.

```bash
code /path/to/your-project
```

---

### Step 2 — Initialize the tree

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
Analyzer Tree: Initialize
```

You will be prompted for:
- **Project name** — used as the root node label (e.g. `my-api`)
- **Token budget** — how many tokens the full tree is allowed to use before pruning warnings trigger (start with `8000` for GPT-4, `200000` for Claude)

The status bar bottom-right will show `🌳 0/8000`.

---

### Step 3 — Import existing commits

```
Analyzer Tree: Scan Git History
```

Enter how many recent commits to import (e.g. `100`). The extension reads your full git log, builds the binary tree from the branch structure, and populates the **Context Tree** panel in the Explorer sidebar.

Progress is shown in a notification. When done you will see:

```
Imported 87 commits (3 from AI agents) into the context tree.
```

---

### Step 4 — Browse the tree

Open the **Explorer** sidebar (`Ctrl+Shift+E`). Scroll down to the **Context Tree** panel.

| Icon | Meaning |
|---|---|
| 🌳 | Repository root |
| 👤 `←` | Human commit, primary path |
| 👤 `→` | Human commit, alternative branch |
| 🤖 `←` | Claude commit, primary path |
| ✨ | Gemini commit |
| 🐙 | GitHub Copilot commit |
| 🧠 | OpenAI Codex commit |
| 🖱 | Cursor commit |
| 🛠 | Aider commit |
| 🦾 | Devin commit |
| 🐇 | CodeRabbit commit |
| ✂ | Pruned node (content replaced with summary) |

Click any node to make it the **active leaf**. The active leaf is highlighted green and shown in the status bar.

Hover over a node for its full tooltip: commit hash, author, branch, changed files, insertions/deletions.

---

### Step 5 — Export for an LLM

```
Analyzer Tree: Export Tree JSON
```

A new editor opens with the full tree as JSON. Copy it and paste into any LLM prompt:

```
Here is the git history of this project as a structured tree.
Each node contains the commit hash, author, message, and files changed.
Primary (←) nodes are the main branch. Alternative (→) nodes are branches.

<paste JSON here>

Question: what was the intent behind the auth module refactor?
```

The LLM can now answer questions about the project history, understand who changed what, trace decisions, and find patterns — without reading a single source file.

---

### Step 6 — Keep the tree live

Once initialized, the extension **watches your repo automatically**. Every new commit you or an AI agent makes is appended to the tree in real time — no manual rescan needed.

Watched events:
- `.git/COMMIT_EDITMSG` → local `git commit`
- `.git/FETCH_HEAD` → `git fetch` / `git pull`
- `.git/refs/heads/*` → branch updates, force-push, rebase

---

### Step 7 — Prune when over budget

When the token count exceeds your budget, the status bar turns orange and a warning appears. To reclaim tokens:

```
Analyzer Tree: Prune Active Node
```

Enter a short summary (e.g. `"refactored auth to use JWT, 12 files changed"`). The node's full content is replaced with the summary. Token count updates instantly (O(1)).

Old content is gone from the in-memory tree but the commit hash and metadata remain in the node, so you can always re-read the original from `git show <hash>`.

---

## All commands

| Command | What it does |
|---|---|
| `Analyzer Tree: Initialize` | Create a new tree for the current workspace |
| `Analyzer Tree: Scan Git History` | Import N past commits into the tree |
| `Analyzer Tree: Add Decision Node` | Manually record a decision or rationale |
| `Analyzer Tree: Prune Active Node` | Replace active node content with a summary |
| `Analyzer Tree: Export Tree JSON` | Open full tree JSON in editor |
| `Analyzer Tree: Show Token Stats` | Pop up total / path / budget token counts |

---

## Project structure

```
analyzer-tree/
├── core/                      # Rust — compiled to WASM
│   └── src/
│       ├── tree.rs            # Binary tree, O(1) ops, arena allocation
│       └── lib.rs             # wasm-bindgen bridge (JS-callable API)
├── extension/                 # VS Code extension (TypeScript)
│   └── src/
│       ├── extension.ts       # Activation, commands, git ingestion
│       ├── gitWatcher.ts      # Watches .git refs, parses git log
│       ├── agentDetector.ts   # Identifies Claude/Gemini/Copilot/etc.
│       ├── treeProvider.ts    # VS Code TreeDataProvider (sidebar)
│       └── types.ts           # Shared TypeScript types
└── .vscode/
    ├── launch.json            # F5 dev host config
    └── tasks.json             # Build tasks
```

---

## Build commands

```bash
# Build Rust core → WASM (run after any change to core/src/)
npm run build:core

# Bundle TypeScript extension (run after any change to extension/src/)
npm run compile:extension

# Both in one shot
npm run build

# Watch mode for extension (auto-recompiles on save)
npm run watch:extension
```

---

## Supported AI agents

| Agent | Detection method |
|---|---|
| Claude (Anthropic) | `Co-Authored-By: Claude`, `@anthropic.com`, `Generated with [Claude Code]` |
| Gemini (Google) | `Co-Authored-By: Gemini`, `@google.com` |
| GitHub Copilot | `copilot@github.com`, `Co-Authored-By: GitHub Copilot` |
| OpenAI Codex | `@openai.com`, `co-authored-by: codex` |
| Cursor | `cursor.sh` email domain, `[Cursor]` in subject |
| Aider | `co-authored-by: aider` in commit body |
| Devin (Cognition) | `devin[bot]` author name |
| CodeRabbit | `coderabbit.ai` email domain |

Human commits are included in the tree as `👤` nodes — agent detection only changes the label and icon, not whether the commit appears.

---

## Token efficiency

The core is designed so no operation requires walking the full tree:

| Operation | Complexity |
|---|---|
| Insert commit node | O(1) |
| Look up node by UUID | O(1) |
| Look up node by git hash | O(1) |
| Get total token count | O(1) — maintained as running sum |
| Check if over budget | O(1) |
| Prune a node | O(1) |
| Get root→active-leaf path | O(depth) — bounded by branch depth |

---

## License

MIT
