mod tree;

use wasm_bindgen::prelude::*;
use tree::{ContextTree, NodeType, SerializableTree};

// ── Bridge ────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct AnalyzerBridge {
    tree: Option<ContextTree>,
}

#[wasm_bindgen]
impl AnalyzerBridge {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { tree: None }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn initialize_tree(&mut self, root_label: &str, content: &str, token_budget: usize) -> String {
        let t = ContextTree::new(root_label, content, now(), token_budget);
        let root_uuid = t.arena.get(t.root).unwrap().get().uuid.clone();
        self.tree = Some(t);
        root_uuid
    }

    #[wasm_bindgen]
    pub fn import_tree(&mut self, json: &str) -> bool {
        match serde_json_wasm::from_str::<SerializableTree>(json) {
            Ok(s) => match s.into_context_tree() {
                Some(t) => { self.tree = Some(t); true }
                None => false,
            },
            Err(_) => false,
        }
    }

    // ── Generic inserts (non-binary) — O(1) ──────────────────────────────────

    #[wasm_bindgen]
    pub fn add_user_prompt(&mut self, parent_uuid: &str, content: &str) -> String {
        self.insert(parent_uuid, "User Prompt", NodeType::UserPrompt, content)
    }

    #[wasm_bindgen]
    pub fn add_agent_decision(&mut self, parent_uuid: &str, label: &str, content: &str) -> String {
        self.insert(parent_uuid, label, NodeType::AgentDecision, content)
    }

    #[wasm_bindgen]
    pub fn add_file_change(&mut self, parent_uuid: &str, file_path: &str, diff: &str) -> String {
        let label = format!("Δ {}", file_path);
        self.insert(parent_uuid, &label, NodeType::FileChange, diff)
    }

    #[wasm_bindgen]
    pub fn add_tool_call(&mut self, parent_uuid: &str, tool_name: &str, input: &str) -> String {
        let label = format!("⚙ {}", tool_name);
        self.insert(parent_uuid, &label, NodeType::ToolCall, input)
    }

    #[wasm_bindgen]
    pub fn add_tool_result(&mut self, parent_uuid: &str, tool_name: &str, output: &str) -> String {
        let label = format!("↩ {}", tool_name);
        self.insert(parent_uuid, &label, NodeType::ToolResult, output)
    }

    // ── Binary commit inserts — O(1) ─────────────────────────────────────────

    /// Insert a PRIMARY (left) agent commit. Fails if primary already exists.
    /// `metadata_json` is a JSON string of CommitMeta. Returns new node UUID.
    #[wasm_bindgen]
    pub fn add_primary_commit(
        &mut self,
        parent_uuid: &str,
        label: &str,
        content: &str,
        commit_hash: &str,
        metadata_json: &str,
    ) -> String {
        self.insert_binary_commit(parent_uuid, label, content, commit_hash, metadata_json, true)
    }

    /// Insert an ALTERNATIVE (right) agent commit. Primary must exist first.
    #[wasm_bindgen]
    pub fn add_alternative_commit(
        &mut self,
        parent_uuid: &str,
        label: &str,
        content: &str,
        commit_hash: &str,
        metadata_json: &str,
    ) -> String {
        self.insert_binary_commit(parent_uuid, label, content, commit_hash, metadata_json, false)
    }

    /// Register an existing node as the representative of a git commit hash.
    /// Enables O(1) parent lookup when a new child commit arrives.
    #[wasm_bindgen]
    pub fn index_commit(&mut self, commit_hash: &str, node_uuid: &str) {
        if let Some(t) = &mut self.tree {
            t.index_commit(commit_hash.to_string(), node_uuid.to_string());
        }
    }

    /// O(1) — given a git hash, return the tree node UUID that represents it.
    #[wasm_bindgen]
    pub fn uuid_for_commit(&self, commit_hash: &str) -> String {
        self.tree
            .as_ref()
            .and_then(|t| t.uuid_for_commit(commit_hash))
            .unwrap_or("")
            .to_string()
    }

    // ── Binary reads — O(1) ──────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn get_primary_child(&self, parent_uuid: &str) -> String {
        self.tree
            .as_ref()
            .and_then(|t| t.primary_child_uuid(parent_uuid))
            .unwrap_or_default()
    }

    #[wasm_bindgen]
    pub fn get_alternative_child(&self, parent_uuid: &str) -> String {
        self.tree
            .as_ref()
            .and_then(|t| t.alternative_child_uuid(parent_uuid))
            .unwrap_or_default()
    }

    // ── Navigation & pruning — O(1) ──────────────────────────────────────────

    #[wasm_bindgen]
    pub fn set_active_leaf(&mut self, uuid: &str) -> bool {
        self.tree.as_mut().map(|t| t.set_active_leaf(uuid)).unwrap_or(false)
    }

    #[wasm_bindgen]
    pub fn prune_node(&mut self, uuid: &str, summary: &str) -> bool {
        self.tree.as_mut().map(|t| t.prune_node(uuid, summary.to_string())).unwrap_or(false)
    }

    #[wasm_bindgen]
    pub fn needs_pruning(&self) -> bool {
        self.tree.as_ref().map(|t| t.needs_pruning()).unwrap_or(false)
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn get_total_tokens(&self) -> usize {
        self.tree.as_ref().map(|t| t.total_tokens).unwrap_or(0)
    }

    #[wasm_bindgen]
    pub fn get_active_path_tokens(&self) -> usize {
        self.tree.as_ref().map(|t| t.active_path_tokens()).unwrap_or(0)
    }

    #[wasm_bindgen]
    pub fn get_token_budget(&self) -> usize {
        self.tree.as_ref().map(|t| t.token_budget).unwrap_or(0)
    }

    #[wasm_bindgen]
    pub fn get_active_context(&self) -> String {
        match &self.tree {
            Some(t) => serde_json_wasm::to_string(&t.active_path())
                .unwrap_or_else(|_| "[]".to_string()),
            None => "[]".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn export_tree(&self) -> String {
        match &self.tree {
            Some(t) => serde_json_wasm::to_string(&t.to_serializable())
                .unwrap_or_else(|_| "{}".to_string()),
            None => "{}".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn get_tree_structure(&self) -> String {
        self.export_tree()
    }
}

// ── Private helpers ────────────────────────────────────────────────────────────

impl AnalyzerBridge {
    fn insert(&mut self, parent_uuid: &str, label: &str, node_type: NodeType, content: &str) -> String {
        match &mut self.tree {
            Some(t) => t
                .add_node(parent_uuid, label.to_string(), node_type, content.to_string(), now())
                .unwrap_or_else(|| "error:parent-not-found".to_string()),
            None => "error:tree-not-initialized".to_string(),
        }
    }

    fn insert_binary_commit(
        &mut self,
        parent_uuid: &str,
        label: &str,
        content: &str,
        commit_hash: &str,
        metadata_json: &str,
        is_primary: bool,
    ) -> String {
        let t = match &mut self.tree {
            Some(t) => t,
            None => return "error:tree-not-initialized".to_string(),
        };

        let meta = if metadata_json.is_empty() {
            None
        } else {
            Some(metadata_json.to_string())
        };

        let result = if is_primary {
            t.add_primary(
                parent_uuid,
                label.to_string(),
                NodeType::Commit,
                content.to_string(),
                meta,
                now(),
            )
        } else {
            t.add_alternative(
                parent_uuid,
                label.to_string(),
                NodeType::Commit,
                content.to_string(),
                meta,
                now(),
            )
        };

        match result {
            Some(uuid) => {
                if !commit_hash.is_empty() {
                    t.index_commit(commit_hash.to_string(), uuid.clone());
                }
                uuid
            }
            None => {
                if is_primary {
                    "error:primary-already-exists".to_string()
                } else {
                    "error:alternative-slot-taken-or-no-primary".to_string()
                }
            }
        }
    }
}

fn now() -> u64 {
    js_sys::Date::now() as u64
}
