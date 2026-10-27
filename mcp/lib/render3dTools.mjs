/**
 * Render 3D MCP tools: load_model (a local .glb / .gltf, or a URL, into a Model node).
 * Local paths are confined like the other file tools (mcp/lib/auth.mjs confinedFilePath):
 * the repo, the temp folder, PATCHTOY_SAVE_DIRS and PATCHTOY_MODEL_DIRS (comma-separated);
 * hidden folders, node_modules and symlinks are refused; only .glb / .gltf, at most 64 MB.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { ToolError, displayPath } from './session.mjs';
import { confinedFilePath, UnsafePathError } from './auth.mjs';

const MODEL_EXTS = new Set(['glb', 'gltf']);
const MAX_BYTES = 64 * 1024 * 1024;

export function modelRoots(session) {
    const extra = [process.env.PATCHTOY_SAVE_DIRS, process.env.PATCHTOY_MODEL_DIRS].join(',').split(',').map(x => x.trim()).filter(Boolean);
    const roots = [session.repoRoot, os.tmpdir(), ...extra];
    if (process.platform !== 'win32' && fs.existsSync('/tmp')) roots.push('/tmp');
    return roots;
}

/** Resolve and check a model path for reading. Returns the absolute path. */
export function confinedModelPath(session, target) {
    const ext = path.extname(String(target || '')).slice(1).toLowerCase();
    if (!MODEL_EXTS.has(ext)) throw new ToolError(`Not a glTF model: ${target} (allowed: .glb, .gltf)`);
    let abs;
    try {
        abs = confinedFilePath(modelRoots(session), target, { ext, mkdir: false });
    } catch (e) {
        if (e instanceof UnsafePathError) {
            throw new ToolError(`path rejected: ${e.message}`, { allowed_folders: modelRoots(session).map(displayPath), hint: 'Copy the model into the repo (e.g. assets/models/) or the temp folder, or list its folder in PATCHTOY_MODEL_DIRS.' });
        }
        throw e;
    }
    const wanted = path.resolve(modelRoots(session)[0], String(target).trim());
    if (path.basename(abs) !== path.basename(wanted)) {
        throw new ToolError(`Unsupported file name: ${path.basename(wanted)} (use letters, digits, . _ - only)`);
    }
    let st;
    try { st = fs.statSync(abs); } catch { throw new ToolError(`Model file not found: ${target}`); }
    if (!st.isFile()) throw new ToolError(`Not a file: ${target}`);
    if (st.size > MAX_BYTES) throw new ToolError(`Model is larger than ${MAX_BYTES / 1048576} MB`);
    return abs;
}

export function addRender3DTools(tools, s) {
    tools.push({
        name: 'load_model',
        title: 'Load a glTF model',
        description: "Load a glTF 2.0 model (.glb, or .gltf with embedded buffers / images; e.g. a Blender export) into a Model node for Render 3D. path = local file (relative paths resolve from the repo root; allowed folders: the repo, the temp folder, PATCHTOY_SAVE_DIRS / PATCHTOY_MODEL_DIRS) or url = http(s) URL. Without node_id a new Model node is created and wired into the first Render 3D node (a Render 3D + Preview are added when there is none); node_id replaces the model of an existing Model node. Models up to 15 MB are stored in the project as a data URL (larger ones load for this session only). fit = true scales the model to 2 units and centres it. Draco / meshopt compressed files are rejected with a clear message. Returns {node, render3d, model: {status, meshes, primitives, triangles, joints, clips [{index, name, duration}], bounds, warnings}}.",
        inputSchema: {
            path: z.string().optional().describe('Local .glb / .gltf path'),
            url: z.string().optional().describe('http(s) URL of a .glb / .gltf'),
            node_id: z.union([z.number().int(), z.string()]).optional().describe('Existing Model node to load into'),
            name: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            connect: z.boolean().optional().describe('Wire a new Model into a Render 3D node (default true)'),
            fit: z.boolean().optional().describe('Scale to 2 units and centre (default true for new nodes)'),
        },
        handler: async ({ path: p, url, ...rest }) => s.withProject(null, async (client) => {
            const params = { ...rest };
            if (p) {
                const abs = confinedModelPath(s, p);
                params.data_base64 = fs.readFileSync(abs).toString('base64');
                params.name = rest.name || path.basename(abs);
            } else if (url) {
                if (!/^https?:\/\//i.test(url)) throw new ToolError('url must be an http(s) URL');
                params.url = url;
            } else {
                throw new ToolError('Pass path (a local .glb / .gltf) or url');
            }
            return { data: await s.call(client, 'loadModel', params, 120000) };
        }, { mutating: true }),
    });
}
