import esbuild from 'esbuild';
import * as pkg from '../package.json';

// Q6: the MCP server advertises its version to clients; inject the real one
// at build time so /mcp listings and logs stop reporting a hardcoded 1.0.0.
const versionDefine = { __EASYEDA_MCP_VERSION__: JSON.stringify(pkg.version) };

// Extension build: IIFE for EDA Pro browser environment
const extensionConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/extension/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/',
	platform: 'browser',
	format: 'iife',
	globalName: 'edaEsbuildExportName',
	treeShaking: true,
	ignoreAnnotations: true,
};

// MCP Server build: CJS for Node.js
const mcpServerConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/mcp-server/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/mcp-server/',
	platform: 'node',
	format: 'cjs',
	treeShaking: true,
	external: [],
	define: versionDefine,
};

// Bridge daemon: CJS for Node.js. Shipped as a sibling of dist/mcp-server so
// spawn.ts can resolve it via __dirname/../bridge-daemon/index.js.
const bridgeDaemonConfig: esbuild.BuildOptions = {
	entryPoints: { 'index': './src/bridge-daemon/index' },
	entryNames: '[name]',
	bundle: true,
	minify: false,
	outdir: './dist/bridge-daemon/',
	platform: 'node',
	format: 'cjs',
	treeShaking: true,
	external: [],
};

(async () => {
	// Build extension
	await esbuild.build(extensionConfig);
	console.log('[esbuild] Extension built');

	// Build MCP server
	await esbuild.build(mcpServerConfig);
	console.log('[esbuild] MCP Server built');

	// Build bridge daemon
	await esbuild.build(bridgeDaemonConfig);
	console.log('[esbuild] Bridge daemon built');
})();
