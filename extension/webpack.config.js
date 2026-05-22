const path = require('path');

module.exports = {
  entry: './src/extension.ts',
  target: 'node', // Important for VS Code environment
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs',
  },
  resolve: {
    extensions: ['.ts', '.js', '.wasm'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
  externals: {
    vscode: 'commonjs vscode', // Do not bundle VS Code core modules
  },
  // Preserve real __dirname so the WASM readFileSync resolves to dist/
  node: {
    __dirname: false,
    __filename: false,
  },
};
