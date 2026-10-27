/**
 * Render 3D shader generation.
 *
 * compileRender3D(node, graph, compiler) walks the scene of one Render 3D node (its item
 * inputs: Meshes, Models, Group 3D nodes, lights) and generates, with the app's
 * ShaderCompiler, per drawn object:
 *   - a vertex shader: camera (VS main), object / group transforms (VS main), the
 *     instances sub-graph (function per instance), the displacement sub-graph (function
 *     per vertex), skinning (#ifdef R3_SKIN), points (#ifdef R3_POINTS);
 *   - a fragment shader: lights (FS main), the material sub-graph (function per
 *     fragment, or the glTF file material behind #ifdefs), PBR / toon / glass shading,
 *     the soft shadow lookup, fog; outputs color / depth / normal (MRT);
 *   - a shadow-pass vertex shader when the object casts the directional shadow.
 * plus the background pass (the background / bgDepth inputs) when connected.
 *
 * Sources are linked per variant (#define set) through the shared ProgramCache.
 */
import { TypeRegistry } from '../core/TypeRegistry.js';
import { builtinUniformsIn } from '../core/builtinUniforms.js';
import { collectLibrary } from '../core/library/glsl.js';
import { MATERIAL_PARAMS, INSTANCE_PARAMS, DISPLACE_PARAMS, DEFAULT_MATERIAL, DEFAULT_INSTANCE } from '../core/library/render3d.js';

const DEFAULT_SUN = 'Light(1.0, vec3(0.0), normalize(vec3(0.5, 1.0, 0.35)), vec3(1.0, 0.96, 0.9), 2.6, 6.0, vec2(0.0), vec3(0.0), 0.0)';
const DEFAULT_SKY = 'Light(0.0, vec3(0.0), vec3(0.0, 1.0, 0.0), vec3(0.38, 0.45, 0.6), 0.9, 0.0, vec2(0.0), vec3(0.12, 0.1, 0.09), 0.0)';
const DEFAULT_CAMERA = 'Camera(r3_camPos, r3_camTarget, r3_camFov)';

/** Input connection by input name (null when unconnected). */
export function inputConn(graph, node, name) {
    const idx = node.inputs.findIndex(i => i.name === name);
    if (idx < 0) return null;
    for (const c of graph.connections) if (c.toNode === node && c.toInput === idx) return c;
    return null;
}

function label(node) {
    const t = (node.definition && node.definition.displayTitle) || node.type;
    return `${t} #${node.id}`;
}

/** Scene items of a Render 3D node: objects (with their group chain) and light connections. */
export function collectScene(r3, graph) {
    const objects = [];
    const lights = [];
    const errors = [];
    const walk = (node, chain, inputs) => {
        for (const name of inputs) {
            const c = inputConn(graph, node, name);
            if (!c) continue;
            const src = c.fromNode;
            const def = src.definition || {};
            const outType = src.outputs[c.fromOutput] ? src.outputs[c.fromOutput].type : null;
            if (def.isRender3DObject) {
                objects.push({ node: src, chain: chain.slice() });
            } else if (def.isRender3DGroup) {
                if (chain.includes(src) || chain.length > 12) { errors.push(`${label(src)}: groups nest in a loop`); continue; }
                walk(src, [...chain, src], ['a', 'b', 'c', 'd']);
            } else if (outType === 'Light' || def.isLight) {
                lights.push({ conn: c, node: src });
            } else {
                errors.push(`${label(node)}.${name}: ${label(src)} is not a Mesh, Model, Group 3D or light`);
            }
        }
    };
    walk(r3, [], r3.inputs.filter(i => /^item\d+$/.test(i.name)).map(i => i.name));
    return { objects, lights, errors };
}

/** Which outputs of the Render 3D node are wired (attachments to render). */
export function usedOutputs(r3, graph) {
    const used = { color: false, depth: false, normal: false };
    for (const c of graph.connections) {
        if (c.fromNode !== r3) continue;
        const o = r3.outputs[c.fromOutput];
        if (o) used[o.name] = true;
    }
    return used;
}

// ----------------------------------------------------------------------
// Compiler helpers (scopes on the shared ShaderCompiler)
// ----------------------------------------------------------------------

function remapName(compiler, node, suffix) {
    return `r3_${compiler.getRemappedNodeId(node.id)}_${suffix}`;
}

/**
 * Compile an input's upstream sub-graph as a GLSL function (like
 * ShaderCompiler.compileFunctionInput, with a custom value conversion).
 */
function compileFunction(compiler, graph, node, conn, { params, returns, fallback }, fnName, convert) {
    const saved = { code: compiler.generatedCode, cache: compiler.compiledNodes, map: compiler.codeToNodeMap };
    compiler.generatedCode = [];
    compiler.compiledNodes = new Map();
    compiler.codeToNodeMap = new Map();
    compiler.lambdaStack.push({ params, fnName });
    let ret = null;
    let body = [];
    try {
        if (conn) {
            const src = compiler.resolveConnection(conn, graph, node);
            if (src) ret = convert(src);
        } else {
            ret = fallback;
        }
        body = compiler.generatedCode;
    } finally {
        compiler.generatedCode = saved.code;
        compiler.compiledNodes = saved.cache;
        compiler.codeToNodeMap = saved.map;
        compiler.lambdaStack.pop();
    }
    if (ret === null || ret === undefined) return null;
    const ps = params.map(p => `${p.type} ${p.name}`).join(', ');
    const bodyCode = body.map(l => '    ' + l).join('\n');
    compiler.addCustomFunction(fnName, `${returns} ${fnName}(${ps}) {\n${bodyCode}${bodyCode ? '\n' : ''}    return ${ret};\n}`, node.id);
    return fnName;
}

/** GLSL value of an input in the current scope: its connection, or the inline / default value. */
function inputValue(compiler, graph, node, name, type) {
    const input = node.inputs.find(i => i.name === name);
    const c = inputConn(graph, node, name);
    if (c) {
        const src = compiler.resolveConnection(c, graph, node);
        if (!src) return null;
        return compiler.convertForInput(src.value, src.type, type, node);
    }
    return input ? compiler.defaultForInput(node, input) : null;
}

function materialConvert(compiler, node) {
    return (src) => {
        if (src.type === 'Material') return src.value;
        if (src.type === 'float' || src.type === 'vec2' || src.type === 'vec3' || src.type === 'vec4') {
            const v = src.value;
            const rgb = src.type === 'vec4' ? `(${v}).rgb` : src.type === 'vec3' ? v : src.type === 'vec2' ? `vec3(${v}, 0.0)` : `vec3(${v})`;
            const a = src.type === 'vec4' ? `(${v}).a` : '1.0';
            return `Material(${rgb}, ${a}, 0.45, 0.0, vec3(0.0), r3N, 0.0, vec4(0.0), vec3(0.0))`;
        }
        compiler.addError(`${label(node)}.material: expected a Material (PBR / Unlit / Toon / Iridescent / Glass Material) or a colour, got ${src.type}`, node.id);
        return null;
    };
}

function typed(compiler, node, input, want) {
    return (src) => {
        if (src.type === want) return src.value;
        if (TypeRegistry.isStruct(src.type) || TypeRegistry.isStruct(want)) {
            compiler.addError(`${label(node)}.${input}: expected ${want}, got ${src.type}`, node.id);
            return null;
        }
        return compiler.convertForInput(src.value, src.type, want, node);
    };
}

/** Uniform values of the current compile (copies), like compileFromNodeAsOutput. */
function uniformValues(compiler) {
    return Array.from(compiler.uniforms)
        .filter(u => typeof u === 'object' && (u.value !== undefined || u.feedbackNodeId !== undefined || u.microphoneNodeId !== undefined || u.midiCCNodeId !== undefined))
        .map(u => {
            const c = { ...u };
            if (Array.isArray(u.value)) c.value = [...u.value];
            return c;
        });
}

/** Declarations, structs and functions of the current scope + the template code. */
function assemble(compiler, head, templateFns, mainOpen, mainCode, mainTail, structs) {
    // Library functions used by the template (deduplicated against the node preambles)
    const lib = collectLibrary(`${templateFns}\n${mainCode}\n${mainTail}`);
    if (lib) compiler.addCustomFunction('r3_template_lib', lib);
    for (const s of structs) compiler.usedStructs.add(s);
    const functions = Array.from(compiler.customFunctions.values()).join('\n\n');
    const generated = compiler.generatedCode.map(l => '    ' + l).join('\n');
    const all = [generated, functions, templateFns, mainCode, mainTail].join('\n');
    for (const name of builtinUniformsIn(all)) compiler.addUniform(name);
    const decls = [];
    const seen = new Set();
    for (const u of compiler.uniforms) {
        const name = typeof u === 'string' ? u : u && u.name;
        if (!name || seen.has(name) || /^r3_/.test(name)) continue;
        seen.add(name);
        const d = compiler.getUniformDeclaration(u);
        if (d) decls.push(d);
    }
    const structDefs = compiler.generateStructDefinitions();
    return `${head}
${decls.join('\n')}

${structDefs}

${functions}

${templateFns}

${mainOpen}
${generated}
${mainCode}
${mainTail}
}`;
}

// ----------------------------------------------------------------------
// Templates
// ----------------------------------------------------------------------

const VS_HEAD = `#version 300 es
//__DEFINES__
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in vec4 a_color;
layout(location = 4) in vec4 a_joints;
layout(location = 5) in vec4 a_weights;
uniform mat4 r3_model;
uniform mat3 r3_normalMat;
uniform float r3_count;
uniform vec2 r3_size;
uniform float r3_near;
uniform float r3_far;
uniform float r3_pointSize;
uniform vec3 r3_camPos;
uniform vec3 r3_camTarget;
uniform float r3_camFov;
#ifdef R3_SKIN
uniform highp sampler2D r3_joints;
#endif
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_icol;
flat out float v_inst;
out vec3 v_local;
flat out vec3 v_camPos;
`;

const VS_FNS = `#ifdef R3_SKIN
mat4 r3Joint(float j) {
    int x = int(j + 0.5) * 4;
    return mat4(texelFetch(r3_joints, ivec2(x, 0), 0), texelFetch(r3_joints, ivec2(x + 1, 0), 0),
                texelFetch(r3_joints, ivec2(x + 2, 0), 0), texelFetch(r3_joints, ivec2(x + 3, 0), 0));
}
#endif`;

const FS_HEAD = `#version 300 es
//__DEFINES__
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DShadow;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_icol;
flat in float v_inst;
in vec3 v_local;
flat in vec3 v_camPos;
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_depth;
layout(location = 2) out vec4 o_normal;
uniform highp sampler2DShadow r3_shadowMap;
uniform float r3_shadowOn;
uniform float r3_shadowTexel;
uniform float r3_shadowSoft;
uniform float r3_receiveShadow;
uniform float r3_far;
uniform vec4 r3_fog;
uniform float r3_exposure;
uniform float r3_tonemap;
uniform float r3_additive;
`;

// glTF file material (uniforms + optional textures, see gltf.js)
const FILE_MATERIAL = `uniform vec4 r3m_base;
uniform vec3 r3m_mr;
uniform vec3 r3m_emissive;
uniform float r3m_alphaCutoff;
uniform float r3m_normalScale;
uniform float r3m_occStrength;
uniform float r3m_unlit;
#ifdef R3_TEX_BASE
uniform sampler2D r3m_baseTex;
#endif
#ifdef R3_TEX_MR
uniform sampler2D r3m_mrTex;
#endif
#ifdef R3_TEX_NORMAL
uniform sampler2D r3m_normalTex;
#endif
#ifdef R3_TEX_EMISSIVE
uniform sampler2D r3m_emTex;
#endif
#ifdef R3_TEX_OCC
uniform sampler2D r3m_occTex;
#endif
vec3 r3PerturbNormal(vec3 N, vec3 p, vec2 uv, vec3 t) {
    vec3 dp1 = dFdx(p);
    vec3 dp2 = dFdy(p);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float m = max(dot(T, T), dot(B, B));
    if (m < 1e-20) return N;
    float inv = inversesqrt(m);
    return normalize(mat3(T * inv, -B * inv, N) * t);
}
Material r3FileMaterial(vec3 r3P, vec3 r3N, vec2 r3UV, vec3 r3V, float r3I, vec4 r3IC, vec4 r3VC, vec3 r3L) {
    vec4 base = r3m_base * r3VC;
#ifdef R3_TEX_BASE
    base *= texture(r3m_baseTex, r3UV);
#endif
    float metal = r3m_mr.x;
    float rough = r3m_mr.y;
#ifdef R3_TEX_MR
    vec4 mr = texture(r3m_mrTex, r3UV);
    rough *= mr.g;
    metal *= mr.b;
#endif
    vec3 em = r3m_emissive;
#ifdef R3_TEX_EMISSIVE
    em *= texture(r3m_emTex, r3UV).rgb;
#endif
    vec3 n = r3N;
#ifdef R3_TEX_NORMAL
    vec3 t = texture(r3m_normalTex, r3UV).xyz * 2.0 - 1.0;
    t.xy *= r3m_normalScale;
    n = r3PerturbNormal(r3N, r3P, r3UV, normalize(t));
#endif
    float occ = 1.0;
#ifdef R3_TEX_OCC
    occ = mix(1.0, texture(r3m_occTex, r3UV).r, r3m_occStrength);
#endif
#ifdef R3_ALPHA_MASK
    if (base.a < r3m_alphaCutoff) discard;
    base.a = 1.0;
#endif
    return Material(base.rgb, base.a, clamp(rough, 0.02, 1.0), clamp(metal, 0.0, 1.0), em, n, r3m_unlit, vec4(0.0, 0.0, 0.0, 1.0 - occ), vec3(0.0));
}`;

// ----------------------------------------------------------------------
// Per object
// ----------------------------------------------------------------------

/** Statements applying the object TRS then the group chain (inner to outer). */
function transformCode(compiler, graph, obj) {
    const lines = [];
    const steps = [obj.node, ...obj.chain.slice().reverse()];
    for (const n of steps) {
        const t = inputValue(compiler, graph, n, 'position', 'vec3');
        const r = inputValue(compiler, graph, n, 'rotation', 'vec3');
        const s = inputValue(compiler, graph, n, 'scale', 'vec3');
        if (t === null || r === null || s === null) return null;
        const trivial = t === 'vec3(0.0)' && r === 'vec3(0.0)' && s === 'vec3(1.0)';
        if (trivial) continue;
        lines.push(`pt_r3ApplyTRS(r3lp, r3ln, ${t}, pt_r3QuatEuler(${r}), ${s});`);
    }
    return lines.join('\n    ');
}

/** The camera expression in the current scope. */
function cameraExpr(compiler, graph, r3) {
    const c = inputConn(graph, r3, 'camera');
    if (!c) return DEFAULT_CAMERA;
    const src = compiler.resolveConnection(c, graph, r3);
    if (!src) return null;
    if (src.type !== 'Camera') {
        compiler.addError(`${label(r3)}.camera: expected a Camera (CameraObject / OrbitalCamera), got ${src.type}`, r3.id);
        return null;
    }
    compiler.usedStructs.add('Camera');
    return src.value;
}

function geometryOf(graph, obj) {
    if (obj.node.definition.isModelNode) return { node: null, kind: 'model' };
    const c = inputConn(graph, obj.node, 'geometry');
    if (!c) return { node: null, kind: 'box' };
    const g = c.fromNode;
    if (!g.definition || !g.definition.isGeometryNode) return { node: g, kind: null, error: `${label(obj.node)}.geometry: ${label(g)} is not a geometry node` };
    return { node: g, kind: g.definition.geometryKind };
}

/** Upstream nodes of a connection (breadth-first, bounded). */
function upstream(graph, conn, limit = 400) {
    const out = [];
    const seen = new Set();
    const queue = conn ? [conn.fromNode] : [];
    while (queue.length && out.length < limit) {
        const n = queue.shift();
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (n.definition && (n.definition.isFeedbackNode || n.definition.isTextureSourceNode)) continue;
        for (const c of graph.connections) if (c.toNode === n && !seen.has(c.fromNode)) queue.push(c.fromNode);
    }
    return out;
}

/** How many instances "count 0 = automatic" means for this object. */
function countSpec(graph, obj) {
    const ic = inputConn(graph, obj.node, 'instances');
    if (!ic) return null;
    for (const n of upstream(graph, ic)) {
        const def = n.definition || {};
        if (!def.isInstanceSource) continue;
        if (n.type === 'InstanceGrid') {
            const dims = ['nx', 'ny', 'nz'].map(k => (inputConn(graph, n, k) ? NaN : Math.max(1, Math.round(Number(n.data[k]) || 1))));
            if (dims.every(Number.isFinite)) return { fixed: dims[0] * dims[1] * dims[2] };
            continue;
        }
        const tc = inputConn(graph, n, 'texture');
        if (!tc) continue;
        const blocks = inputConn(graph, n, 'blocks') ? 1 : Math.max(1, Math.round(Number(n.data.blocks) || 1));
        return { tex: { node: tc.fromNode, output: tc.fromOutput }, blocks };
    }
    return null;
}

function blendMode(graph, obj) {
    const want = String(obj.node.data.blend || 'auto');
    if (want === 'opaque' || want === 'alpha' || want === 'add') return want;
    const mc = inputConn(graph, obj.node, 'material');
    if (!mc) return 'opaque';
    const src = mc.fromNode;
    if (src.definition && src.definition.isGlassMaterial) return 'alpha';
    if (src.type === 'PBRMaterial' || src.type === 'UnlitMaterial') {
        const ac = inputConn(graph, src, 'alpha');
        if (ac || (Number.isFinite(src.data.alpha) && src.data.alpha < 0.999)) return 'alpha';
    }
    return 'opaque';
}

/**
 * Generate the sources of one object. Returns { vs, fs, shadowVs, uniforms, shadowUniforms,
 * ...meta } or null (errors on the compiler).
 */
function compileObject(compiler, graph, r3, obj, lights, shadowLight, ctx) {
    const node = obj.node;
    const isModel = !!node.definition.isModelNode;
    const geo = geometryOf(graph, obj);
    if (geo.error) { compiler.addError(geo.error, node.id); return null; }
    const points = geo.kind === 'points';
    const lines = geo.kind === 'grid';

    // ---------------- vertex shader
    compiler.reset();
    compiler.compileRoot = r3;
    const cam = cameraExpr(compiler, graph, r3);
    if (cam === null) return null;
    const xf = transformCode(compiler, graph, obj);
    if (xf === null) return null;
    const instConn = inputConn(graph, node, 'instances');
    let inst = DEFAULT_INSTANCE;
    if (instConn) {
        const fn = compileFunction(compiler, graph, node, instConn, { params: INSTANCE_PARAMS, returns: 'Instance', fallback: DEFAULT_INSTANCE },
            remapName(compiler, node, 'instances'), typed(compiler, node, 'instances', 'Instance'));
        if (!fn) return null;
        inst = `${fn}(r3id, r3_count)`;
    }
    const dispConn = inputConn(graph, node, 'displace');
    let disp = '';
    if (dispConn) {
        const fn = compileFunction(compiler, graph, node, dispConn, { params: DISPLACE_PARAMS, returns: 'vec3', fallback: 'vec3(0.0)' },
            remapName(compiler, node, 'displace'), typed(compiler, node, 'displace', 'vec3'));
        if (!fn) return null;
        disp = `r3lp += ${fn}(r3lp, r3ln, a_uv, a_color, r3id, r3_count);`;
    }
    if (compiler.errors.length) return null;
    compiler.usedStructs.add('Instance');
    const vsMain = `#ifdef R3_POINTS
    float r3id = float(gl_VertexID);
#else
    float r3id = float(gl_InstanceID);
#endif
    Camera r3cam = ${cam};
    Instance r3inst = ${inst};
    vec3 r3lp = a_position;
    vec3 r3ln = a_normal;
#ifdef R3_SKIN
    mat4 r3sk = a_weights.x * r3Joint(a_joints.x) + a_weights.y * r3Joint(a_joints.y) + a_weights.z * r3Joint(a_joints.z) + a_weights.w * r3Joint(a_joints.w);
    r3lp = (r3sk * vec4(r3lp, 1.0)).xyz;
    r3ln = mat3(r3sk) * r3ln;
#endif
    ${disp}
    vec3 r3local = r3lp;
    r3lp = (r3_model * vec4(r3lp, 1.0)).xyz;
    r3ln = r3_normalMat * r3ln;
    pt_r3ApplyTRS(r3lp, r3ln, r3inst.position, r3inst.rotation, r3inst.scale);
    ${xf}
    bool r3hide = r3inst.visible <= 0.0 || r3id >= r3_count;
    vec4 r3clip = pt_r3Proj(r3cam.fov, r3_size.x / max(r3_size.y, 1.0), r3_near, r3_far) * pt_r3View(r3cam.position, r3cam.target) * vec4(r3lp, 1.0);
    v_world = r3lp;
    v_normal = r3ln;
    v_uv = a_uv;
    v_color = a_color;
    v_icol = r3inst.color;
    v_inst = r3id;
    v_local = r3local;
    v_camPos = r3cam.position;
    gl_Position = r3hide ? vec4(2.0, 2.0, 2.0, 1.0) : r3clip;`;
    const vsTail = `#ifdef R3_POINTS
    float r3f = 1.0 / tan(radians(clamp(r3cam.fov, 1.0, 179.0)) * 0.5);
    gl_PointSize = r3hide ? 0.0 : clamp(r3_pointSize * abs(r3inst.scale.x) * r3_size.y * 0.5 * r3f / max(r3clip.w, 1e-4), 1.0, 256.0);
#endif`;
    const vs = assemble(compiler, VS_HEAD, VS_FNS, 'void main() {', vsMain, vsTail, ['Camera', 'Instance']);
    const vsUniforms = uniformValues(compiler);

    // ---------------- shadow vertex shader (same transforms, light-space position)
    let shadowVs = null;
    let shadowUniforms = null;
    const casts = !!shadowLight && node.data.castShadow !== false && !points && !lines && blendMode(graph, obj) === 'opaque';
    if (casts) {
        compiler.reset();
        compiler.compileRoot = r3;
        const lsrc = compiler.resolveConnection(shadowLight.conn, graph, r3);
        const xf2 = lsrc ? transformCode(compiler, graph, obj) : null;
        let inst2 = DEFAULT_INSTANCE, disp2 = '';
        let ok = !!lsrc && xf2 !== null;
        if (ok && instConn) {
            const fn = compileFunction(compiler, graph, node, instConn, { params: INSTANCE_PARAMS, returns: 'Instance', fallback: DEFAULT_INSTANCE },
                remapName(compiler, node, 'instances'), typed(compiler, node, 'instances', 'Instance'));
            if (fn) inst2 = `${fn}(r3id, r3_count)`; else ok = false;
        }
        if (ok && dispConn) {
            const fn = compileFunction(compiler, graph, node, dispConn, { params: DISPLACE_PARAMS, returns: 'vec3', fallback: 'vec3(0.0)' },
                remapName(compiler, node, 'displace'), typed(compiler, node, 'displace', 'vec3'));
            if (fn) disp2 = `r3lp += ${fn}(r3lp, r3ln, a_uv, a_color, r3id, r3_count);`; else ok = false;
        }
        if (ok && !compiler.errors.length) {
            compiler.usedStructs.add('Light');
            const main = `float r3id = float(gl_InstanceID);
    Light r3L = ${lsrc.value};
    Instance r3inst = ${inst2};
    vec3 r3lp = a_position;
    vec3 r3ln = a_normal;
#ifdef R3_SKIN
    mat4 r3sk = a_weights.x * r3Joint(a_joints.x) + a_weights.y * r3Joint(a_joints.y) + a_weights.z * r3Joint(a_joints.z) + a_weights.w * r3Joint(a_joints.w);
    r3lp = (r3sk * vec4(r3lp, 1.0)).xyz;
#endif
    ${disp2}
    r3lp = (r3_model * vec4(r3lp, 1.0)).xyz;
    pt_r3ApplyTRS(r3lp, r3ln, r3inst.position, r3inst.rotation, r3inst.scale);
    ${xf2}
    bool r3hide = r3inst.visible <= 0.0 || r3id >= r3_count;
    gl_Position = r3hide ? vec4(2.0, 2.0, 2.0, 1.0) : pt_r3LightMatrix(r3L.direction, r3L.position, r3L.range) * vec4(r3lp, 1.0);`;
            shadowVs = assemble(compiler, VS_HEAD, VS_FNS, 'void main() {', main, '', ['Instance', 'Light']);
            shadowUniforms = uniformValues(compiler);
        } else {
            ctx.warnings.push(`${label(node)}: no shadow (the shadow light or the instances do not compile in a vertex shader)`);
            compiler.errors.length = 0;
        }
    }

    // ---------------- fragment shader
    compiler.reset();
    compiler.compileRoot = r3;
    const lightExprs = [];
    for (const l of lights) {
        const src = compiler.resolveConnection(l.conn, graph, r3);
        if (!src) return null;
        if (src.type !== 'Light') { compiler.addError(`${label(l.node)}: expected a Light, got ${src.type}`, l.node.id); return null; }
        lightExprs.push({ expr: src.value, shadow: l === shadowLight });
    }
    if (!lights.length) {
        lightExprs.push({ expr: DEFAULT_SUN, shadow: false }, { expr: DEFAULT_SKY, shadow: false });
    }
    let matCall;
    const matConn = inputConn(graph, node, 'material');
    if (matConn) {
        const fn = compileFunction(compiler, graph, node, matConn, { params: MATERIAL_PARAMS, returns: 'Material', fallback: DEFAULT_MATERIAL },
            remapName(compiler, node, 'material'), materialConvert(compiler, node));
        if (!fn) return null;
        matCall = fn;
    } else if (isModel) {
        matCall = 'r3FileMaterial';
    } else {
        const fn = compileFunction(compiler, graph, node, null, { params: MATERIAL_PARAMS, returns: 'Material', fallback: DEFAULT_MATERIAL },
            remapName(compiler, node, 'material'), null);
        matCall = fn;
    }
    if (compiler.errors.length) return null;
    compiler.usedStructs.add('Material');
    compiler.usedStructs.add('Light');
    const shadeLines = [];
    lightExprs.forEach((l, k) => {
        shadeLines.push(`Light r3l${k} = ${l.expr};`);
        const sh = l.shadow ? `(r3_shadowOn > 0.5 && r3_receiveShadow > 0.5 ? pt_r3Shadow(r3_shadowMap, v_world, r3N0, r3l${k}, r3_shadowTexel, r3_shadowSoft) : 1.0)` : '1.0';
        shadeLines.push(`r3lit += pt_r3Shade(r3m, r3n, r3Vd, v_world, r3l${k}, ${sh});`);
    });
    const fsMain = `vec3 r3Vd = normalize(v_camPos - v_world);
#ifdef R3_POINTS
    vec3 r3N0 = r3Vd;
    vec2 r3uv = gl_PointCoord;
#else
    vec3 r3N0 = normalize(v_normal);
    if (!gl_FrontFacing) r3N0 = -r3N0;
    vec2 r3uv = v_uv;
#endif
    Material r3m = ${matCall}(v_world, r3N0, r3uv, r3Vd, v_inst, v_icol, v_color, v_local);
    vec3 r3n = dot(r3m.normal, r3m.normal) > 1e-8 ? normalize(r3m.normal) : r3N0;
    vec3 r3col = r3m.emission;
    vec3 r3lit = vec3(0.0);
    float r3a = clamp(r3m.alpha, 0.0, 1.0);
    if (r3m.model > 0.5 && r3m.model < 1.5) {
        r3col += r3m.albedo;
    } else {
        ${shadeLines.join('\n        ')}
        r3col += r3lit;
    }
    if (r3m.model > 2.5) {
        // Glass-lite: reflections stay at full strength over a faint body
        float r3f0 = pow((r3m.params.x - 1.0) / (r3m.params.x + 1.0), 2.0);
        float r3fv = r3f0 + (1.0 - r3f0) * pow(1.0 - clamp(dot(r3n, r3Vd), 0.0, 1.0), 5.0);
        float r3body = r3a;
        r3a = clamp(r3body + r3fv + dot(r3lit, vec3(0.2126, 0.7152, 0.0722)) * 0.5, 0.0, 1.0);
        r3col = (r3col + r3m.extra * r3body * 0.25) / max(r3a, 1e-3);
    }
    float r3dist = length(v_camPos - v_world);
    r3col *= r3_exposure;
    if (r3_fog.a > 0.0) {
        float r3fog = 1.0 - exp(-r3_fog.a * r3_fog.a * r3dist * r3dist);
        // additive objects fade out in the fog (they would add the fog colour twice)
        r3col = r3_additive > 0.5 ? r3col * (1.0 - r3fog) : mix(r3col, r3_tonemap > 0.5 ? pow(r3_fog.rgb, vec3(2.2)) : r3_fog.rgb, r3fog);
    }
    r3col = pt_r3Encode(r3col, r3_tonemap);
    o_color = vec4(r3col * r3a, r3a);
    o_depth = vec4(r3dist, 0.0, 0.0, 1.0);
    o_normal = vec4(r3n, 1.0);`;
    const fsFns = isModel && !matConn ? FILE_MATERIAL : '';
    const fs = assemble(compiler, FS_HEAD, fsFns, 'void main() {', fsMain, '', ['Material', 'Light']);
    const fsUniforms = uniformValues(compiler);

    // ---------------- merged uniforms (a uniform used in both stages is listed once)
    const uniforms = [...vsUniforms];
    const names = new Set(uniforms.map(u => u.name));
    for (const u of fsUniforms) if (!names.has(u.name)) uniforms.push(u);

    return {
        node, kind: isModel ? 'model' : 'mesh', geometryNode: geo.node, geometryKind: geo.kind,
        points, lines, blend: blendMode(graph, obj), cull: String(node.data.cull || 'back'),
        castShadow: !!shadowVs, receiveShadow: node.data.receiveShadow !== false,
        fileMaterial: isModel && !matConn,
        vs, fs, shadowVs, uniforms, shadowUniforms,
        countSpec: countSpec(graph, obj),
        variants: new Map(),
        shadowVariants: new Map(),
    };
}

// ----------------------------------------------------------------------
// Background pass
// ----------------------------------------------------------------------

const BG_VS = `#version 300 es
in vec2 a_position;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

function compileBackground(compiler, graph, r3, ctx) {
    const cc = inputConn(graph, r3, 'background');
    const dc = inputConn(graph, r3, 'bgDepth');
    if (!cc && !dc) return null;
    compiler.reset();
    compiler.compileRoot = r3;
    let color = null;
    if (cc) {
        const src = compiler.resolveConnection(cc, graph, r3);
        if (!src) return null;
        if (src.type === 'sampler2D') {
            compiler.addUniform('u_resolution');
            color = `texture(${src.value}, gl_FragCoord.xy / u_resolution)`;
        } else {
            color = compiler.convertForInput(src.value, src.type, 'vec4', r3);
        }
    } else {
        const c = Array.isArray(r3.data.clearColor) ? r3.data.clearColor : [0, 0, 0, 1];
        color = `vec4(${[0, 1, 2, 3].map(i => Number(c[i] ?? 1).toFixed(5)).join(', ')})`;
    }
    let depth = '1e6';
    let cam = null;
    if (dc) {
        const src = compiler.resolveConnection(dc, graph, r3);
        if (!src) return null;
        depth = compiler.convertForInput(src.value, src.type, 'float', r3);
        cam = cameraExpr(compiler, graph, r3);
        if (cam === null) return null;
    }
    if (compiler.errors.length) return null;
    const depthCode = cam ? `
    Camera r3cam = ${cam};
    vec2 r3p = (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
    float r3t = 1.0 / tan(radians(clamp(r3cam.fov, 1.0, 179.0)) * 0.5);
    vec3 r3rd = normalize(vec3(r3p, -r3t));
    float r3z = r3d * r3rd.z;
    float r3ndc = ((r3_far + r3_near) / (r3_near - r3_far) * r3z + 2.0 * r3_far * r3_near / (r3_near - r3_far)) / max(-r3z, 1e-6);
    gl_FragDepth = r3d >= r3_far ? 1.0 : clamp(r3ndc * 0.5 + 0.5, 0.0, 1.0);` : '\n    gl_FragDepth = 1.0;';
    if (cam) compiler.addUniform('u_resolution');
    const head = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_depth;
layout(location = 2) out vec4 o_normal;
uniform float r3_near;
uniform float r3_far;
uniform vec3 r3_camPos;
uniform vec3 r3_camTarget;
uniform float r3_camFov;
`;
    const main = `vec4 r3c = ${color};
    float r3d = min(max(${depth}, 0.0), r3_far);${depthCode}
    o_color = vec4(r3c.rgb * r3c.a, r3c.a);
    o_depth = vec4(r3d, 0.0, 0.0, 1.0);
    o_normal = vec4(0.0);`;
    if (compiler.sceneSwitchers && compiler.sceneSwitchers.size) {
        ctx.warnings.push(`${label(r3)}.background: Scene Switchers in the background are not supported`);
    }
    const fs = assemble(compiler, head, '', 'void main() {', main, '', cam ? ['Camera'] : []);
    return { vs: BG_VS, fs, uniforms: uniformValues(compiler), depth: !!dc, variants: new Map() };
}

// ----------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------

/**
 * Compile one Render 3D node. Returns { ok, errors, warnings, errorNodeIds, draws, lights,
 * shadowLight, background, outputs, cameraConnected }.
 */
export function compileRender3D(r3, graph, compiler) {
    const ctx = { warnings: [] };
    const result = { ok: true, errors: [], warnings: ctx.warnings, errorNodeIds: [], draws: [], lights: [], shadowLight: null, background: null };
    const scene = collectScene(r3, graph);
    result.errors.push(...scene.errors);
    result.lights = scene.lights;
    result.outputs = usedOutputs(r3, graph);
    result.cameraConnected = !!inputConn(graph, r3, 'camera');
    const shadowLight = scene.lights.find(l => l.node.type === 'DirectionalLight' && l.node.data.castShadow !== false) || null;
    result.shadowLight = shadowLight;
    const savedQuiet = compiler.quiet;
    compiler.quiet = true; // errors are reported on the node (CompilationManager / compile tool)
    try {
        for (const obj of scene.objects) {
            const d = compileObject(compiler, graph, r3, obj, scene.lights, shadowLight, ctx);
            if (!d) {
                result.errors.push(...compiler.errors.map(e => `${label(obj.node)}: ${e}`));
                if (compiler.errorNodeId !== null && compiler.errorNodeId !== undefined) result.errorNodeIds.push(compiler.errorNodeId);
                else result.errorNodeIds.push(obj.node.id);
                continue;
            }
            result.draws.push(d);
        }
        const bg = compileBackground(compiler, graph, r3, ctx);
        if (compiler.errors.length) {
            result.errors.push(...compiler.errors.map(e => `${label(r3)}.background: ${e}`));
            if (compiler.errorNodeId !== null) result.errorNodeIds.push(compiler.errorNodeId);
        } else {
            result.background = bg;
        }
    } catch (e) {
        console.error('[render3d] compile failed', e);
        result.errors.push(`${label(r3)}: ${e.message}`);
    } finally {
        compiler.quiet = savedQuiet;
        compiler.reset();
    }
    result.ok = result.errors.length === 0;
    return result;
}

/** Insert #define lines after the #version line. */
export function withDefines(src, defines) {
    if (!defines || !defines.length) return src.replace('//__DEFINES__\n', '');
    return src.replace('//__DEFINES__', defines.map(d => `#define ${d}`).join('\n'));
}
