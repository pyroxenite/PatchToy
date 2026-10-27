/**
 * Tool definitions shared by the MCP server (server.mjs) and the CLI (cli.mjs).
 *
 * Each tool: { name, title, description, inputSchema (zod raw shape),
 *              annotations, handler(args) -> { data, images? } }
 * images: [{ base64, mimeType, saved? }]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { ToolError, displayPath } from './session.mjs';
import { slugify, ProjectError } from './projects.mjs';
import { confinedFilePath, sanitizeFilename, writeFileNoFollow, UnsafePathError } from './auth.mjs';
import { addMidiTools } from './midiTools.mjs';
import { addIOTools } from './ioTools.mjs';
import { addRender3DTools } from './render3dTools.mjs';

const nodeId = z.union([z.number().int(), z.string()]).describe('Node id (integer, as shown by get_project)');
const portRef = z.union([z.string(), z.number().int()]);
const projectName = z.string().optional().describe('Project name or slug. Defaults to the active project.');

const PORT_HELP = "Ports are referenced by name (e.g. 'uv', 'x', 'color') or 0-based index; 'out' works for unnamed outputs of custom nodes.";
const ACCESSOR_HELP = "accessor applies a swizzle or struct member to the source value: '.x', '.xy', '.rgb', '.zyx', '.position', '.position.xy'. On generic outputs (Mix, Add, Blend, ForLoop...) it is checked against the type resolved from the node's connected inputs, as the compiler does.";

const BASIC_TEMPLATE = {
    nodes: [
        { key: 'uv', type: 'UV' },
        { key: 'time', type: 'Time' },
        { key: 'sin', type: 'Sin' },
        { key: 'wave', type: 'Map', data: { inMin: -1, inMax: 1, outMin: 0, outMax: 1 } },
        { key: 'color', type: 'Vec3', data: { useUniform: false } },
        { key: 'preview', type: 'Preview' },
    ],
    connections: [
        { from: 'uv.uv.x', to: 'color.x' },
        { from: 'uv.uv.y', to: 'color.y' },
        { from: 'time.time', to: 'sin.x' },
        { from: 'sin.result', to: 'wave.value' },
        { from: 'wave.result', to: 'color.z' },
        { from: 'color.out', to: 'preview.color' },
    ],
};
const FALLBACK_TEMPLATE = {
    nodes: [{ key: 'uv', type: 'UV' }, { key: 'preview', type: 'Preview' }],
    connections: [{ from: 'uv', to: 'preview' }],
};

/**
 * Folders tool-supplied save paths may write to: the repo (relative paths resolve from
 * its root), the temp folder, and PATCHTOY_SAVE_DIRS (comma-separated). Hidden folders
 * (.git, ...) and node_modules are refused, and the extension is forced to the file type.
 */
function outputRoots(session) {
    const extra = (process.env.PATCHTOY_SAVE_DIRS || '').split(',').map(x => x.trim()).filter(Boolean);
    const roots = [session.repoRoot, os.tmpdir(), ...extra];
    if (process.platform !== 'win32' && fs.existsSync('/tmp')) roots.push('/tmp');
    return roots;
}

function safeOutputPath(session, savePath, ext) {
    try {
        return confinedFilePath(outputRoots(session), savePath, { ext, fallback: 'patchtoy' });
    } catch (e) {
        if (e instanceof UnsafePathError) throw new ToolError(`save_path rejected: ${e.message}`, { allowed_folders: outputRoots(session).map(displayPath), hint: 'Use a path inside the repo (e.g. exports/name.png), the temp folder, or a folder listed in PATCHTOY_SAVE_DIRS.' });
        throw e;
    }
}

function saveImage(session, base64, savePath) {
    if (!savePath) return null;
    const abs = safeOutputPath(session, savePath, 'png');
    writeFileNoFollow(abs, Buffer.from(base64, 'base64'));
    return abs;
}

// Local audio files set_audio may read and send to the page
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm', 'weba', 'aif', 'aiff', 'mp4']);
// Container extensions an export may have
const EXPORT_EXTS = new Set(['webm', 'mp4', 'zip', 'mkv', 'mov']);

function wrapProjectError(e) {
    if (e instanceof ProjectError) return new ToolError(e.message, e.data);
    return e;
}

export function createTools(session) {
    const s = session;
    const call = (client, method, params, timeout) => s.call(client, method, params, timeout);

    const tools = [
        // ------------------------------------------------------------------
        {
            name: 'get_status',
            title: 'PatchToy status',
            description: 'Show the bridge state: connected browser tabs with their origin and role (live = the user\'s own browser, headless = auto-launched, automation = a page driven by a test or another agent, or served by a private test dev server: never picked automatically), which one tools target, the registered dev servers, the active project and the app URL. Use it to debug connectivity or to check whether the user is watching live.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
            handler: async () => ({ data: s.status() }),
        },
        {
            name: 'select_client',
            title: 'Choose target browser',
            description: "Choose which connected PatchToy page tools operate on. mode 'auto' (default) prefers the user's visible browser tab (live mode) and falls back to an auto-launched headless browser; 'headless' never touches the user's tab; 'live' requires the user's tab. client_id targets one specific tab (see get_status).",
            inputSchema: {
                mode: z.enum(['auto', 'live', 'headless']).optional(),
                client_id: z.string().optional(),
            },
            handler: async ({ mode, client_id }) => {
                if (client_id) {
                    const c = s.bridge.pickClient(null, client_id);
                    if (!c) throw new ToolError(`No connected client "${client_id}"`, { clients: s.bridge.readyClients().map(x => x.id) });
                    s.selectedClientId = client_id;
                } else {
                    s.selectedClientId = null;
                    s.clientMode = mode || 'auto';
                    if (s.clientMode !== 'headless' && s.setLivePairing) s.setLivePairing(true);
                }
                return { data: s.status() };
            },
        },

        // ------------------------------------------------------------------ projects
        {
            name: 'list_projects',
            title: 'List projects',
            description: 'List PatchToy projects saved in the repo\'s projects/ directory (<slug>.patchtoy.json, same format as the app\'s "Download project" file). Marks the active project.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
            handler: async () => {
                const list = await s.store.list();
                return { data: { active: s.activeSlug, projects: list.map(p => ({ ...p, active: p.slug === s.activeSlug || undefined })) } };
            },
        },
        {
            name: 'create_project',
            title: 'Create project',
            description: "Create a new project file in projects/, make it the active project and open it in the app. template 'empty' (default) starts blank; 'basic' adds UV + Time -> Vec3 color -> Preview as a starting point. Every later edit is auto-saved to the file.",
            inputSchema: {
                name: z.string().min(1).describe('Human-readable project name (the file slug is derived from it)'),
                description: z.string().optional(),
                template: z.enum(['empty', 'basic']).optional(),
            },
            // Atomic: the browser is reached before anything is written, and a failure after the
            // file exists removes it again and restores the previous active project.
            handler: async ({ name, description = '', template = 'empty' }) => s.exclusive(async () => {
                const client = await s.getClient();
                let created;
                try { created = await s.store.create(name, description); } catch (e) { throw wrapProjectError(e); }
                const { slug } = created;
                const previousActive = s.activeSlug;
                s.setActive(slug);
                let load;
                let templateUsed = template;
                let build = null;
                try {
                    load = await s.ensureLoaded(client, slug);
                    if (template === 'basic') {
                        try {
                            build = await call(client, 'buildGraph', { ...BASIC_TEMPLATE, clear: true });
                            if (build.errors && build.errors.length) throw new Error(build.errors.join('; '));
                        } catch (e) {
                            build = await call(client, 'buildGraph', { ...FALLBACK_TEMPLATE, clear: true });
                            templateUsed = 'basic (fallback: UV -> Preview)';
                        }
                    }
                    await s.saveFromClient(client, slug);
                } catch (err) {
                    s._detach(client, 'project creation failed'); // the page may hold a half-loaded copy
                    try { await s.store.delete(slug); } catch { /* already gone */ }
                    s.setActive(previousActive && s.store.exists(previousActive) ? previousActive : null);
                    throw err;
                }
                const data = {
                    created: slug,
                    name,
                    file: displayPath(s.store.file(slug)),
                    template: templateUsed,
                    target: client.headless ? 'headless' : 'live',
                };
                if (build) { data.ids = build.ids; data.compile = build.compile; }
                if (load.backup_file) data.backup_of_previous_browser_graph = load.backup_file;
                return { data };
            }),
        },
        {
            name: 'open_project',
            title: 'Open project',
            description: 'Make a saved project the active one and load it into the app (through the app\'s own project-loading path, so its custom GLSL nodes are registered). In live mode the user\'s tab switches to it (their previous unsaved graph is backed up to projects/.backups/).',
            inputSchema: { name: z.string().min(1).describe('Project name or slug') },
            handler: async ({ name }) => s.exclusive(async () => {
                const slug = await s.resolveProject(name);
                s.setActive(slug);
                const client = await s.getClient();
                const load = await s.ensureLoaded(client, slug);
                const graph = await call(client, 'getGraph', {});
                const meta = await s.store.read(slug);
                const data = {
                    opened: slug,
                    name: meta.name,
                    description: meta.description || undefined,
                    nodes: graph.node_count,
                    connections: graph.connections.length,
                    previews: graph.previews,
                    target: client.headless ? 'headless' : 'live',
                };
                if (load.warnings) data.warnings = load.warnings;
                if (load.backup_file) data.backup_of_previous_browser_graph = load.backup_file;
                return { data };
            }),
        },
        {
            name: 'get_project',
            title: 'Describe project graph',
            description: 'Describe the project\'s graph concisely. nodes[]: {id, type, x, y, w, h, data, inputs: ["name:type <- fromId.output.accessor"], outputs: ["name:type"]}; connections[]: "fromId.output[.accessor] -> toId.input". Output types of polymorphic nodes show the resolved type after the last compile. Signal rates: each node has rate (pixel | control | free), port_rates, and control: {values, ...} for nodes evaluated once per frame in JS (LFO, Lag, Counter, math on Params...); control_rate summarizes them (compile_count included). When the project has node groups: each grouped node has group (its innermost group id), groups[] lists {id, name, parent, nodes, children, node_count, inputs, outputs} and root_nodes the ungrouped node ids. If name is given and differs from the active project, that project is opened.',
            inputSchema: { name: projectName },
            annotations: { readOnlyHint: true },
            handler: async ({ name }) => s.withProject(name, async (client, slug) => {
                const graph = await call(client, 'getGraph', {});
                const meta = await s.store.read(slug);
                return { data: { ...graph, project: { slug, name: meta.name, description: meta.description || undefined, file: displayPath(s.store.file(slug)) } } };
            }),
        },
        {
            name: 'delete_project',
            title: 'Delete project',
            description: 'Delete a project file from projects/. If it was active, there is no active project afterwards.',
            inputSchema: { name: z.string().min(1) },
            annotations: { destructiveHint: true },
            handler: async ({ name }) => s.exclusive(async () => {
                const slug = await s.resolveProject(name);
                await s.store.delete(slug);
                if (s.activeSlug === slug) s.setActive(null);
                for (const c of s.bridge.readyClients()) {
                    if (c.loaded?.slug === slug) {
                        c.loaded = null;
                        try { await c.call('detachProject', {}); } catch { /* ignore */ }
                    }
                }
                return { data: { deleted: slug } };
            }),
        },
        {
            name: 'duplicate_project',
            title: 'Duplicate project',
            description: 'Copy a project to a new name (the copy is not opened; use open_project).',
            inputSchema: { name: z.string().min(1), new_name: z.string().min(1) },
            handler: async ({ name, new_name }) => s.exclusive(async () => {
                const slug = await s.resolveProject(name);
                const newSlug = slugify(new_name);
                if (s.store.exists(newSlug)) throw new ToolError(`A project with slug "${newSlug}" already exists`);
                const data = await s.store.read(slug);
                await s.store.write(newSlug, { ...data, name: new_name, timestamp: new Date().toISOString() });
                return { data: { created: newSlug, from: slug, file: displayPath(s.store.file(newSlug)) } };
            }),
        },
        {
            name: 'rename_project',
            title: 'Rename project',
            description: 'Rename a project (changes its name and file slug). Keeps it active if it was.',
            inputSchema: { name: z.string().min(1), new_name: z.string().min(1) },
            handler: async ({ name, new_name }) => s.exclusive(async () => {
                const slug = await s.resolveProject(name);
                const newSlug = slugify(new_name);
                if (newSlug !== slug && s.store.exists(newSlug)) throw new ToolError(`A project with slug "${newSlug}" already exists`);
                const data = await s.store.read(slug);
                await s.store.write(newSlug, { ...data, name: new_name });
                if (newSlug !== slug) await s.store.delete(slug);
                if (s.activeSlug === slug) s.setActive(newSlug);
                for (const c of s.bridge.readyClients()) {
                    if (c.loaded?.slug === slug) {
                        c.loaded = { ...c.loaded, slug: newSlug };
                        try { await c.call('setProjectMeta', { slug: newSlug, name: new_name }); } catch { /* ignore */ }
                    }
                }
                return { data: { renamed: slug, to: newSlug, name: new_name } };
            }),
        },

        // ------------------------------------------------------------------ node library
        {
            name: 'list_node_types',
            title: 'List node types',
            description: 'List the node types available in the running app (read live from the app, including custom GLSL nodes). Each entry: name, category, description, inputs ["name:type=default"], outputs ["name:type"], data (editable fields with defaults) and notes (dynamic inputs, polymorphic types, pairing, device requirements). Filter with category and/or search (substring over name/title/description/category). include_glsl adds the source of custom nodes.',
            inputSchema: {
                category: z.string().optional(),
                search: z.string().optional(),
                include_glsl: z.boolean().optional(),
            },
            annotations: { readOnlyHint: true },
            handler: async (args) => {
                const run = async (client) => ({ data: await call(client, 'listNodeTypes', args) });
                if (s.activeSlug && s.store.exists(s.activeSlug)) return s.withProject(null, run);
                return s.withClient(run);
            },
        },

        // ------------------------------------------------------------------ editing
        {
            name: 'add_node',
            title: 'Add node',
            description: 'Add one node to the active project. Without x/y it is placed to the right of the existing nodes. data sets initial values (same fields as set_node_data). Returns the node with its id and ports. ForLoopStart also creates its paired ForLoopEnd (returned as pair). For several nodes at once prefer build_graph.',
            inputSchema: {
                type: z.string().describe('Node type name from list_node_types, e.g. "UV", "Time", "Sin", "Preview" (case-insensitive)'),
                x: z.number().optional(),
                y: z.number().optional(),
                data: z.record(z.string(), z.any()).optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'addNode', args) }), { mutating: true }),
        },
        {
            name: 'remove_node',
            title: 'Remove node',
            description: 'Remove a node and its connections (a ForLoopStart/ForLoopEnd pair is removed together).',
            inputSchema: { id: nodeId },
            annotations: { destructiveHint: true },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'removeNode', args) }), { mutating: true }),
        },
        {
            name: 'set_node_data',
            title: 'Set node data',
            description: 'Merge values into a node\'s data and trigger the same recompile/uniform update the UI uses. Examples: Float {"value":2.5}; Vec3 {"x":1,"y":0.2,"z":0}; constants {"useUniform":false} to inline the literal (switching to true disconnects inputs, like the [U] button); Color {"r":1,"g":0.5,"b":0} or {"hex":"#ff8800"}; UV {"mode":"stretch"|"contain"|"cover"}; Map {"inMin":-1,"inMax":1,"outMin":0,"outMax":1,"clip":true}. Library nodes also take a value for any unconnected input, keyed by the input name: a number, an array of 2-4 numbers, a GLSL literal like "vec3(1.0, 0.5, 0.0)" or true/false for bool inputs (e.g. Add {"a":0.5}, ColorRamp {"c0":[1,0,0]}, RotateUV {"center":[0.5,0.5]}); null restores the default. Uniform-mode constants and live sources (XYPad, Keyboard...) only update the uniform (recompiled:false). Unknown fields and invalid values are rejected with the list of valid fields.',
            inputSchema: { id: nodeId, data: z.record(z.string(), z.any()) },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'setNodeData', args) }), { mutating: true }),
        },
        {
            name: 'move_node',
            title: 'Move node',
            description: 'Move a node to canvas coordinates x, y (top-left corner, graph space). Use auto_layout to arrange everything.',
            inputSchema: { id: nodeId, x: z.number(), y: z.number() },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'moveNode', args) }), { mutating: true }),
        },
        {
            name: 'connect',
            title: 'Connect ports',
            description: `Connect an output to an input (replacing any existing connection into that input), using the app's own connection logic: struct types must match exactly, primitives auto-convert, cycles are rejected (use Feedback for temporal loops, a Delay node for control-rate loops), pixel values cannot drive control-rate inputs (LFO, Counter, SceneSwitcher.scene... - use a Sample node), event / string / list outputs cannot reach shader inputs, dynamic nodes grow inputs (Blend '0','1','2'...). ${PORT_HELP} from_output defaults to the first output; to_input may be omitted when the node has a single input. ${ACCESSOR_HELP} Errors list the valid ports. Warnings report type problems the compiler will hit.`,
            inputSchema: {
                from_node: nodeId,
                from_output: portRef.optional(),
                to_node: nodeId,
                to_input: portRef.optional(),
                accessor: z.string().optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'connect', args) }), { mutating: true }),
        },
        {
            name: 'disconnect',
            title: 'Disconnect',
            description: 'Remove connections: into to_node (only to_input if given), or out of from_node (only from_output if given).',
            inputSchema: {
                to_node: nodeId.optional(),
                to_input: portRef.optional(),
                from_node: nodeId.optional(),
                from_output: portRef.optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'disconnect', args) }), { mutating: true }),
        },
        {
            name: 'create_custom_node',
            title: 'Create custom GLSL node',
            description: 'Turn a GLSL function into a reusable node type (via the app\'s createCustomNode). Parameters become inputs, the return value the output (named "out"). The code is compiled first and rejected with line-numbered errors if invalid (force=true skips the check). Optional magic comments: /* @node mainFn  @title Pretty Name  @category noise  @input uv "UV"  @description ... */ - @node is required when the code has several functions. The standard uniforms u_time, u_resolution, u_mouse may be used. The node is saved with the project. Example: "float stripes(vec2 uv, float freq) { return 0.5 + 0.5 * sin(uv.x * freq); }"',
            inputSchema: {
                name: z.string().min(1).describe('Node type name, e.g. "Stripes"'),
                glsl: z.string().min(1),
                force: z.boolean().optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'createCustomNode', { ...args, mode: 'create' }) }), { mutating: true }),
        },
        {
            name: 'update_custom_node',
            title: 'Update custom GLSL node',
            description: 'Replace the GLSL of an existing custom node; all instances are refreshed (connections to removed ports are dropped).',
            inputSchema: { name: z.string().min(1), glsl: z.string().min(1), force: z.boolean().optional() },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'createCustomNode', { ...args, mode: 'update' }) }), { mutating: true }),
        },
        {
            name: 'build_graph',
            title: 'Build graph (batch)',
            description: `Create many nodes and connections in one call, then compile. nodes: [{key, type, x?, y?, data?}] - key is your local name. connections: [{from: "key.output", to: "key.input", accessor?}] - the output may carry an accessor suffix ("uv.uv.x" = output uv of node uv, swizzled .x); a bare "key" means the default port; existing node ids can be used instead of keys. A ForLoopStart with key "loop" also defines "loop_end" (its ForLoopEnd). data takes the same fields as set_node_data (including inline values for unconnected inputs). Node types are validated before anything is created; node-data and connection problems are reported per item without aborting (top-level ok is then false and error summarizes them). Swizzles on generic outputs (Mix, Add, Blend...) are checked against the type resolved from their inputs, whatever the order of the connections. Without coordinates the result is auto-laid out. clear=true replaces the current graph. groups (optional) organizes the result into node groups (view-only, compilation is unaffected): [{key, name, nodes: [node keys, node ids, group keys or group ids], parent?: group key/id, color?}] - nesting via a group key in nodes or via parent; group_ids maps keys to ids. Returns {ok, error?, ids: {key: id}, group_ids?, errors?, warnings?, compile}. ${PORT_HELP} Example: {"nodes":[{"key":"uv","type":"UV"},{"key":"t","type":"Time"},{"key":"s","type":"Sin"},{"key":"c","type":"Vec3","data":{"useUniform":false}},{"key":"p","type":"Preview"}],"connections":[{"from":"uv.uv.x","to":"c.x"},{"from":"t","to":"s.x"},{"from":"s","to":"c.y"},{"from":"c","to":"p.color"}]}`,
            inputSchema: {
                nodes: z.array(z.object({
                    key: z.union([z.string(), z.number()]),
                    type: z.string(),
                    x: z.number().optional(),
                    y: z.number().optional(),
                    data: z.record(z.string(), z.any()).optional(),
                })),
                connections: z.array(z.object({
                    from: z.union([z.string(), z.number()]),
                    to: z.union([z.string(), z.number()]),
                    accessor: z.string().optional(),
                })).optional(),
                clear: z.boolean().optional().describe('Remove all existing nodes first'),
                layout: z.boolean().optional().describe('Force (true) or skip (false) auto layout; default: layout when no coordinates were given'),
                groups: z.array(z.object({
                    key: z.union([z.string(), z.number()]),
                    name: z.string().optional(),
                    nodes: z.array(z.union([z.string(), z.number()])).optional(),
                    parent: z.union([z.string(), z.number()]).optional(),
                    color: z.string().optional(),
                })).optional().describe('Node groups to create (see description)'),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'buildGraph', { connections: [], ...args }, 120000) }), { mutating: true }),
        },
        {
            name: 'auto_layout',
            title: 'Auto layout',
            description: 'Arrange nodes left-to-right by dependency depth (Preview/sinks on the right), ordering each column to reduce crossings, without overlaps; then fit the view. With node groups, every scope (the root and each group) is laid out on its own and group boxes are placed as nodes of their parent scope. Comment notes are placed in a row above their scope\'s nodes.',
            inputSchema: { name: projectName, fit_view: z.boolean().optional() },
            handler: async ({ name, fit_view }) => s.withProject(name, async (client) => ({ data: await call(client, 'autoLayout', { fit_view }) }), { mutating: true }),
        },
        {
            name: 'undo',
            title: 'Undo',
            description: "Undo the last step(s) of the app's undo history - the same history as the user's ⌘Z: the user's own edits and every mutating tool call (one step per call; build_graph is one step). Returns the undone step labels and what would be undone / redone next. Loading or creating a project clears the history. Use history to see the labels first; don't undo the user's work unless they asked.",
            inputSchema: { steps: z.number().int().min(1).max(100).optional().describe('How many steps (default 1)'), name: projectName },
            handler: async ({ steps, name }) => s.withProject(name, async (client) => ({ data: await call(client, 'undo', { steps }) }), { mutating: true }),
        },
        {
            name: 'redo',
            title: 'Redo',
            description: 'Redo step(s) undone with undo (or ⇧⌘Z in the app). A new edit after an undo drops the redo steps.',
            inputSchema: { steps: z.number().int().min(1).max(100).optional().describe('How many steps (default 1)'), name: projectName },
            handler: async ({ steps, name }) => s.withProject(name, async (client) => ({ data: await call(client, 'redo', { steps }) }), { mutating: true }),
        },
        {
            name: 'history',
            title: 'Undo history',
            description: 'List the undo history: undo[] and redo[] step labels, newest first (e.g. "Move 3 nodes", "Claude: Build graph", "Change Speed"), plus counts and memory use.',
            inputSchema: { limit: z.number().int().min(1).max(100).optional(), name: projectName },
            annotations: { readOnlyHint: true },
            handler: async ({ limit, name }) => s.withProject(name, async (client) => ({ data: await call(client, 'getHistory', { limit }) })),
        },
        {
            name: 'set_background_preview',
            title: 'Set background preview',
            description: 'Show a Preview node\'s shader full-screen behind the node editor (the app\'s "background" toggle). preview_id null clears it.',
            inputSchema: { preview_id: z.union([z.number().int(), z.string(), z.null()]) },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'setBackgroundPreview', args) }), { mutating: true }),
        },

        // ------------------------------------------------------------------ compile / render
        {
            name: 'compile',
            title: 'Compile',
            description: 'Compile the graph like the app does and report per Preview node: ok, compiler errors/warnings, WebGL GLSL errors (line, message, offending code line and the node that generated it when it can be mapped) and the uniforms used. Feedback nodes compile their input sub-graph as a separate pass: feedback[] reports {id, ok, errors, glsl_errors?} per Feedback node, and a failing pass makes ok false. include_source adds the full fragment shader(s). Also lists nodes the app marked red (error_nodes).',
            inputSchema: { name: projectName, include_source: z.boolean().optional() },
            annotations: { readOnlyHint: true },
            handler: async ({ name, include_source }) => s.withProject(name, async (client) => ({ data: await call(client, 'compile', { include_source }) })),
        },
        {
            name: 'render_preview',
            title: 'Render preview image',
            description: 'Render a Preview node\'s shader to a PNG at the requested size and time (u_time in seconds, default 1.0) and return it as an image. Defaults: the first Preview node, 512px wide at the preview\'s aspect ratio. node_id (+ output) renders any node\'s output instead (converted to vec4) - handy for inspecting intermediate values. mouse=[x,y] in 0..1 sets u_mouse. beat (beats, e.g. 4.5) or beat_phase (0..1, with optional integer beat) pins the beat clock: u_beat, u_beatPhase, u_barPhase, u_beatCount, u_beatTime, u_beatConfidence (= 1) and the audio values (u_kick, u_bass, ... from the metronome groove) are then deterministic; bpm defaults to the metronome tempo, and u_time follows the beat unless time is given. Also returns pixel stats (mean color, luma range, distinct colors; blank=true means a single flat color). save_path writes the PNG to disk (relative to the repo root).',
            inputSchema: {
                preview_id: nodeId.optional(),
                node_id: nodeId.optional(),
                output: portRef.optional(),
                width: z.number().int().min(8).max(2048).optional(),
                height: z.number().int().min(8).max(2048).optional(),
                time: z.number().optional(),
                beat: z.number().optional().describe('Beat position in beats (4.25 = a quarter past beat 4)'),
                beat_phase: z.number().min(0).max(1).optional().describe('Phase within the beat, 0..1 (0 = on the beat)'),
                bpm: z.number().min(20).max(400).optional().describe('Tempo for beat-based renders (default: metronome / current tempo)'),
                mouse: z.array(z.number()).length(2).optional(),
                save_path: z.string().optional(),
                name: projectName,
            },
            // Not read-only: it steps the live Feedback buffers (and, with warmup, resets the
            // Feedback / JS / control-rate simulation state of the page). The project file is untouched.
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
            handler: async ({ save_path, name, ...args }) => s.withProject(name, async (client) => {
                if (save_path) safeOutputPath(s, save_path, 'png'); // reject a bad path before rendering
                const res = await call(client, 'renderPreview', args, 120000 + (Number(args.warmup) > 0 ? Number(args.warmup) * 4000 : 0)); // warm-up frames: up to 4 s each (software GL)
                const { png, ...meta } = res;
                const saved = saveImage(s, png, save_path);
                if (saved) meta.saved = displayPath(saved);
                return { data: meta, images: [{ base64: png, mimeType: 'image/png', saved }] };
            }),
        },
        {
            name: 'screenshot_editor',
            title: 'Screenshot editor',
            description: 'PNG screenshot of the whole editor. Headless browser: a real page screenshot (UI included). User\'s live browser: a capture of the node canvas (DOM toolbars/dialogs not included). fit_view first zooms/pans so all nodes are visible. save_path writes the PNG to disk.',
            inputSchema: { fit_view: z.boolean().optional(), save_path: z.string().optional() },
            // Not read-only: fit_view pans / zooms the user's editor (the project is untouched)
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            handler: async ({ fit_view = false, save_path }) => s.exclusive(async () => {
                if (save_path) safeOutputPath(s, save_path, 'png');
                const client = await s.getClient();
                if (s.activeSlug && s.store.exists(s.activeSlug)) await s.ensureLoaded(client, s.activeSlug);
                let base64, meta;
                if (s.isHeadlessClient(client)) {
                    if (fit_view) await call(client, 'fitView', {});
                    const page = s.headlessPage.page;
                    // Let UI pollers (status bar, counters) catch up, then wait for a fresh frame
                    await page.waitForTimeout(350);
                    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
                    const buf = await page.screenshot({ type: 'png' });
                    base64 = buf.toString('base64');
                    meta = { source: 'headless page screenshot', viewport: page.viewportSize() };
                } else {
                    const res = await call(client, 'captureEditor', { fit_view });
                    base64 = res.png;
                    meta = { source: 'live browser canvas capture', width: res.width, height: res.height, note: res.note };
                }
                const saved = saveImage(s, base64, save_path);
                if (saved) meta.saved = displayPath(saved);
                return { data: meta, images: [{ base64, mimeType: 'image/png', saved }] };
            }),
        },
        // ------------------------------------------------------------------ audio / beat sync
        {
            name: 'set_audio',
            title: 'Set audio source',
            description: "Choose what drives the global audio / beat uniforms (u_level, u_bass, u_mid, u_high, u_kick, u_beat, u_beatPhase, u_barPhase, u_beatCount, u_bpm, u_beatTime, u_beatConfidence, u_beatTrust, u_beatRaw) and the Audio / Beat / BeatEnvelope nodes (the beat values come from a stable clock that coasts while the tracker is unsure and glides to a new tempo). mode 'metronome' = fixed bpm (default 120), no audio needed - kick/bass follow a virtual 4/4 groove; use it for headless renders. mode 'file' plays url_or_path (an http(s) URL, or a local audio file path that this server reads and sends to the page) and tracks its beat; 'off' stops analysis (the beat clock free-runs; bpm sets its tempo). offset_ms shifts visual beats (-200..200), locked freezes the detected tempo. Returns the audio status.",
            inputSchema: {
                mode: z.enum(['metronome', 'file', 'off']),
                bpm: z.number().min(20).max(400).optional(),
                url_or_path: z.string().optional().describe('Audio URL or local file path (relative paths resolve from the repo root)'),
                play: z.boolean().optional().describe('Start playback (file mode, default true)'),
                loop: z.boolean().optional(),
                offset_ms: z.number().min(-200).max(200).optional(),
                locked: z.boolean().optional(),
            },
            handler: async ({ mode, url_or_path, ...rest }) => s.withClient(async (client) => {
                const params = { mode, ...rest };
                if (mode === 'file' && url_or_path) {
                    if (/^(https?:|data:|blob:)/i.test(url_or_path)) {
                        params.url = url_or_path;
                    } else {
                        const abs = path.isAbsolute(url_or_path) ? url_or_path : path.resolve(s.repoRoot, url_or_path);
                        // Only audio files, never hidden files/folders (keys, configs): the bytes go to the page
                        const ext = path.extname(abs).slice(1).toLowerCase();
                        if (!AUDIO_EXTS.has(ext)) throw new ToolError(`Not an audio file: ${url_or_path} (allowed: ${[...AUDIO_EXTS].join(', ')})`);
                        if (abs.split(/[/\\]/).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) throw new ToolError(`Refusing to read a file in a hidden folder: ${url_or_path}`);
                        let stat;
                        try { stat = fs.statSync(abs); } catch { throw new ToolError(`Audio file not found: ${url_or_path}`); }
                        if (!stat.isFile()) throw new ToolError(`Not a file: ${url_or_path}`);
                        if (stat.size > 60 * 1024 * 1024) throw new ToolError('Audio file is larger than 60 MB; pass a URL instead');
                        params.data_base64 = fs.readFileSync(abs).toString('base64');
                        params.name = path.basename(abs);
                    }
                }
                return { data: await call(client, 'setAudio', params, 60000) };
            }),
        },
        {
            name: 'get_audio_status',
            title: 'Audio status',
            description: 'Current audio source, tempo (bpm, detected_bpm, confidence, locked), beat position (count, phase, bar_phase), band levels, A/V offset, latency and file transport (name, playing, position, duration).',
            inputSchema: {},
            annotations: { readOnlyHint: true },
            handler: async () => s.withClient(async (client) => ({ data: await call(client, 'getAudioStatus', {}) })),
        },

        // ------------------------------------------------------------------ node groups
        // Groups are view/organization metadata (graph.groups): the compiled graph stays flat.
        {
            name: 'group_nodes',
            title: 'Group nodes',
            description: 'Put nodes (and/or existing groups, for groups of groups) into a new node group. In the editor a group shows as one box whose ports are the cables crossing its boundary; double-click opens it. node_ids: node ids and/or group ids ("g3") or group names. parent_group (id or name) nests the new group; by default it goes where its members are (their common group, else the root). Members leave their previous group. Compilation is unaffected. Returns the group {id, name, parent, nodes, children, node_count, inputs, outputs}.',
            inputSchema: {
                name: z.string().min(1).describe('Group name, e.g. "Scene SDF"'),
                node_ids: z.array(z.union([z.number().int(), z.string()])).min(1),
                parent_group: z.union([z.string(), z.number()]).optional(),
                color: z.string().optional().describe('Optional accent: a category name (sdf3d, color, effect, uv, noise, math, ...) or "#rrggbb"'),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'groupNodes', args) }), { mutating: true }),
        },
        {
            name: 'ungroup',
            title: 'Ungroup',
            description: 'Dissolve a node group: its nodes and child groups move to its parent scope (placed where the group box was). Nothing is deleted.',
            inputSchema: { group_id: z.union([z.string(), z.number()]).describe('Group id ("g3") or name') },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'ungroup', args) }), { mutating: true }),
        },
        {
            name: 'rename_group',
            title: 'Rename group',
            description: 'Rename a node group.',
            inputSchema: { group_id: z.union([z.string(), z.number()]), name: z.string().min(1) },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'renameGroup', args) }), { mutating: true }),
        },
        {
            name: 'list_groups',
            title: 'List groups',
            description: 'List the node groups of the active project: [{id, name, parent, nodes (direct members), children (group ids), node_count (whole subtree), inputs/outputs (the box ports synthesized from boundary-crossing cables, plus exposed ports; custom names from rename_group_port), port_keys {inputs, outputs} (the stable key of each, same order), port_labels (custom names by key), x, y}] and root_nodes (ungrouped node ids).',
            inputSchema: { name: projectName },
            annotations: { readOnlyHint: true },
            handler: async ({ name }) => s.withProject(name, async (client) => ({ data: await call(client, 'listGroups', {}) })),
        },

        // ------------------------------------------------------------------ parameters (Param nodes)
        // Param nodes are UI parameters listed in the editor's Parameters panel; values are live uniforms.
        {
            name: 'list_params',
            title: 'List parameters',
            description: "List the Param nodes of the active project as the Parameters panel shows them: sections (data.section, 'General' when empty) in order, each with params [{id, label, kind, value, default, min, max, step, scale, options/selected (enum), alpha/hex (color), description, outputs, group}]. Create params with add_node / build_graph {type:'Param', data:{label, kind, value, min, max, section, ...}} (see list_node_types search 'Param').",
            inputSchema: { name: projectName },
            annotations: { readOnlyHint: true },
            handler: async ({ name }) => s.withProject(name, async (client) => ({ data: await call(client, 'listParams', {}) })),
        },
        {
            name: 'set_param',
            title: 'Set parameter',
            description: "Set a Param's value by node_id or label (case-insensitive). The value follows the kind: number (float/int), true/false (bool), [x, y(, z, w)] (vecN), \"#rrggbb\" or [r, g, b(, a)] in 0..1 (color), option index or option name (enum), an image URL or data URL (image); for a trigger, true / 'press' fires it (one-frame pulse, count + 1) and a number sets the count. Live uniform update: never recompiles. Errors list the params.",
            inputSchema: {
                node_id: nodeId.optional(),
                label: z.string().optional().describe('Param label as shown in the panel'),
                value: z.any(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'setParam', args) }), { mutating: true }),
        },
    ];

    // ------------------------------------------------------------------ scenes (SceneSwitcher)
    // Scene selection is CPU-side: these tools drive the switcher's runtime (live uniforms, no recompile).
    const sceneRef = z.union([z.number().int(), z.string()]);
    tools.push(
        {
            name: 'list_scenes',
            title: 'List scenes',
            description: "List the SceneSwitcher nodes of the active project: scenes [{index, name, connected, transition?, duration?}], current / current_name, the running transition {from, to, style, progress, eased}, evaluated (scene indices the shader runs right now: 1, or 2 during a transition), default transition / duration / easing / params, auto mode {mode, bars, seconds}, playlist, the ScenePresence nodes per scene and the Feedback passes owned by scenes (running = not skipped). Also lists every transition style with its description.",
            inputSchema: { name: projectName },
            annotations: { readOnlyHint: true },
            handler: async ({ name }) => s.withProject(name, async (client) => ({ data: await call(client, 'listScenes', {}) })),
        },
        {
            name: 'set_scene',
            title: 'Set scene',
            description: "Transition a SceneSwitcher to a scene: scene = index, name (case-insensitive) or 'next' / 'prev'. transition overrides the style for this switch (cut, crossfade, dissolve, wipe, iris, zoom, push, slide, luma, displace, pixelate, self, self-add, sequential, custom), duration overrides the length (seconds, or beats when data.durationUnit is 'beats'), instant = true cuts. node_id picks the switcher (default: the first). Live uniform update, never recompiles; returns the switcher state (see list_scenes).",
            inputSchema: {
                node_id: nodeId.optional(),
                scene: sceneRef,
                transition: z.string().optional(),
                duration: z.number().min(0).optional(),
                instant: z.boolean().optional(),
            },
            handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'setScene', args) }), { mutating: true }),
        },
    );
    // render_preview: pin a scene or a transition frame (deterministic checks)
    const renderTool = tools.find(t => t.name === 'render_preview');
    if (renderTool) {
        Object.assign(renderTool.inputSchema, {
            scene: sceneRef.optional().describe('SceneSwitcher: render this scene (index or name); with progress, the scene being entered'),
            scene_from: sceneRef.optional().describe('SceneSwitcher: the scene being left (with progress; default: the current scene)'),
            progress: z.number().min(0).max(1).optional().describe('SceneSwitcher: eased transition progress 0..1 (0 = scene_from, 1 = scene)'),
            transition: z.string().optional().describe('SceneSwitcher: transition style for a pinned transition frame'),
            scene_node: nodeId.optional().describe('SceneSwitcher to pin (default: the first)'),
        });
        renderTool.description += " SceneSwitcher: scene pins a scene, {scene_from, scene, progress (eased, 0..1), transition} pins a transition frame (scene_node picks the switcher).";
        // Deterministic warm-up (tests/visual): reset Feedback / JS / control state, step N fixed frames
        Object.assign(renderTool.inputSchema, {
            warmup: z.number().int().min(0).max(1200).optional().describe('Reset the simulation state (Feedback buffers cleared, JS node state + setup, control-rate state, Math.random seeded) and step this many frames at warmup_fps, ending at the render time: reproducible renders of Feedback simulations and JS nodes'),
            warmup_fps: z.number().min(1).max(240).optional().describe('Fixed frame rate of the warm-up steps (default 60)'),
            seed: z.number().int().optional().describe('Math.random seed during the warm-up (default 1)'),
            date: z.union([z.string(), z.number()]).optional().describe('With warmup: JS nodes see this wall-clock time (ISO string or epoch ms) in Date / Date.now(), advancing with the simulated frames'),
        });
        renderTool.description += ' warmup = N resets Feedback / JS / control-rate state and steps N frames at a fixed timestep (warmup_fps, default 60; Math.random seeded with seed) ending at the render time, so feedback simulations and JS nodes render deterministically.';
    }

    // ------------------------------------------------------------------ debug probes
    // ValueDisplay / ColorDisplay / Plot / XYScope / FrameStats / Histogram / LED nodes read GPU values back.
    tools.push({
        name: 'read_probes',
        title: 'Read debug probes',
        description: "Read the current values of the debug probe nodes (category 'debug': ValueDisplay, ColorDisplay, Plot, XYScope, FrameStats, Histogram, LED) of the active project, all of them or by ids. Each probe: {id, type, status ('ok' | 'none' = nothing connected | 'error' | 'pending'), value_type, value (number, bool or [x, y, z, w]; null components are NaN/Inf), text (formatted, 'NaN' / '+Inf' spelled out), nan, inf, sample {mode, uv}, format ('rgba32f', or 'rgba8' = clamped 0..1 without NaN/Inf detection), resolution (u_resolution the probe evaluates with), clock_time}. ColorDisplay adds hex / clipped / hdr; Plot and XYScope add range, window {min, max, mean} and history {t_rel (seconds before the newest sample), values} (max_points samples, beat_ticks when data.beats); FrameStats adds stats {grid, nan_samples, inf_samples, channels: {min, max, mean}} over a coarse 64-wide grid of the whole frame; Histogram adds histogram {counts, range}; LED adds on. Probes only render while visible in the editor or for ~15 s after a read: wait_ms keeps them sampling for that long before answering (use it to collect Plot history). Also reports the readback cost (renderer).",
        inputSchema: {
            ids: z.array(nodeId).optional().describe('Probe node ids (default: every probe)'),
            history: z.boolean().optional().describe('Include Plot / XY Scope history (default true)'),
            max_points: z.number().int().min(2).max(2000).optional().describe('Max history samples per probe (default 120, evenly decimated)'),
            wait_ms: z.number().int().min(0).max(10000).optional().describe('Keep the probes sampling this long before reading (e.g. 1500 for a Plot of an off-screen probe)'),
            name: projectName,
        },
        annotations: { readOnlyHint: true },
        handler: async ({ name, ...args }) => s.withProject(name, async (client) => ({ data: await call(client, 'readProbes', args, 30000) })),
    });
    const listTypesTool = tools.find(t => t.name === 'list_node_types');
    if (listTypesTool) listTypesTool.description += " Debug probes (category 'debug') show values read back from the GPU on the canvas; read_probes returns them.";
    const getProjectTool = tools.find(t => t.name === 'get_project');
    if (getProjectTool) getProjectTool.description += ' Debug probe nodes carry their latest reading in probe {status, value, text, nan, ...} (see read_probes).';

    // ------------------------------------------------------------------ output: recording / export / output window (src/output)
    // Exported files come back from the page base64-encoded and are written under exports/ (gitignored).
    // res.filename / res.ext come from the page: never trust them as a path.
    const writeExport = (res, save_path) => {
        if (!res || !res.data_base64) return null;
        const pageExt = String(res.ext || path.extname(String(res.filename || '')).slice(1) || '').toLowerCase();
        const ext = EXPORT_EXTS.has(pageExt) ? pageExt : 'bin';
        let abs;
        if (save_path) {
            abs = safeOutputPath(s, save_path, ext);
        } else {
            const dir = path.join(s.repoRoot, 'exports');
            fs.mkdirSync(dir, { recursive: true });
            const name = sanitizeFilename(res.filename || 'patchtoy-export', { ext, fallback: 'patchtoy-export' });
            try {
                abs = confinedFilePath([dir], name, { ext, fallback: 'patchtoy-export' });
            } catch (e) {
                throw new ToolError(`Export file name rejected: ${e.message}`);
            }
        }
        writeFileNoFollow(abs, Buffer.from(res.data_base64, 'base64'));
        res.filename = path.basename(abs);
        res.ext = ext;
        delete res.data_base64;
        res.saved = displayPath(abs);
        res.saved_abs = abs;
        return abs;
    };
    tools.push(
        {
            name: 'start_recording',
            title: 'Record / export video',
            description: "Record a Preview's output to a video file. mode 'realtime' (default) uses MediaRecorder on what plays live (WebM VP9/VP8, or MP4 H.264 where the browser supports it; audio = true adds the app's playing audio file / tab / mic): without duration it runs until stop_recording, with duration (seconds) it stops by itself and returns the saved file. mode 'offline' renders frame by frame at a fixed timestep (slower than real time, perfectly smooth even for heavy patches) and encodes with WebCodecs: format 'mp4' (H.264, default), 'webm' (VP9) or 'png' (zipped PNG sequence); duration defaults to 5 s, from_start (default true) starts at u_time 0 with cleared Feedback buffers. Offline renders do not analyse live audio: audio uniforms follow the metronome groove (set_audio {mode:'metronome'}) or are 0. preview_id defaults to the main (background, else first) Preview; width/height default to 1280x720 (even numbers). The file is written to exports/<project>_<date>.<ext> (or save_path, relative to the repo root) and its path returned with frames, duration_s, codec and render_fps.",
            inputSchema: {
                preview_id: nodeId.optional(),
                width: z.number().int().min(16).max(7680).optional(),
                height: z.number().int().min(16).max(4320).optional(),
                fps: z.number().min(1).max(120).optional(),
                mode: z.enum(['realtime', 'offline']).optional(),
                duration: z.number().min(0.05).max(3600).optional().describe('Seconds. Offline: length of the export (default 5). Realtime: auto-stop and return the file.'),
                format: z.enum(['webm', 'mp4', 'png']).optional().describe("realtime: webm (default) | mp4; offline: mp4 (default) | webm | png"),
                bitrate: z.number().int().min(100000).max(400000000).optional().describe('Bits per second (default: automatic from size and fps)'),
                audio: z.boolean().optional().describe('Realtime only: include the playing audio (file / tab / mic)'),
                from_start: z.boolean().optional(),
                save_path: z.string().optional(),
                name: projectName,
            },
            handler: async ({ save_path, name, ...args }) => s.withProject(name, async (client) => {
                if (save_path) safeOutputPath(s, save_path, null); // reject a bad path before recording
                const fps = args.fps || 30;
                const dur = args.duration || 5;
                const timeout = args.mode === 'offline'
                    ? Math.min(3600000, 120000 + dur * fps * 2000)
                    : (args.duration ? args.duration * 1000 + 90000 : 60000);
                const res = await call(client, 'startRecording', args, timeout);
                writeExport(res, save_path);
                return { data: res };
            }),
        },
        {
            name: 'stop_recording',
            title: 'Stop recording',
            description: 'Stop the running real-time recording and save it (exports/<project>_<date>.webm|mp4, or save_path); returns the path, duration_s, frames and size. Cancels a running offline export.',
            inputSchema: { save_path: z.string().optional() },
            handler: async ({ save_path }) => s.withClient(async (client) => {
                const res = await call(client, 'stopRecording', {}, 120000);
                writeExport(res, save_path);
                return { data: res };
            }),
        },
        {
            name: 'output_window',
            title: 'Output window',
            description: "Pop-out output window for a second display / projector: action 'open' shows a Preview (preview_id, default the main one) full-window on black; 'close'; 'status' (default) reports it (size, fps, fullscreen, display, calibration) and the displays the Window Management API exposes. display = screen index, 'secondary' or a label substring (needs the window-management permission; fullscreen on another screen needs a click in that window). performance_mode pauses the editor and other previews while the window is open. test_pattern 'grid' | 'bars' | 'white' | 'off', calibrating shows the warp overlay, calibration sets {corners:[[x,y] x4 TL,TR,BR,BL in 0..1], gridSize 0|3|5, grid, blend:{left,right,top,bottom,curve,gamma}, mask:{points,invert,feather}} (saved per display in the project). The user's own browser may block the pop-up when it is opened without a click.",
            inputSchema: {
                action: z.enum(['open', 'close', 'status']).optional(),
                preview_id: nodeId.optional(),
                display: z.union([z.number().int(), z.string()]).optional(),
                fullscreen: z.boolean().optional(),
                performance_mode: z.boolean().optional(),
                test_pattern: z.union([z.enum(['off', 'grid', 'bars', 'white']), z.boolean()]).optional(),
                calibrating: z.boolean().optional(),
                calibration: z.record(z.string(), z.any()).optional(),
                name: projectName,
            },
            handler: async ({ name, ...args }) => {
                const run = async (client) => ({ data: await call(client, 'outputWindow', args, 30000) });
                return args.action === 'open' ? s.withProject(name, run) : s.withClient(run);
            },
        },
    );

    addMidiTools(tools, s); // midi_map, midi_unmap, simulate_midi (mcp/lib/midiTools.mjs)
    addIOTools(tools, s); // io_bridge (mcp/lib/ioTools.mjs)
    addRender3DTools(tools, s); // load_model (mcp/lib/render3dTools.mjs)

    // ------------------------------------------------------------------ group box port names
    tools.push({
        name: 'rename_group_port',
        title: 'Rename group ports',
        description: 'Name the ports of a node group box (shown on the box and on the matching rows of the "From outside" / "To outside" panels inside the group) instead of the automatic names derived from inner ports such as "Add.a". port: the port key from list_groups port_keys ("s:12:0" input fed by node 12 output 0, "x:7:1" exposed input 1 of node 7, "o:15:0" output 0 of node 15), "in:N" / "out:N" (box port index), or its current / automatic label; label "" restores the automatic name. ports: {port: label, ...} renames several at once. Names are saved with the project and undoable. Returns {group, renamed: [{key, kind, previous, label, custom, changed}]}.',
        inputSchema: {
            group_id: z.union([z.string(), z.number()]).describe('Group id ("g3") or name'),
            port: z.string().optional().describe('Port key, "in:N" / "out:N", or label'),
            label: z.string().max(60).optional().describe('New name ("" = automatic)'),
            ports: z.record(z.string(), z.string().max(60)).optional().describe('Several at once: {port: label}'),
        },
        handler: async (args) => s.withProject(null, async (client) => ({ data: await call(client, 'renameGroupPort', args) }), { mutating: true }),
    });
    return tools;
}

export const SERVER_INSTRUCTIONS = `PatchToy is a node-based GLSL shader editor. These tools drive the real app running in a browser (the user's own tab in live mode, or an auto-launched headless Chrome), so node behaviour, compilation and rendering are exactly what the user sees.

Typical workflow:
1. list_projects / create_project {name} or open_project {name} - projects live in projects/<slug>.patchtoy.json and are auto-saved after every edit.
2. list_node_types (optionally with search/category) to learn the available nodes and their ports.
3. build_graph to create many nodes + connections in one call (preferred), or add_node / connect / set_node_data for small edits. create_custom_node turns any GLSL function into a node.
4. compile to check for errors, render_preview to look at the result (PNG), screenshot_editor to see the editor itself.
Every graph needs a Preview node: it renders its vec4 'color' input (float/vec2/vec3 auto-convert).
Parameters: Param nodes (kind float/int/bool/vecN/color/enum/trigger/image) appear with pretty labels in the app's Parameters panel; list_params / set_param read and tweak them without recompiling. JS nodes run JavaScript every frame and expose the returned values (numbers, vectors, canvases, data textures) as outputs.
Scenes: a SceneSwitcher shows one of its scene inputs and transitions between two (only the shown scenes are evaluated); list_scenes / set_scene drive it, ScenePresence inside a scene gives that scene's presence for entrance / exit choreography (wire it into effect amount inputs).
Music: any GLSL can use u_level, u_bass, u_mid, u_high, u_kick, u_beat, u_beatPhase, u_barPhase, u_beatCount, u_bpm, u_beatTime, u_beatConfidence, u_beatTrust, u_beatRaw (or the Audio / Beat / BeatEnvelope nodes; multiply beat effects by u_beatConfidence = Beat.confidence so they fade with the lock, and beat-phase couplings by Beat.gate = smoothstep(0.25, 0.75, u_beatTrust): the beat clock is a stable published clock that coasts while the tracker is unsure (a track change) and glides to a new tempo; u_beat already fades with it). set_audio {mode:'metronome', bpm} gives a deterministic beat clock; render_preview {beat_phase} renders at a beat position.
Debugging: probe nodes (category 'debug': ValueDisplay, ColorDisplay, Plot, XYScope, FrameStats, Histogram, LED) evaluate their input on the GPU at a sample point (uv 0,0 by default, center, mouse or a custom uv) or over the whole frame and show the numbers on the canvas; read_probes returns them (NaN / Inf flagged), e.g. to check a value, find what makes pixels black or verify that something animates.`;
