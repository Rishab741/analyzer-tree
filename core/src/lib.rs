mod tree;

use wasm_bindgen::prelude::*;
use tree::{ContextTree, DecisionNode, NodeType};

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

    #[wasm_bindgen]
    pub fn initialize_tree(&mut self, root_label: &str, content: &str) -> String {
        let root_node = DecisionNode {
            label: root_label.to_string(),
            node_type: NodeType::UserPrompt,
            content: content.to_string(),
            token_count: content.len() / 4,
            timestamp: 123456789,
        };

        let tree = ContextTree::new(root_node);
        self.tree = Some(tree);
        "Tree initialized successfully".to_string()
    }

    #[wasm_bindgen]
    pub fn get_active_leaf_content(&self) -> String {
        match &self.tree {
            Some(t) => {
                let node = t.arena.get(t.active_leaf).unwrap().get();
                node.content.clone()
            }
            None => "No active tree initialized".to_string(),
        }
    }
}
