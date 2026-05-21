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
  experiments: {
    asyncWebAssembly: true, // Native WASM support in bundle
  },
  externals: {
    vscode: 'commonjs vscode', // Do not bundle VS Code core modules
  },
};
