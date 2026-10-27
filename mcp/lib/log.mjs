// All logging goes to stderr: stdout is the MCP JSON-RPC channel.
const quiet = process.env.PATCHTOY_MCP_QUIET === '1';

export function log(...args) {
    if (quiet) return;
    process.stderr.write(`[patchtoy-mcp] ${args.map(a => (typeof a === 'string' ? a : safe(a))).join(' ')}\n`);
}

export function warn(...args) {
    process.stderr.write(`[patchtoy-mcp] WARN ${args.map(a => (typeof a === 'string' ? a : safe(a))).join(' ')}\n`);
}

function safe(v) {
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
}
