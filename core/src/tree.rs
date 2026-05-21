use serde::{Deserialize, Serialize};
use indextree::{Arena, NodeId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NodeType {
    AgentDecision,
    FileChange,
    UserPrompt,
    PrunedCheckpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionNode {
    pub label: String,
    pub node_type: NodeType,
    pub content: String,
    pub token_count: usize,
    pub timestamp: u64,
}

pub struct ContextTree {
    pub arena: Arena<DecisionNode>,
    pub root: NodeId,
    pub active_leaf: NodeId,
}

impl ContextTree {
    pub fn new(root_node: DecisionNode) -> Self {
        let mut arena = Arena::new();
        let root = arena.new_node(root_node);
        ContextTree {
            arena,
            root,
            active_leaf: root,
        }
    }

    pub fn insert_child(&mut self, parent_id: NodeId, child_node: DecisionNode) -> NodeId {
        let child_id = self.arena.new_node(child_node);
        parent_id.append(child_id, &mut self.arena);
        child_id
    }
}
