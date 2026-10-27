#!/usr/bin/env node
/**
 * PatchToy MCP server (stdio).
 *
 * Lets an AI agent create, edit, compile and render PatchToy projects by
 * driving a running instance of the app over a local WebSocket bridge.
 * See mcp/README.md.
 *
 * Environment:
 *   PATCHTOY_URL           app URL (default http://localhost:5173; Vite is auto-started if unreachable)
 *   PATCHTOY_BRIDGE_PORT   WebSocket bridge port (default 7878; 0 = random)
 *   PATCHTOY_CLIENT_MODE   auto | live | headless (default auto)
 *   PATCHTOY_CHROME_PATH   Chrome/Chromium executable (default: system Chrome)
 *   PATCHTOY_PROJECTS_DIR  projects directory (default <repo>/projects)
 *   PATCHTOY_HEADED=1      show the auto-launched browser window
 *   PATCHTOY_AGENT_NAME    name shown in the app's activity messages (default Claude)
 *   PATCHTOY_ALLOWED_ORIGINS  extra page origins the bridge accepts (exact; see README "Security")
 *   PATCHTOY_SAVE_DIRS     extra folders save_path may write to (default: repo, temp folder)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PatchToySession } from './lib/session.mjs';
import { createTools, SERVER_INSTRUCTIONS } from './lib/tools.mjs';
import { log, warn } from './lib/log.mjs';

function errorPayload(err) {
    const out = { error: err?.message || String(err) };
    if (err && err.data && typeof err.data === 'object') Object.assign(out, err.data);
    if (err?.appStack) out.app_stack = err.appStack;
    return out;
}

async function main() {
    const session = new PatchToySession();
    await session.start();

    const server = new McpServer(
        { name: 'patchtoy', version: '1.0.0' },
        { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } }
    );

    for (const tool of createTools(session)) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
            },
            async (args) => {
                const started = Date.now();
                try {
                    const { data, images = [] } = await tool.handler(args || {});
                    const content = [];
                    for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
                    content.push({ type: 'text', text: JSON.stringify(data) });
                    log(`${tool.name} ok (${Date.now() - started}ms)`);
                    return { content };
                } catch (err) {
                    warn(`${tool.name} failed: ${err?.message}`);
                    return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(err)) }] };
                }
            }
        );
    }

    const transport = new StdioServerTransport();
    let shuttingDown = false;
    const shutdown = async (why, code = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        (code ? warn : log)(`shutting down (${why})`);
        const force = setTimeout(() => process.exit(code), 5000);
        force.unref?.();
        try { await session.shutdown(); } catch (e) { warn('shutdown failed', e); }
        process.exit(code);
    };
    transport.onclose = () => shutdown('transport closed');
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // An exception nobody caught leaves the session (bridge, queue, headless browser) in an
    // unknown state: log it with its stack and exit (the MCP client restarts the server), after
    // closing the headless browser, Vite child and pairing file. A stray rejected promise is
    // logged with its stack but doesn't stop the tool calls in flight.
    const describe = (e) => (e instanceof Error ? (e.stack || `${e.name}: ${e.message}`) : (() => { try { return JSON.stringify(e); } catch { return String(e); } })());
    process.on('uncaughtException', (e, origin) => {
        warn(`uncaught exception (${origin || 'uncaughtException'}): ${describe(e)}`);
        shutdown('uncaught exception', 1);
    });
    process.on('unhandledRejection', (e) => warn(`unhandled promise rejection: ${describe(e)}`));

    await server.connect(transport);
    log(`ready (app ${session.appUrl}, bridge port ${session.bridge.port}, projects ${session.store.dir})`);
}

main().catch((err) => {
    warn('fatal', err);
    process.exit(1);
});
