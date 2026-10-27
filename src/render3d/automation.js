/**
 * Render 3D in the automation API (MCP tools): list_node_types notes, get_project stats,
 * render_preview sizes, compile reports, dynamic item ports, load_model.
 * Installed by src/automation/AutomationAPI.js (one call at its end).
 */
import { R3D } from './runtime.js';
import { createModelNode, assignModelBytes } from './ModelNode.js';

const NOTES = {
    Render3D: [
        "Scene: connect Mesh / Model / Group 3D / light outputs to item1, item2, ... (connecting the last free item adds the next one; build_graph may name any itemN, missing ones are created). Outputs are textures: color (gamma-encoded HDR, premultiplied alpha = coverage; wire into Preview, TextureSample, bloom, Feedback...), depth (r = distance from the camera along the view ray in world units = Raymarch.t; data.far where empty), normal (world xyz). Only wired outputs are rendered.",
        "Camera: a Camera struct (CameraObject / OrbitalCamera, the same conventions as Raymarch: vertical fov in degrees) or, unconnected, data.orbit {yaw, pitch (radians), distance, target [x,y,z], fov} (drag / scroll on the node preview).",
        "Rendering is lazy: the node renders once per frame when something binds its textures (hidden scenes, off-screen previews cost nothing; render_preview renders at the pinned time and at the render size). data.size 'auto' (default: the largest output shown x its render-quality scale, capped by data.maxSize) | 'fixed' (data.width x data.height). data.msaa 0|2|4, near / far, fog, exposure, tonemap gamma|aces|linear, clearColor [r,g,b,a] (when background is unconnected), shadowRes.",
        "Compositing with raymarching: background = any image drawn behind the objects; bgDepth = its distance along the view ray (e.g. Raymarch.t, or 1e6 where Raymarch.hit is 0), so raster objects are hidden behind SDF surfaces with full MSAA. The other way round, Raymarch.depth / under take this node's depth / color textures.",
        "get_project reports render3d {size, msaa, draws, instances, triangles, points, shadow, cpu_ms, objects, lights, errors}.",
    ],
    Mesh: [
        "material: wire a PBR / Unlit / Toon / Iridescent / Glass Material (or any float / vec3 / vec4 colour = PBR base colour). Its sub-graph runs per fragment: use the Surface node (position, normal, uv, view, instanceId, instanceColor, vertexColor, localPosition, distance).",
        "instances: wire Make Instance / Instances From Texture. Its sub-graph runs per instance in the vertex shader: Instance Index (id, count, t, random), Instance Grid, Instance Data (texels of a Feedback / JS data texture: instance i = texel (i mod W, i div W) of each stacked block). count: 0 = automatic (W x H / blocks of the instance texture, nx*ny*nz of an Instance Grid, else 1); wire a Param to change it live.",
        "displace: per-vertex local offset sub-graph (Surface: local position, normal, uv, vertex colour; Instance Index; u_time...). Normals are not recomputed.",
        "data: castShadow, receiveShadow, cull back|front|none, blend auto|opaque|alpha|add (alpha / add: drawn after the opaque objects, no depth write; Glass and alpha < 1 are blended automatically), pointSize (Points Mesh: world units x instance scale.x).",
    ],
    Model: [
        "Load a glTF 2.0 file: drop a .glb on the canvas, load_model {path | url} (MCP), or data.src = URL / data URL. Supported: meshes + node hierarchy, PBR metal/rough (base colour, metal/rough, normal, emissive, occlusion textures; alpha mask / blend; KHR_materials_unlit), vertex colours, skinning (up to 4 weights, 1024 joints), animation clips (translation / rotation / scale, linear / step / cubic spline). Not supported: Draco / meshopt compression (a clear error), morph targets, KHR_texture_transform, multiple uv sets.",
        "clip = animation index (-1 = rest pose), time = seconds (default u_time; wire Beat.time to dance on the beat). get_project reports model {name, bytes, meshes, primitives, triangles, joints, clips, status}.",
    ],
};

const CATEGORY_NOTE = 'Render 3D node (rasterized geometry): only meaningful upstream of a Render 3D node (see list_node_types Render3D).';

export function installRender3DAutomation(AutomationAPI, AutomationError) {
    const P = AutomationAPI.prototype;

    const baseNotes = P._typeNotes;
    P._typeNotes = function (name, def) {
        const notes = baseNotes.call(this, name, def);
        if (!def || def.category !== 'render3d') return notes;
        if (NOTES[name]) notes.push(...NOTES[name]);
        else if (def.isGeometryNode) notes.push('Geometry: params are CPU values (inline fields, or a control-rate cable such as a Param: the mesh is rebuilt when they change). Wire geometry into Mesh.geometry.');
        else if (def.isLight) notes.push('Light: wire into a Render 3D item input (or a Group 3D). Inputs are GLSL values, so Params / Time / Beat animate them without recompiling.' + (name === 'DirectionalLight' ? ' data.castShadow (one shadow map per scene: the first shadow-casting directional light), data.softness.' : ''));
        else if (/Material$/.test(name)) notes.push('Material: wire into Mesh.material (or Model.material to replace the file materials). Inputs may read the Surface node.');
        else notes.push(CATEGORY_NOTE);
        return notes;
    };

    const basePublic = P._publicData;
    P._publicData = function (node) {
        const out = basePublic.call(this, node);
        if (node.isModelNode && typeof out.src === 'string' && out.src.length > 200) {
            out.src = out.src.startsWith('data:') ? `<data URL, ${Math.round(out.src.length * 0.75 / 1024)} KB>` : out.src.slice(0, 200) + '...';
        }
        return out;
    };

    const baseDescribe = P.describeNode;
    P.describeNode = function (node) {
        const d = baseDescribe.call(this, node);
        try {
            if (node.isRender3DNode) d.render3d = node.describe();
            if (node.isModelNode && typeof node.describeModel === 'function') d.model = node.describeModel();
        } catch (e) { /* ignore */ }
        return d;
    };

    // build_graph / connect may name any itemN of a Render 3D node
    const baseResolve = P._resolvePort;
    P._resolvePort = function (node, ref, kind) {
        if (kind === 'input' && node && node.isRender3DNode && typeof ref === 'string') {
            const m = /^item(\d+)$/.exec(ref);
            if (m) {
                const k = parseInt(m[1], 10);
                let guard = 0;
                while (node.data.items < k && guard++ < 64) if (!node.addDynamicInput()) break;
            }
        }
        return baseResolve.call(this, node, ref, kind);
    };

    // render_preview: models still loading (async) are waited for, so renders are reproducible
    const basePreview = P.renderPreview;
    P.renderPreview = function (params = {}) {
        const models = this.graph.nodes.filter(n => n.isModelNode);
        for (const m of models) { try { m.ensureLoaded(); } catch (e) { /* reported on the node */ } }
        const pending = models.filter(m => m.status === 'loading' && m._loading).map(m => m._loading);
        if (!pending.length) return basePreview.call(this, params);
        const timeout = new Promise(r => setTimeout(r, 20000));
        return Promise.race([Promise.all(pending), timeout]).then(() => basePreview.call(this, params));
    };

    // render_preview: Render 3D nodes in auto size render at the requested size
    const baseRender = P._renderShader;
    P._renderShader = function (shader, width, height, time, mouse) {
        const prev = R3D.sizeOverride;
        R3D.sizeOverride = { w: width, h: height };
        try {
            return baseRender.call(this, shader, width, height, time, mouse);
        } finally {
            R3D.sizeOverride = prev;
        }
    };

    // compile: Render 3D programs are part of the report (a failing one fails the compile)
    const baseReport = P._compileReport;
    P._compileReport = function (opts = {}) {
        const out = baseReport.call(this, opts);
        const nodes = this.graph.nodes.filter(n => n.isRender3DNode).sort((a, b) => a.id - b.id);
        if (!nodes.length) return out;
        out.render3d = nodes.map(n => {
            const c = n.compiled;
            const rep = { id: n.id, ok: !(n.compileErrors && n.compileErrors.length), draws: c ? c.draws.length : 0, lights: c ? c.lights.length : 0 };
            if (!rep.ok) rep.errors = n.compileErrors.slice();
            if (c && c.warnings.length) rep.warnings = c.warnings.slice();
            if (opts.include_source && c) rep.sources = c.draws.map(d => ({ node: d.node.id, vertex: d.vs, fragment: d.fs }));
            return rep;
        });
        if (out.render3d.some(r => !r.ok)) out.ok = false;
        return out;
    };

    // load_model: bytes (base64) or a URL into a Model node (new, wired into a Render 3D, or node_id)
    AutomationAPI.METHODS.push('loadModel');
    P.loadModel = async function ({ data_base64, url, name, node_id, x, y, connect = true, fit, wait_ms = 15000 } = {}) {
        let node;
        let bytes = null;
        if (data_base64) {
            const bin = atob(String(data_base64));
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            bytes = u8.buffer;
        } else if (!url) {
            throw new AutomationError('load_model needs a file (path) or a url');
        }
        try {
            if (node_id !== undefined && node_id !== null) {
                node = this._getNode(node_id);
                if (!node.isModelNode) throw new AutomationError(`Node ${node_id} is a ${node.type}, not a Model`);
                if (bytes) await assignModelBytes(node, bytes, name);
                else { node._memoryBytes = null; node.data.src = String(url); node.data.name = name || String(url).split('/').pop(); }
            } else {
                const pos = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : this._autoPosition();
                if (bytes) node = (await createModelNode(this.toy, bytes, name || 'model.glb', pos, { connect })).node;
                else {
                    node = this.graph.addNode('Model', pos.x, pos.y);
                    node.data.src = String(url);
                    node.data.name = name || String(url).split('/').pop();
                }
            }
        } catch (e) {
            if (e instanceof AutomationError) throw e;
            throw new AutomationError(`Could not load the model: ${e.message}`);
        }
        if (fit !== undefined) node.data.fit = fit ? 1 : 0;
        node._loadKey = undefined;
        node.ensureLoaded();
        const t0 = performance.now();
        while (node.status === 'loading' && performance.now() - t0 < wait_ms) await new Promise(r => setTimeout(r, 30));
        this._graphChanged();
        try { this._compileApp(); } catch (e) { /* reported by compile */ }
        if (node.status === 'error') throw new AutomationError(`Model #${node.id}: ${node.error}`, { node: node.id });
        const r3 = this.graph.connections.find(c => c.fromNode === node && c.toNode.isRender3DNode);
        this.activity(`loaded model ${node.data.name}`);
        return { node: node.id, render3d: r3 ? r3.toNode.id : null, model: node.describeModel() };
    };

    void AutomationError;
}
