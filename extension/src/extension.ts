import * as vscode from 'vscode';

// We import the compiled Rust module asynchronously 
let wasmEngine: typeof import('./wasm/analyzer_core') | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Context Analyzer Tree Extension is active!');

    // Initialize the WASM binary asynchronously
    try {
        wasmEngine = await import('./wasm/analyzer_core');
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load Rust engine: ${err}`);
    }

    let initCommand = vscode.commands.registerCommand('analyzer-tree.initialize', () => {
        if (!wasmEngine) {
            vscode.window.showErrorMessage('Rust Core Engine is not yet loaded.');
            return;
        }

        // Instantiate the analyzer bridge from Rust
        const bridge = new wasmEngine.AnalyzerBridge();
        
        const initResult = bridge.initialize_tree(
            "Root Decision Node", 
            "Initial workspace scan metadata: src/main.rs exists."
        );

        vscode.window.showInformationMessage(`Rust Core Output: ${initResult}`);
        console.log("Active state content:", bridge.get_active_leaf_content());
    });

    context.subscriptions.push(initCommand);
}

export function deactivate() {}
