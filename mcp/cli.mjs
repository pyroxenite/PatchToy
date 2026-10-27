#!/usr/bin/env node
/**
 * PatchToy MCP tools from the command line (no MCP client needed).
 * Runs the same tool handlers as mcp/server.mjs against an auto-launched
 * headless PatchToy and writes returned images to files.
 *
 *   node mcp/cli.mjs tools
 *   node mcp/cli.mjs help build_graph
 *   node mcp/cli.mjs create_project '{"name":"Demo","template":"basic"}'
 *   node mcp/cli.mjs --project demo build_graph @graph.json compile render_preview '{"width":512}' --out demo.png
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { project: null, out: null, live: false, url: null, headed: false, quiet: false, keepGoing: false };
const steps = [];
const VALUE_OPTS = new Set(['--project', '--out', '--url']);

function usage(code = 0) {
    process.stderr.write(`Usage: node mcp/cli.mjs [options] <tool> [json] [<tool> [json] ...]
       node mcp/cli.mjs tools | help <tool>

json: inline JSON object, @file.json, or - (stdin). Omit for {}.

Options:
  --project <name>  open this project before running the tools
  --out <path>      image output: a .png file (single image) or a directory (default: cwd)
  --url <url>       PatchToy URL (default $PATCHTOY_URL or http://localhost:5173, auto-started)
  --live            allow targeting your own browser tab (bridge on port 7878 if free)
  --headed          show the auto-launched browser window
  --keep-going      continue after a failing tool
  --quiet           suppress server logs on stderr
`);
    process.exit(code);
}

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    if (VALUE_OPTS.has(a)) {
        const v = argv[++i];
        if (v === undefined) usage(2);
        opts[a.slice(2)] = v;
        continue;
    }
    if (a === '--live') { opts.live = true; continue; }
    if (a === '--headed') { opts.headed = true; continue; }
    if (a === '--quiet') { opts.quiet = true; continue; }
    if (a === '--keep-going') { opts.keepGoing = true; continue; }
    if (a.startsWith('--')) { process.stderr.write(`Unknown option ${a}\n`); usage(2); }

    const step = { tool: a.replace(/-/g, '_'), raw: null };
    const next = argv[i + 1];
    if (next !== undefined && (next.startsWith('{') || next.startsWith('@') || next === '-')) {
        step.raw = next;
        i++;
    }
    steps.push(step);
}

if (opts.quiet) process.env.PATCHTOY_MCP_QUIET = '1';
if (opts.url) process.env.PATCHTOY_URL = opts.url;

const z = await import('zod');
const { PatchToySession } = await import('./lib/session.mjs');
const { createTools } = await import('./lib/tools.mjs');

function parseArgs(raw) {
    if (!raw) return {};
    let text = raw;
    if (raw === '-') text = fs.readFileSync(0, 'utf8');
    else if (raw.startsWith('@')) text = fs.readFileSync(path.resolve(raw.slice(1)), 'utf8');
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON arguments (${e.message}): ${text.slice(0, 200)}`);
    }
}

const session = new PatchToySession({
    bridgePort: opts.live ? 7878 : 0,
    clientMode: opts.live ? 'auto' : 'headless',
    headed: opts.headed,
});
const tools = createTools(session);
const byName = new Map(tools.map(t => [t.name, t]));

if (steps.length === 0) usage(2);

if (steps[0].tool === 'tools') {
    for (const t of tools) process.stdout.write(`${t.name.padEnd(24)} ${t.title}\n`);
    process.exit(0);
}
if (steps[0].tool === 'help') {
    const name = steps[1]?.tool;
    const t = byName.get(name);
    if (!t) { process.stderr.write(`Unknown tool ${name}\n`); process.exit(2); }
    const schema = z.toJSONSchema(z.object(t.inputSchema));
    process.stdout.write(`${t.name} - ${t.title}\n\n${t.description}\n\nParameters:\n${JSON.stringify(schema.properties || {}, null, 2)}\n`);
    process.exit(0);
}

for (const step of steps) {
    if (!byName.has(step.tool)) {
        process.stderr.write(`Unknown tool "${step.tool}". Run: node mcp/cli.mjs tools\n`);
        process.exit(2);
    }
}

let exitCode = 0;
let imageCount = 0;
const totalImagesHint = steps.filter(s => ['render_preview', 'screenshot_editor'].includes(s.tool)).length;

function imagePath(tool) {
    imageCount++;
    const out = opts.out;
    if (out && out.toLowerCase().endsWith('.png')) {
        if (totalImagesHint <= 1 && imageCount === 1) return path.resolve(out);
        const base = out.slice(0, -4);
        return path.resolve(`${base}-${imageCount}.png`);
    }
    const dir = path.resolve(out || '.');
    return path.join(dir, `${tool}-${Date.now()}-${imageCount}.png`);
}

try {
    await session.start();
    if (opts.project) {
        const res = await byName.get('open_project').handler({ name: opts.project });
        process.stderr.write(`[cli] opened project ${res.data.opened}\n`);
    }
    for (const step of steps) {
        const tool = byName.get(step.tool);
        try {
            const args = z.object(tool.inputSchema).parse(parseArgs(step.raw));
            const { data, images = [] } = await tool.handler(args);
            for (const img of images) {
                let file = img.saved;
                if (!file) {
                    file = imagePath(step.tool);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, Buffer.from(img.base64, 'base64'));
                }
                data.image_file = file;
            }
            if (steps.length > 1) process.stdout.write(`// ${step.tool}\n`);
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } catch (err) {
            exitCode = 1;
            const payload = { error: err?.issues ? 'Invalid arguments' : err.message };
            if (err?.issues) payload.issues = err.issues;
            if (err?.data && typeof err.data === 'object') Object.assign(payload, err.data);
            if (steps.length > 1) process.stdout.write(`// ${step.tool} FAILED\n`);
            process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
            if (!opts.keepGoing) break;
        }
    }
} catch (err) {
    exitCode = 1;
    process.stderr.write(`[cli] ${err.stack || err.message}\n`);
} finally {
    await session.shutdown();
}
process.exit(exitCode);
