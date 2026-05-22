use serde::{Deserialize, Serialize};
use indextree::{Arena, NodeId};
use std::collections::HashMap;

// ── Node classification ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Root,
    UserPrompt,
    AgentDecision,
    AgentCommit,   // a git commit authored/co-authored by an AI agent
    FileChange,
    ToolCall,
    ToolResult,
    PrunedCheckpoint,
}

/// Position of a node relative to its parent in the binary tree.
/// Primary = left / accepted path. Alternative = right / rejected or branched path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChildRole {
    Primary,
    Alternative,
    Unset, // for non-binary node types
}

// ── Core node ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionNode {
    pub uuid: String,
    pub label: String,
    pub node_type: NodeType,
    pub content: String,
    pub summary: Option<String>,
    /// For AgentCommit nodes: JSON-encoded CommitMeta. Null for other types.
    pub metadata: Option<String>,
    pub token_count: usize,
    pub timestamp: u64,
    pub depth: u32,
    pub is_pruned: bool,
    pub role: ChildRole,
}

impl DecisionNode {
    pub fn new(
        uuid: String,
        label: String,
        node_type: NodeType,
        content: String,
        timestamp: u64,
        depth: u32,
        role: ChildRole,
    ) -> Self {
        let token_count = estimate_tokens(&content);
        Self {
            uuid,
            label,
            node_type,
            content,
            summary: None,
            metadata: None,
            token_count,
            timestamp,
            depth,
            is_pruned: false,
            role,
        }
    }

    pub fn effective_tokens(&self) -> usize {
        if self.is_pruned {
            self.summary
                .as_ref()
                .map(|s| estimate_tokens(s))
                .unwrap_or(5)
        } else {
            self.token_count
        }
    }
}

/// GPT-4 style approximation: blend char density and word count.
/// Stays within ~10% of tiktoken for English prose. O(n) on text but called once per insert.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let by_chars = text.len() / 4;
    let by_words = text.split_whitespace().count() * 4 / 3;
    (by_chars + by_words) / 2 + 1
}

// ── Tree ──────────────────────────────────────────────────────────────────────

pub struct ContextTree {
    pub arena: Arena<DecisionNode>,
    pub root: NodeId,
    pub active_leaf: NodeId,
    /// O(1) UUID → NodeId
    node_index: HashMap<String, NodeId>,
    /// O(1) git commit hash → node UUID (for binary tree parent lookup)
    pub commit_index: HashMap<String, String>,
    /// Running token sum — O(1) budget check
    pub total_tokens: usize,
    pub token_budget: usize,
    counter: u64,
}

impl ContextTree {
    /// O(1)
    pub fn new(label: &str, content: &str, timestamp: u64, budget: usize) -> Self {
        let mut arena = Arena::new();
        let mut node_index = HashMap::new();
        let uuid = "root-0".to_string();
        let root_node = DecisionNode::new(
            uuid.clone(),
            label.to_string(),
            NodeType::Root,
            content.to_string(),
            timestamp,
            0,
            ChildRole::Unset,
        );
        let total_tokens = root_node.token_count;
        let root = arena.new_node(root_node);
        node_index.insert(uuid, root);
        ContextTree {
            arena,
            root,
            active_leaf: root,
            node_index,
            commit_index: HashMap::new(),
            total_tokens,
            token_budget: budget,
            counter: 1,
        }
    }

    // ── Generic insert (non-binary) — O(1) ────────────────────────────────────

    pub fn add_node(
        &mut self,
        parent_uuid: &str,
        label: String,
        node_type: NodeType,
        content: String,
        timestamp: u64,
    ) -> Option<String> {
        self.add_node_with_role(parent_uuid, label, node_type, content, timestamp, ChildRole::Unset)
    }

    // ── Binary inserts — O(1) ─────────────────────────────────────────────────

    /// Add as PRIMARY (left) child. Fails if the parent already has a primary child.
    pub fn add_primary(
        &mut self,
        parent_uuid: &str,
        label: String,
        node_type: NodeType,
        content: String,
        metadata: Option<String>,
        timestamp: u64,
    ) -> Option<String> {
        let parent_id = *self.node_index.get(parent_uuid)?;
        // Binary: primary must not exist yet
        if self.arena.get(parent_id)?.first_child().is_some() {
            return None;
        }
        let uuid = self.add_node_with_role(
            parent_uuid, label, node_type, content, timestamp, ChildRole::Primary,
        )?;
        if let Some(meta) = metadata {
            if let Some(&id) = self.node_index.get(&uuid) {
                if let Some(n) = self.arena.get_mut(id) {
                    n.get_mut().metadata = Some(meta);
                }
            }
        }
        Some(uuid)
    }

    /// Add as ALTERNATIVE (right) child. Fails if the parent already has an alternative,
    /// or does not yet have a primary (enforce left-before-right ordering).
    pub fn add_alternative(
        &mut self,
        parent_uuid: &str,
        label: String,
        node_type: NodeType,
        content: String,
        metadata: Option<String>,
        timestamp: u64,
    ) -> Option<String> {
        let parent_id = *self.node_index.get(parent_uuid)?;
        let first = self.arena.get(parent_id)?.first_child()?; // primary must exist
        // Alternative must not exist yet
        if self.arena.get(first)?.next_sibling().is_some() {
            return None;
        }
        let uuid = self.add_node_with_role(
            parent_uuid, label, node_type, content, timestamp, ChildRole::Alternative,
        )?;
        if let Some(meta) = metadata {
            if let Some(&id) = self.node_index.get(&uuid) {
                if let Some(n) = self.arena.get_mut(id) {
                    n.get_mut().metadata = Some(meta);
                }
            }
        }
        Some(uuid)
    }

    // ── Commit index ──────────────────────────────────────────────────────────

    /// O(1) — register a git hash → node uuid mapping after inserting a commit node
    pub fn index_commit(&mut self, commit_hash: String, node_uuid: String) {
        self.commit_index.insert(commit_hash, node_uuid);
    }

    /// O(1) — look up which tree node corresponds to a git commit hash
    pub fn uuid_for_commit(&self, commit_hash: &str) -> Option<&str> {
        self.commit_index.get(commit_hash).map(|s| s.as_str())
    }

    // ── Reads — O(1) ─────────────────────────────────────────────────────────

    pub fn get_node(&self, node_id: NodeId) -> Option<&DecisionNode> {
        self.arena.get(node_id).map(|n| n.get())
    }

    pub fn get_by_uuid(&self, uuid: &str) -> Option<NodeId> {
        self.node_index.get(uuid).copied()
    }

    pub fn set_active_leaf(&mut self, uuid: &str) -> bool {
        if let Some(&id) = self.node_index.get(uuid) {
            self.active_leaf = id;
            true
        } else {
            false
        }
    }

    pub fn needs_pruning(&self) -> bool {
        self.total_tokens > self.token_budget
    }

    /// O(1)
    pub fn primary_child_uuid(&self, parent_uuid: &str) -> Option<String> {
        let parent_id = *self.node_index.get(parent_uuid)?;
        let child_id = self.arena.get(parent_id)?.first_child()?;
        self.arena.get(child_id).map(|n| n.get().uuid.clone())
    }

    /// O(1)
    pub fn alternative_child_uuid(&self, parent_uuid: &str) -> Option<String> {
        let parent_id = *self.node_index.get(parent_uuid)?;
        let first = self.arena.get(parent_id)?.first_child()?;
        let alt = self.arena.get(first)?.next_sibling()?;
        self.arena.get(alt).map(|n| n.get().uuid.clone())
    }

    // ── Pruning — O(1) ────────────────────────────────────────────────────────

    pub fn prune_node(&mut self, uuid: &str, summary: String) -> bool {
        if let Some(&id) = self.node_index.get(uuid) {
            if let Some(node) = self.arena.get_mut(id) {
                let n = node.get_mut();
                if !n.is_pruned {
                    let old = n.token_count;
                    let new_count = estimate_tokens(&summary);
                    n.summary = Some(summary);
                    n.is_pruned = true;
                    n.token_count = new_count;
                    self.total_tokens = self.total_tokens.saturating_sub(old) + new_count;
                }
                return true;
            }
        }
        false
    }

    // ── Path — O(depth) ───────────────────────────────────────────────────────

    pub fn active_path(&self) -> Vec<&DecisionNode> {
        let mut path = vec![];
        if let Some(node) = self.arena.get(self.active_leaf) {
            path.push(node.get());
        }
        for id in self.active_leaf.ancestors(&self.arena) {
            if let Some(node) = self.arena.get(id) {
                path.push(node.get());
            }
        }
        path.reverse();
        path
    }

    pub fn active_path_tokens(&self) -> usize {
        let mut id_opt = Some(self.active_leaf);
        let mut total = 0usize;
        while let Some(id) = id_opt {
            if let Some(node) = self.arena.get(id) {
                total += node.get().effective_tokens();
                id_opt = id.ancestors(&self.arena).next();
            } else {
                break;
            }
        }
        total
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    pub fn to_serializable(&self) -> SerializableTree {
        let nodes: Vec<SerializableNode> = self
            .node_index
            .values()
            .map(|&node_id| {
                let node = self.arena.get(node_id).unwrap().get();
                let parent_uuid = node_id
                    .ancestors(&self.arena)
                    .next()
                    .and_then(|p| self.arena.get(p))
                    .map(|p| p.get().uuid.clone());
                let children: Vec<String> = node_id
                    .children(&self.arena)
                    .filter_map(|c| self.arena.get(c))
                    .map(|c| c.get().uuid.clone())
                    .collect();
                SerializableNode { node: node.clone(), parent_uuid, children }
            })
            .collect();

        SerializableTree {
            nodes,
            root_uuid: self.arena.get(self.root).unwrap().get().uuid.clone(),
            active_leaf_uuid: self.arena.get(self.active_leaf).unwrap().get().uuid.clone(),
            commit_index: self.commit_index.clone(),
            total_tokens: self.total_tokens,
            token_budget: self.token_budget,
            counter: self.counter,
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    fn add_node_with_role(
        &mut self,
        parent_uuid: &str,
        label: String,
        node_type: NodeType,
        content: String,
        timestamp: u64,
        role: ChildRole,
    ) -> Option<String> {
        let parent_id = *self.node_index.get(parent_uuid)?;
        let parent_depth = self.arena.get(parent_id)?.get().depth;
        let uuid = format!("node-{}", self.counter);
        self.counter += 1;
        let node = DecisionNode::new(
            uuid.clone(), label, node_type, content, timestamp, parent_depth + 1, role,
        );
        let tokens = node.token_count;
        let child_id = self.arena.new_node(node);
        parent_id.append(child_id, &mut self.arena);
        self.node_index.insert(uuid.clone(), child_id);
        self.total_tokens += tokens;
        self.active_leaf = child_id;
        Some(uuid)
    }
}

// ── Serialization types ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct SerializableNode {
    pub node: DecisionNode,
    pub parent_uuid: Option<String>,
    pub children: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SerializableTree {
    pub nodes: Vec<SerializableNode>,
    pub root_uuid: String,
    pub active_leaf_uuid: String,
    pub commit_index: HashMap<String, String>,
    pub total_tokens: usize,
    pub token_budget: usize,
    pub counter: u64,
}

impl SerializableTree {
    pub fn into_context_tree(mut self) -> Option<ContextTree> {
        let mut arena: Arena<DecisionNode> = Arena::new();
        let mut node_index: HashMap<String, NodeId> = HashMap::new();

        self.nodes.sort_by_key(|n| n.node.depth);

        for sn in &self.nodes {
            let id = arena.new_node(sn.node.clone());
            node_index.insert(sn.node.uuid.clone(), id);
        }
        for sn in &self.nodes {
            if let Some(parent_uuid) = &sn.parent_uuid {
                let child_id = *node_index.get(&sn.node.uuid)?;
                let parent_id = *node_index.get(parent_uuid)?;
                parent_id.append(child_id, &mut arena);
            }
        }

        let root = *node_index.get(&self.root_uuid)?;
        let active_leaf = *node_index.get(&self.active_leaf_uuid)?;

        Some(ContextTree {
            arena,
            root,
            active_leaf,
            node_index,
            commit_index: self.commit_index,
            total_tokens: self.total_tokens,
            token_budget: self.token_budget,
            counter: self.counter,
        })
    }
}
