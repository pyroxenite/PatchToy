/**
 * Render 3D: rasterized geometry inside one node (node definitions, GLSL library).
 *
 * A Render 3D node is "a 3D scene inside one node": it rasterizes meshes with real
 * vertex / fragment shaders in the shared GL context and outputs textures (color,
 * depth, normal), so everything downstream (effects, Feedback, scenes, Preview) works
 * unchanged. The runtime lives in src/render3d/ (DOM / WebGL); this module only holds
 * the definitions and is safe to import in Node (scripts/check-definitions.mjs).
 *
 * Types:
 *   Geometry   a CPU mesh made by a geometry node (Box Mesh, Sphere Mesh, Model...).
 *              Not a GLSL value: only the Mesh node reads it.
 *   Object3D   something drawn by a Render 3D node: Mesh, Model, Group 3D.
 *   Material   GLSL struct built per fragment by a material sub-graph (PBR Material...)
 *   Light      GLSL struct (Directional / Point / Spot / Ambient Light)
 *   Instance   GLSL struct built per instance by the instances sub-graph
 *
 * Sub-graphs compiled as GLSL functions (functionOf, like Raymarch.sdf):
 *   Mesh.material   Material fn(Surface): runs per fragment; the Surface node reads the
 *                   world position, normal, uv, view direction, instance id / colour,
 *                   vertex colour and local position. A float / vec3 / vec4 wired in
 *                   instead is used as the base colour of the default PBR material.
 *   Mesh.instances  Instance fn(id, count): runs per instance in the vertex shader
 *                   (Instance Index, Instance Data, Make Instance...).
 *   Mesh.displace   vec3 fn(local position, normal, uv, vertex colour, id): vertex offset.
 * Everything else upstream of a Render 3D node (camera, transforms, lights) is compiled
 * into its vertex / fragment shaders as ordinary GLSL, so Params, Time, Beat... animate
 * it without recompiling.
 */
import { libNode } from './define.js';
import { GLSL_LIB } from './glsl.js';
import { TypeRegistry } from '../TypeRegistry.js';

const C = 'render3d';

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

function registerTypes() {
    if (!TypeRegistry.hasType('Geometry')) TypeRegistry.registerSpecialType('Geometry');
    if (!TypeRegistry.hasType('Object3D')) TypeRegistry.registerSpecialType('Object3D');
    if (!TypeRegistry.hasType('Material')) {
        TypeRegistry.registerStruct('Material', [
            { name: 'albedo', type: 'vec3' },
            { name: 'alpha', type: 'float' },
            { name: 'roughness', type: 'float' },
            { name: 'metallic', type: 'float' },
            { name: 'emission', type: 'vec3' },
            { name: 'normal', type: 'vec3' },
            { name: 'model', type: 'float' },     // 0 PBR, 1 unlit, 2 toon, 3 glass
            { name: 'params', type: 'vec4' },     // model parameters (toon bands / rim / gloss, glass ior)
            { name: 'extra', type: 'vec3' }       // toon shade colour, glass tint
        ], 'Surface description returned by a Render 3D material sub-graph');
    }
    if (!TypeRegistry.hasType('Light')) {
        TypeRegistry.registerStruct('Light', [
            { name: 'kind', type: 'float' },      // 0 ambient, 1 directional, 2 point, 3 spot
            { name: 'position', type: 'vec3' },   // point / spot position; directional: shadow centre
            { name: 'direction', type: 'vec3' },  // directional: towards the light; spot: where it points
            { name: 'color', type: 'vec3' },      // ambient: sky colour
            { name: 'intensity', type: 'float' },
            { name: 'range', type: 'float' },     // point / spot reach; directional: shadow half-size
            { name: 'spot', type: 'vec2' },       // cos(inner), cos(outer)
            { name: 'ground', type: 'vec3' },     // ambient: ground colour
            { name: 'shadow', type: 'float' }     // 1 = casts the shadow map
        ], 'A light of a Render 3D scene');
    }
    if (!TypeRegistry.hasType('Instance')) {
        TypeRegistry.registerStruct('Instance', [
            { name: 'position', type: 'vec3' },
            { name: 'rotation', type: 'vec4' },   // quaternion (x, y, z, w)
            { name: 'scale', type: 'vec3' },
            { name: 'color', type: 'vec4' },
            { name: 'visible', type: 'float' }
        ], 'Per-instance transform and colour of an instanced Render 3D mesh');
    }
}
registerTypes();

// ----------------------------------------------------------------------
// Function-input signatures (lambda parameters, see ShaderCompiler.getLambdaParam)
// ----------------------------------------------------------------------

/** Material sub-graph: per fragment. */
export const MATERIAL_PARAMS = [
    { name: 'r3P', type: 'vec3' },   // world position
    { name: 'r3N', type: 'vec3' },   // world normal (towards the viewer on back faces)
    { name: 'r3UV', type: 'vec2' },  // uv (gl_PointCoord for points)
    { name: 'r3V', type: 'vec3' },   // direction towards the camera
    { name: 'r3I', type: 'float' },  // instance id
    { name: 'r3IC', type: 'vec4' },  // instance colour
    { name: 'r3VC', type: 'vec4' },  // vertex colour
    { name: 'r3L', type: 'vec3' }    // local (object space) position
];
/** Instances sub-graph: per instance (vertex shader). */
export const INSTANCE_PARAMS = [
    { name: 'r3id', type: 'float' },
    { name: 'r3n', type: 'float' }
];
/** Displacement sub-graph: per vertex (vertex shader), returns a local-space offset. */
export const DISPLACE_PARAMS = [
    { name: 'r3vP', type: 'vec3' },
    { name: 'r3vN', type: 'vec3' },
    { name: 'r3vUV', type: 'vec2' },
    { name: 'r3vC', type: 'vec4' },
    { name: 'r3id', type: 'float' },
    { name: 'r3n', type: 'float' }
];

export const DEFAULT_MATERIAL = 'Material(vec3(0.8), 1.0, 0.45, 0.0, vec3(0.0), r3N, 0.0, vec4(0.0), vec3(0.0))';
export const DEFAULT_INSTANCE = 'Instance(vec3(0.0), vec4(0.0, 0.0, 0.0, 1.0), vec3(1.0), vec4(1.0), 1.0)';

/** Value of a lambda parameter, or a fallback outside its sub-graph. */
function lp(compiler, name, fallback) {
    return (compiler && compiler.getLambdaParam && compiler.getLambdaParam(name)) || fallback;
}

// ----------------------------------------------------------------------
// GLSL library (pt_r3*): collected like the other pt_* functions
// ----------------------------------------------------------------------

export const R3_GLSL = {
    pt_r3QuatRotate: `vec3 pt_r3QuatRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}`,

    /** Euler angles (radians): rotate around X, then Y, then Z. */
    pt_r3QuatEuler: `vec4 pt_r3QuatEuler(vec3 e) {
    vec3 c = cos(e * 0.5);
    vec3 s = sin(e * 0.5);
    return vec4(s.x * c.y * c.z - c.x * s.y * s.z,
                c.x * s.y * c.z + s.x * c.y * s.z,
                c.x * c.y * s.z - s.x * s.y * c.z,
                c.x * c.y * c.z + s.x * s.y * s.z);
}`,

    pt_r3QuatMul: `vec4 pt_r3QuatMul(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}`,

    /** Rotation whose columns are the orthonormal basis x, y, z. */
    pt_r3QuatBasis: `vec4 pt_r3QuatBasis(vec3 x, vec3 y, vec3 z) {
    float tr = x.x + y.y + z.z;
    vec4 q;
    if (tr > 0.0) {
        float s = sqrt(tr + 1.0) * 2.0;
        q = vec4((y.z - z.y) / s, (z.x - x.z) / s, (x.y - y.x) / s, 0.25 * s);
    } else if (x.x > y.y && x.x > z.z) {
        float s = sqrt(1.0 + x.x - y.y - z.z) * 2.0;
        q = vec4(0.25 * s, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s);
    } else if (y.y > z.z) {
        float s = sqrt(1.0 + y.y - x.x - z.z) * 2.0;
        q = vec4((y.x + x.y) / s, 0.25 * s, (z.y + y.z) / s, (z.x - x.z) / s);
    } else {
        float s = sqrt(1.0 + z.z - x.x - y.y) * 2.0;
        q = vec4((z.x + x.z) / s, (z.y + y.z) / s, 0.25 * s, (x.y - y.x) / s);
    }
    return normalize(q);
}`,

    /** Rotation turning +Z towards forward with +Y towards up (identity for a zero forward). */
    pt_r3QuatLook: `vec4 pt_r3QuatLook(vec3 forward, vec3 up) {
    float l = length(forward);
    if (l < 1e-6) return vec4(0.0, 0.0, 0.0, 1.0);
    vec3 z = forward / l;
    vec3 x = cross(up, z);
    if (dot(x, x) < 1e-8) x = cross(abs(z.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), z);
    x = normalize(x);
    vec3 y = cross(z, x);
    return pt_r3QuatBasis(x, y, z);
}`,

    /** p, n through translate * rotate * scale (normals by the inverse transpose). */
    pt_r3ApplyTRS: `void pt_r3ApplyTRS(inout vec3 p, inout vec3 n, vec3 t, vec4 q, vec3 s) {
    p = pt_r3QuatRotate(q, p * s) + t;
    n = pt_r3QuatRotate(q, n / max(abs(s), vec3(1e-6)) * sign(s + 1e-12));
}`,

    /** World -> view matrix of the camera convention of pt_cameraRayDir (looks along -Z). */
    pt_r3View: `mat4 pt_r3View(vec3 ro, vec3 ta) {
    vec3 ww = normalize(ta - ro + vec3(0.0, 0.0, 1e-6));
    vec3 up = abs(ww.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 uu = normalize(cross(ww, up));
    vec3 vv = cross(uu, ww);
    return mat4(uu.x, vv.x, -ww.x, 0.0,
                uu.y, vv.y, -ww.y, 0.0,
                uu.z, vv.z, -ww.z, 0.0,
                -dot(uu, ro), -dot(vv, ro), dot(ww, ro), 1.0);
}`,

    /** Perspective projection; fov = vertical field of view in degrees (as Camera.fov). */
    pt_r3Proj: `mat4 pt_r3Proj(float fovDeg, float aspect, float n, float f) {
    float t = 1.0 / tan(radians(clamp(fovDeg, 1.0, 179.0)) * 0.5);
    return mat4(t / aspect, 0.0, 0.0, 0.0,
                0.0, t, 0.0, 0.0,
                0.0, 0.0, (f + n) / (n - f), -1.0,
                0.0, 0.0, 2.0 * f * n / (n - f), 0.0);
}`,

    /** View-projection of a directional light's shadow map: ortho box of half-size h around c. */
    pt_r3LightMatrix: `mat4 pt_r3LightMatrix(vec3 dirToLight, vec3 c, float h) {
    vec3 ld = normalize(dirToLight + vec3(1e-6, 0.0, 0.0));
    float hs = max(h, 0.01);
    mat4 v = pt_r3View(c + ld * hs * 2.0, c);
    float f = hs * 4.0;
    mat4 p = mat4(1.0 / hs, 0.0, 0.0, 0.0,
                  0.0, 1.0 / hs, 0.0, 0.0,
                  0.0, 0.0, -2.0 / f, 0.0,
                  0.0, 0.0, -1.0, 1.0);
    return p * v;
}`,

    pt_r3Fresnel: `vec3 pt_r3Fresnel(vec3 f0, float c) {
    return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}`,

    /** GGX specular D * V (Smith-Schlick visibility), per unit NoL. */
    pt_r3Spec: `float pt_r3Spec(float NoH, float NoV, float NoL, float rough) {
    float a = max(rough * rough, 0.002);
    float a2 = a * a;
    float d = NoH * NoH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * d * d);
    float k = a * 0.5;
    float V = 0.25 / ((NoV * (1.0 - k) + k) * (NoL * (1.0 - k) + k) + 1e-5);
    return D * V;
}`,

    /** Hemisphere sky reflection used by the ambient light (rough = blurrier horizon). */
    pt_r3Sky: `vec3 pt_r3Sky(vec3 dir, vec3 sky, vec3 ground, float rough) {
    float w = 0.12 + rough * 0.6;
    float t = smoothstep(-w, w, dir.y);
    vec3 c = mix(ground, sky, t);
    c += sky * 0.6 * smoothstep(0.0, 1.0, 1.0 - abs(dir.y) * 6.0) * (1.0 - rough);
    return c;
}`,

    /** Light reaching a surface point from one light (direction L, radiance), per material model. */
    pt_r3Surface: `vec3 pt_r3Surface(Material m, vec3 N, vec3 V, vec3 L, vec3 radiance) {
    float NoL = dot(N, L);
    if (m.model > 1.5 && m.model < 2.5) {
        float bands = max(m.params.x, 1.0);
        float x = clamp(NoL * 0.5 + 0.5, 0.0, 1.0) * bands;
        float q = (floor(x) + smoothstep(0.42, 0.58, fract(x))) / bands;
        vec3 H = normalize(V + L);
        float gloss = m.params.z;
        float sp = smoothstep(0.0, 0.04, dot(N, H) - (1.0 - 0.06 * gloss)) * gloss;
        return (mix(m.extra, m.albedo, q) + sp) * radiance / 3.14159265;
    }
    if (NoL <= 0.0) return vec3(0.0);
    vec3 H = normalize(V + L);
    float NoV = max(dot(N, V), 1e-4);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    vec3 f0 = mix(vec3(0.04), m.albedo, m.metallic);
    if (m.model > 2.5) f0 = vec3(pow((m.params.x - 1.0) / (m.params.x + 1.0), 2.0));
    vec3 F = pt_r3Fresnel(f0, VoH);
    vec3 spec = F * pt_r3Spec(NoH, NoV, NoL, m.roughness);
    vec3 diff = (1.0 - F) * (1.0 - m.metallic) * m.albedo / 3.14159265;
    if (m.model > 2.5) diff = vec3(0.0);
    return (diff + spec) * radiance * NoL;
}`,

    /** Ambient / hemisphere light: diffuse irradiance + sky reflections. */
    pt_r3Ambient: `vec3 pt_r3Ambient(Material m, vec3 N, vec3 V, Light l) {
    vec3 sky = l.color * l.intensity;
    vec3 ground = l.ground * l.intensity;
    vec3 irr = mix(ground, sky, N.y * 0.5 + 0.5);
    float NoV = max(dot(N, V), 1e-4);
    if (m.model > 1.5 && m.model < 2.5) {
        float rim = pow(1.0 - NoV, 3.0) * m.params.y;
        return mix(m.extra, m.albedo, 0.5) * irr * 0.6 + rim * sky;
    }
    vec3 f0 = mix(vec3(0.04), m.albedo, m.metallic);
    if (m.model > 2.5) f0 = vec3(pow((m.params.x - 1.0) / (m.params.x + 1.0), 2.0));
    vec3 F = f0 + (max(vec3(1.0 - m.roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
    vec3 R = reflect(-V, N);
    vec3 env = pt_r3Sky(R, sky, ground, m.roughness);
    vec3 diff = irr * m.albedo * (1.0 - m.metallic) * (1.0 - F);
    if (m.model > 2.5) diff = vec3(0.0);
    float ao = m.model < 0.5 ? 1.0 - clamp(m.params.w, 0.0, 1.0) : 1.0;
    return (diff + env * F * (1.0 - 0.5 * m.roughness)) * ao;
}`,

    /** One light of any kind (shadow = shadow-map visibility for the shadow-casting light). */
    pt_r3Shade: `vec3 pt_r3Shade(Material m, vec3 N, vec3 V, vec3 P, Light l, float shadow) {
    if (l.kind < 0.5) return pt_r3Ambient(m, N, V, l);
    vec3 rad = l.color * l.intensity;
    if (l.kind < 1.5) return pt_r3Surface(m, N, V, normalize(l.direction), rad * shadow);
    vec3 D = l.position - P;
    float d2 = max(dot(D, D), 1e-6);
    float d = sqrt(d2);
    vec3 L = D / d;
    float r = max(l.range, 1e-3);
    float win = clamp(1.0 - pow(d / r, 4.0), 0.0, 1.0);
    float att = win * win / (d2 + 1.0);
    if (l.kind > 2.5) att *= smoothstep(l.spot.y, l.spot.x, dot(-L, normalize(l.direction)));
    return pt_r3Surface(m, N, V, L, rad * att * shadow);
}`,

    /** Soft PCF lookup of the directional shadow map (texel = 1 / shadow map size). */
    pt_r3Shadow: `float pt_r3Shadow(highp sampler2DShadow sm, vec3 P, vec3 N, Light l, float texel, float soft) {
    vec3 ld = normalize(l.direction + vec3(1e-6, 0.0, 0.0));
    float hs = max(l.range, 0.01);
    float ndl = clamp(dot(N, ld), 0.0, 1.0);
    vec3 Pn = P + N * (hs * texel * 3.0) * (1.5 - ndl);
    vec4 c = pt_r3LightMatrix(l.direction, l.position, l.range) * vec4(Pn, 1.0);
    vec3 s = c.xyz / c.w * 0.5 + 0.5;
    if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
    float z = s.z - 0.0008;
    float r = texel * max(soft, 0.0) * 1.6;
    float sum = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            sum += texture(sm, vec3(s.xy + vec2(float(x), float(y)) * r, z));
        }
    }
    return sum / 9.0;
}`,

    /** Output encoding of Render 3D (mode 0 linear, 1 gamma 2.2 keeping HDR, 2 ACES filmic + gamma). */
    pt_r3Encode: `vec3 pt_r3Encode(vec3 c, float mode) {
    c = max(c, vec3(0.0));
    if (mode < 0.5) return c;
    if (mode > 1.5) {
        c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
    }
    return pow(c, vec3(1.0 / 2.2));
}`,

    /** Thin-film interference colour (soap bubble / oil slick) for a view cosine. */
    pt_r3ThinFilm: `vec3 pt_r3ThinFilm(float cosTheta, float thicknessNm, float filmIor) {
    float n = max(filmIor, 1.0);
    float sinT2 = (1.0 - cosTheta * cosTheta) / (n * n);
    float cosT = sqrt(max(1.0 - sinT2, 0.0));
    float opd = 2.0 * n * max(thicknessNm, 0.0) * cosT;
    vec3 phase = 6.28318531 * opd / vec3(650.0, 540.0, 450.0);
    return 0.5 + 0.5 * cos(phase + 3.14159265);
}`,

    /** Texel of instance id in a W x H texture holding `blocks` stacked attribute blocks. */
    pt_r3InstanceTexel: `ivec2 pt_r3InstanceTexel(ivec2 size, float id, int blocks, int block) {
    int w = max(size.x, 1);
    int h = max(size.y / max(blocks, 1), 1);
    int i = int(id + 0.5);
    return ivec2(i % w, (i / w) % h + block * h);
}`
};
Object.assign(GLSL_LIB, R3_GLSL);

// ----------------------------------------------------------------------
// Node helpers
// ----------------------------------------------------------------------

/** A geometry node: params are CPU values (inline fields, or a control-rate cable). */
function geometry(kind, description, params, extra = {}) {
    const data = {};
    for (const p of params) data[p.name] = p.default;
    return {
        category: C,
        description,
        inputs: params.map(p => ({ name: p.name, type: 'float', default: String(p.default), cpuInput: true, description: p.description })),
        outputs: [{ name: 'geometry', type: 'Geometry' }],
        data: { ...data, ...(extra.data || {}) },
        hasInputFields: true,
        inlineInputs: true,
        isLibraryNode: true,
        isGeometryNode: true,
        geometryKind: kind,
        geometryParams: params,
        glsl: () => ({ code: '', output: '0.0' }),
        ...(extra.def || {})
    };
}

// ----------------------------------------------------------------------
// Definitions
// ----------------------------------------------------------------------

const ITEM_DESC = 'A Mesh, Model, Group 3D or light to draw (connecting the last free input adds one)';

export const Render3DNodes = {
    'Render3D': {
        category: C,
        displayTitle: 'Render 3D',
        description: 'A 3D scene inside one node: rasterizes the connected Meshes / Models / Groups with real vertex and fragment shaders and outputs textures: color (HDR rgba16f, premultiplied by alpha = coverage), depth (r = distance from the camera along the view ray, the same units as Raymarch.t; data.far where nothing was drawn) and normal (xyz = world normal, a = 1 where drawn). Lights: Directional (one soft shadow map), Point, Spot, Ambient; without lights a default sun + sky is used. Camera: CameraObject / OrbitalCamera, or (unconnected) drag on the preview to orbit and scroll to zoom. data.size "auto" follows the output being shown (aspect + render quality scale, up to data.maxSize px), "fixed" uses data.width x height; data.msaa 0 | 2 | 4, data.near / far, data.fog (density, fog colour = background), data.exposure, data.tonemap: gamma (default: linear light x exposure encoded with gamma 2.2 like Raymarch.color, values above 1 kept for bloom) | aces (filmic, 0..1) | linear (raw HDR).',
        inputs: [
            { name: 'camera', type: 'Camera', description: 'Camera struct (CameraObject, OrbitalCamera). Unconnected: drag the preview to orbit, scroll to zoom' },
            { name: 'background', type: 'vec4', default: 'vec4(0.035, 0.04, 0.055, 1.0)', description: 'Drawn behind the objects: a colour, or any image (data.clearColor when unconnected)' },
            { name: 'bgDepth', type: 'float', default: '1e6', description: 'Distance along the view ray of the background (e.g. Raymarch.t): objects behind it are hidden (raster x raymarch compositing)' },
            { name: 'item1', type: 'any', description: ITEM_DESC }
        ],
        outputs: [
            { name: 'color', type: 'sampler2D', description: 'Rendered image (HDR, premultiplied alpha)' },
            { name: 'depth', type: 'sampler2D', description: 'r = distance from the camera (Raymarch.t units), data.far where empty' },
            { name: 'normal', type: 'sampler2D', description: 'World normal (xyz), a = 1 where drawn' }
        ],
        data: {
            size: 'auto', width: 1280, height: 800, maxSize: 1920, msaa: 4,
            near: 0.05, far: 200, fog: 0, exposure: 1, tonemap: 'gamma',
            clearColor: [0.035, 0.04, 0.055, 1],
            shadowRes: 2048,
            items: 1,
            orbit: { yaw: 0.6, pitch: 0.35, distance: 5, target: [0, 0, 0], fov: 45 }
        },
        isRender3D: true,
        isTextureSourceNode: true, // ShaderCompiler: compiled as texture uniforms, inputs are not traversed
        glsl: (node) => {
            const v = node.varName;
            const uniforms = [];
            node.outputVars = {};
            for (const name of ['color', 'depth', 'normal']) {
                // Bound like JS node textures (FeedbackRenderer.injectFeedbackTextures: getTexture / liveTexture)
                uniforms.push({ name: `${v}_${name}`, type: 'sampler2D', value: 0, jsTextureNodeId: node.id, jsTextureOutput: name });
                node.outputVars[name] = `${v}_${name}`;
            }
            return { code: '', output: `${v}_color`, uniforms };
        }
    },

    'Mesh': {
        category: C,
        description: 'A drawable object for Render 3D: geometry + material + transform, optionally instanced. material is a sub-graph evaluated per fragment (PBR / Unlit / Toon / Iridescent / Glass Material, or any colour, which becomes the base colour of the default PBR material); the Surface node gives it the world position, normal, uv, view direction, instance id / colour and vertex colour. instances is a sub-graph evaluated per instance in the vertex shader (Instance Index, Instance Data / Instances From Texture for Feedback or JS data textures, Make Instance); count = number of instances (0 = from the instance texture / grid, else 1). displace = per-vertex offset sub-graph (Surface: local position, normal, uv, vertex colour; Instance Index). rotation is Euler radians (X, then Y, then Z). data.castShadow / receiveShadow, data.cull back | front | none, data.blend auto | opaque | alpha | add (alpha / add draw after the opaque objects without writing depth), data.pointSize (Points Mesh, world units).',
        inputs: [
            { name: 'geometry', type: 'Geometry', description: 'Box / Sphere / Torus / Plane / Grid / Cylinder / ... Mesh (default: a box)' },
            { name: 'material', type: 'Material', default: DEFAULT_MATERIAL, functionOf: { params: MATERIAL_PARAMS, returns: 'Material' }, description: 'Material sub-graph (per fragment); a colour works too' },
            { name: 'position', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'rotation', type: 'vec3', default: 'vec3(0.0)', description: 'Euler angles, radians' },
            { name: 'scale', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'instances', type: 'Instance', default: DEFAULT_INSTANCE, functionOf: { params: INSTANCE_PARAMS, returns: 'Instance' }, description: 'Per-instance sub-graph (vertex shader)' },
            { name: 'count', type: 'float', default: '0.0', cpuInput: true, description: 'Instances to draw (0 = automatic)' },
            { name: 'displace', type: 'vec3', default: 'vec3(0.0)', functionOf: { params: DISPLACE_PARAMS, returns: 'vec3' }, description: 'Per-vertex local offset sub-graph' }
        ],
        outputs: [{ name: 'object', type: 'Object3D' }],
        data: { count: 0, castShadow: true, receiveShadow: true, cull: 'back', blend: 'auto', pointSize: 0.05 },
        hasInputFields: true,
        inlineInputs: true,
        isLibraryNode: true,
        isRender3DObject: true,
        glsl: () => ({ code: '', output: '0.0' })
    },

    'Group3D': {
        category: C,
        displayTitle: 'Group 3D',
        description: 'Combines up to four Meshes / Models / Groups / lights and moves them together (position, Euler rotation in radians, scale; lights pass through untransformed). Groups nest.',
        inputs: [
            { name: 'a', type: 'any', description: 'Mesh, Model, Group 3D or light' },
            { name: 'b', type: 'any' },
            { name: 'c', type: 'any' },
            { name: 'd', type: 'any' },
            { name: 'position', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'rotation', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'scale', type: 'vec3', default: 'vec3(1.0)' }
        ],
        outputs: [{ name: 'object', type: 'Object3D' }],
        isLibraryNode: true,
        inlineInputs: true,
        isRender3DGroup: true,
        glsl: () => ({ code: '', output: '0.0' })
    },

    'Model': {
        category: C,
        description: 'A glTF 2.0 model (.glb / .gltf with embedded data): meshes with their node hierarchy and transforms, PBR metal / rough materials (base colour, normal, metal / rough, emissive and occlusion textures, alpha mask / blend), skinning and animation clips. Drop a .glb on the canvas, double-click to pick a file, or set data.src to a URL / data URL (MCP: load_model). clip = animation index (-1 = none), time = clip time in seconds (wire Beat.time to dance on the beat), material overrides the file materials when connected. Models up to ~15 MB are stored in the project as a data URL. Draco / meshopt compressed files are not supported.',
        inputs: [
            { name: 'position', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'rotation', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'scale', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'material', type: 'Material', default: '', functionOf: { params: MATERIAL_PARAMS, returns: 'Material' }, description: 'Optional material sub-graph replacing the file materials' },
            { name: 'instances', type: 'Instance', default: DEFAULT_INSTANCE, functionOf: { params: INSTANCE_PARAMS, returns: 'Instance' } },
            { name: 'count', type: 'float', default: '0.0', cpuInput: true },
            { name: 'clip', type: 'float', default: '0.0', cpuInput: true, description: 'Animation clip index (-1 = rest pose)' },
            { name: 'time', type: 'float', default: 'u_time', cpuInput: true, description: 'Clip time (seconds, loops)' }
        ],
        outputs: [{ name: 'object', type: 'Object3D' }],
        data: { src: '', name: '', count: 0, clip: 0, fit: 0, castShadow: true, receiveShadow: true, blend: 'auto', cull: 'back' },
        hasInputFields: true,
        inlineInputs: true,
        isLibraryNode: true,
        isRender3DObject: true,
        isModelNode: true,
        glsl: () => ({ code: '', output: '0.0' })
    },

    // ---------------------------------------------------------------- geometry
    'BoxMesh': geometry('box', 'Box geometry for a Mesh (width x height x depth, segments per edge).', [
        { name: 'width', default: 1 }, { name: 'height', default: 1 }, { name: 'depth', default: 1 }, { name: 'segments', default: 1 }
    ]),
    'SphereMesh': geometry('sphere', 'UV sphere geometry for a Mesh.', [
        { name: 'radius', default: 0.75 }, { name: 'segments', default: 48 }, { name: 'rings', default: 24 }
    ]),
    'TorusMesh': geometry('torus', 'Torus (donut) geometry for a Mesh, lying in the XZ plane.', [
        { name: 'radius', default: 0.7 }, { name: 'tube', default: 0.25 }, { name: 'segments', default: 64 }, { name: 'sides', default: 24 }
    ]),
    'PlaneMesh': geometry('plane', 'Flat plane geometry in the XZ plane facing +Y (a floor), subdivided for displacement.', [
        { name: 'width', default: 10 }, { name: 'depth', default: 10 }, { name: 'segments', default: 1 }
    ]),
    'GridMesh': geometry('grid', 'Line grid in the XZ plane (drawn as lines): a floor grid.', [
        { name: 'width', default: 10 }, { name: 'depth', default: 10 }, { name: 'divisions', default: 20 }
    ]),
    'CylinderMesh': geometry('cylinder', 'Capped cylinder / cone geometry along Y (top radius 0 = cone).', [
        { name: 'radius', default: 0.5 }, { name: 'topRadius', default: 0.5 }, { name: 'height', default: 1.5 }, { name: 'segments', default: 40 }
    ]),
    'TorusKnotMesh': geometry('torusknot', 'Torus knot geometry (p, q windings).', [
        { name: 'radius', default: 0.8 }, { name: 'tube', default: 0.22 }, { name: 'p', default: 2 }, { name: 'q', default: 3 }, { name: 'segments', default: 256 }, { name: 'sides', default: 20 }
    ]),
    'BirdMesh': geometry('bird', 'A small low-poly bird (body along +Z, wings along X) for flocks. Vertex colour a = signed wing weight (0 on the body, +-1 at the wing tips): displace by Surface.vertexColor.a to flap the wings.', [
        { name: 'size', default: 1 }, { name: 'span', default: 1 }
    ]),
    'TextMesh': geometry('text', 'Extruded 3D text for a Mesh: the text (data.text, \\n for new lines) is rasterized with the pixel font at resolution pixels per line and every filled pixel run is extruded depth deep (a crisp voxel look). size = line height, centred on the origin, facing +Z.', [
        { name: 'size', default: 1 }, { name: 'depth', default: 0.25 }, { name: 'resolution', default: 40 }
    ], { def: { textFields: [{ key: 'text', label: 'text', default: 'PatchToy' }] }, data: { text: 'PatchToy' } }),
    'PointsMesh': geometry('points', 'Point sprites: one point per instance (no vertex buffer; drawn with gl.POINTS, size = Mesh data.pointSize in world units x instance scale.x). Use Surface.uv (gl_PointCoord) in the material for round sprites. The cheapest way to draw 100k - 1M particles.', []),

    // ---------------------------------------------------------------- materials
    'PBRMaterial': libNode({
        category: C,
        displayTitle: 'PBR Material',
        description: 'Physically based metal / rough material for a Mesh (wire into Mesh.material). Inputs may use the Surface node (world position, normal, uv, view, instance colour...).',
        inputs: [
            { name: 'baseColor', type: 'vec3', default: 'vec3(0.8)' },
            { name: 'roughness', type: 'float', default: '0.45' },
            { name: 'metallic', type: 'float', default: '0.0' },
            { name: 'emission', type: 'vec3', default: 'vec3(0.0)', description: 'Added light (HDR, feeds bloom)' },
            { name: 'alpha', type: 'float', default: '1.0', description: 'Opacity (< 1 draws blended when Mesh data.blend = auto)' },
            { name: 'normal', type: 'vec3', default: '@n', description: 'Shading normal (default: the surface normal)' }
        ],
        outputs: [{ name: 'material', type: 'Material' }],
        expr: (I, { compiler }) => {
            const n = I.normal === '@n' ? lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)') : I.normal;
            return `Material(${I.baseColor}, ${I.alpha}, clamp(${I.roughness}, 0.02, 1.0), clamp(${I.metallic}, 0.0, 1.0), ${I.emission}, ${n}, 0.0, vec4(0.0), vec3(0.0))`;
        }
    }),
    'UnlitMaterial': libNode({
        category: C,
        description: 'Unlit material: the colour as is (plus alpha), no lighting or shadows. Good for glowing particles and lines.',
        inputs: [
            { name: 'color', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'alpha', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'material', type: 'Material' }],
        expr: (I, { compiler }) => `Material(${I.color}, ${I.alpha}, 1.0, 0.0, vec3(0.0), ${lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)')}, 1.0, vec4(0.0), vec3(0.0))`
    }),
    'ToonMaterial': libNode({
        category: C,
        description: 'Cel-shaded material: bands of lighting between shade and color, a rim light and a crisp highlight.',
        inputs: [
            { name: 'color', type: 'vec3', default: 'vec3(0.95, 0.55, 0.35)' },
            { name: 'shade', type: 'vec3', default: 'vec3(0.25, 0.12, 0.3)', description: 'Colour of the unlit side' },
            { name: 'bands', type: 'float', default: '3.0' },
            { name: 'rim', type: 'float', default: '0.6' },
            { name: 'gloss', type: 'float', default: '0.6' }
        ],
        outputs: [{ name: 'material', type: 'Material' }],
        expr: (I, { compiler }) => `Material(${I.color}, 1.0, 0.6, 0.0, vec3(0.0), ${lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)')}, 2.0, vec4(${I.bands}, ${I.rim}, ${I.gloss}, 0.0), ${I.shade})`
    }),
    'IridescentMaterial': libNode({
        category: C,
        description: 'Thin-film iridescence (soap bubble, oil slick, beetle shell): the colour shifts with the viewing angle. thickness in nanometres (wire noise into it for swirls).',
        inputs: [
            { name: 'base', type: 'vec3', default: 'vec3(0.05, 0.05, 0.08)' },
            { name: 'thickness', type: 'float', default: '480.0' },
            { name: 'filmIor', type: 'float', default: '1.35' },
            { name: 'strength', type: 'float', default: '1.0' },
            { name: 'roughness', type: 'float', default: '0.22' },
            { name: 'metallic', type: 'float', default: '0.85' }
        ],
        outputs: [{ name: 'material', type: 'Material' }],
        body: (I, { v, compiler }) => {
            const N = lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)');
            const V = lp(compiler, 'r3V', 'vec3(0.0, 0.0, 1.0)');
            return {
                code: `vec3 ${v}_film = pt_r3ThinFilm(clamp(dot(${N}, ${V}), 0.0, 1.0), ${I.thickness}, ${I.filmIor});`,
                out: { material: `Material(mix(${I.base}, ${v}_film, clamp(${I.strength}, 0.0, 1.0)), 1.0, clamp(${I.roughness}, 0.02, 1.0), clamp(${I.metallic}, 0.0, 1.0), vec3(0.0), ${N}, 0.0, vec4(0.0), vec3(0.0))` }
            };
        }
    }),
    'GlassMaterial': libNode({
        category: C,
        description: 'Glass-lite: Fresnel reflections of the sky and light highlights over a faint tinted body, drawn blended after the opaque objects (no refraction of what is behind).',
        inputs: [
            { name: 'tint', type: 'vec3', default: 'vec3(0.85, 0.95, 1.0)' },
            { name: 'ior', type: 'float', default: '1.45' },
            { name: 'roughness', type: 'float', default: '0.04' },
            { name: 'opacity', type: 'float', default: '0.12', description: 'Body opacity (reflections add on top)' }
        ],
        outputs: [{ name: 'material', type: 'Material' }],
        expr: (I, { compiler }) => `Material(${I.tint}, clamp(${I.opacity}, 0.0, 1.0), clamp(${I.roughness}, 0.02, 1.0), 0.0, vec3(0.0), ${lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)')}, 3.0, vec4(max(${I.ior}, 1.0), 0.0, 0.0, 0.0), ${I.tint})`,
        isGlassMaterial: true
    }),

    'Surface': libNode({
        category: C,
        description: 'Surface data inside a Render 3D sub-graph. In Mesh.material (per fragment): world position, normal, uv (gl_PointCoord for points), view (towards the camera), instanceId, instanceColor, vertexColor, localPosition, distance (to the camera). In Mesh.displace (per vertex): local position, normal, uv, vertex colour and instance id.',
        inputs: [],
        outputs: [
            { name: 'position', type: 'vec3' },
            { name: 'normal', type: 'vec3' },
            { name: 'uv', type: 'vec2' },
            { name: 'view', type: 'vec3' },
            { name: 'instanceId', type: 'float' },
            { name: 'instanceColor', type: 'vec4' },
            { name: 'vertexColor', type: 'vec4' },
            { name: 'localPosition', type: 'vec3' },
            { name: 'distance', type: 'float' }
        ],
        body: (I, { compiler }) => {
            const vs = !!lp(compiler, 'r3vP', null) && !lp(compiler, 'r3P', null);
            if (vs) {
                return {
                    out: {
                        position: lp(compiler, 'r3vP'), normal: lp(compiler, 'r3vN'), uv: lp(compiler, 'r3vUV'), view: 'vec3(0.0, 0.0, 1.0)',
                        instanceId: lp(compiler, 'r3id', '0.0'), instanceColor: 'vec4(1.0)', vertexColor: lp(compiler, 'r3vC'),
                        localPosition: lp(compiler, 'r3vP'), distance: '0.0'
                    }
                };
            }
            const P = lp(compiler, 'r3P', 'vec3(pt_centeredUV(), 0.0)');
            const V = lp(compiler, 'r3V', 'vec3(0.0, 0.0, 1.0)');
            return {
                out: {
                    position: P,
                    normal: lp(compiler, 'r3N', 'vec3(0.0, 0.0, 1.0)'),
                    uv: lp(compiler, 'r3UV', 'pt_uvStretch()'),
                    view: V,
                    instanceId: lp(compiler, 'r3I', lp(compiler, 'r3id', '0.0')),
                    instanceColor: lp(compiler, 'r3IC', 'vec4(1.0)'),
                    vertexColor: lp(compiler, 'r3VC', 'vec4(1.0)'),
                    localPosition: lp(compiler, 'r3L', P),
                    distance: lp(compiler, 'r3P', null) ? `length(v_camPos - ${P})` : '0.0'
                }
            };
        }
    }),

    // ---------------------------------------------------------------- instances
    'InstanceIndex': libNode({
        category: C,
        description: 'Inside Mesh.instances / Mesh.displace: id = instance number (0 .. count-1), count, t = id / (count - 1), random = a stable 0..1 hash of id.',
        inputs: [],
        outputs: [
            { name: 'id', type: 'float' },
            { name: 'count', type: 'float' },
            { name: 't', type: 'float' },
            { name: 'random', type: 'float' }
        ],
        body: (I, { compiler }) => {
            const id = lp(compiler, 'r3id', '0.0');
            const n = lp(compiler, 'r3n', '1.0');
            return { out: { id, count: n, t: `(${id} / max(${n} - 1.0, 1.0))`, random: `pt_hash11(${id} * 1.618 + 0.37)` } };
        }
    }),
    'MakeInstance': libNode({
        category: C,
        description: 'Builds one instance for Mesh.instances: position, rotation (Euler radians), forward (when connected, turns the mesh +Z along it with +Y towards up: velocity alignment), scale, color (Surface.instanceColor in the material) and visible (0 hides it).',
        inputs: [
            { name: 'position', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'rotation', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'forward', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'up', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' },
            { name: 'scale', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'color', type: 'vec4', default: 'vec4(1.0)' },
            { name: 'visible', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'instance', type: 'Instance' }],
        expr: (I, { types }) => {
            const rotDefault = I.rotation === 'vec3(0.0)' && !types.rotation;
            let q = rotDefault ? 'vec4(0.0, 0.0, 0.0, 1.0)' : `pt_r3QuatEuler(${I.rotation})`;
            if (types.forward) q = rotDefault ? `pt_r3QuatLook(${I.forward}, ${I.up})` : `pt_r3QuatMul(pt_r3QuatLook(${I.forward}, ${I.up}), ${q})`;
            return `Instance(${I.position}, ${q}, ${I.scale}, ${I.color}, ${I.visible})`;
        }
    }),
    'InstanceData': libNode({
        category: C,
        description: 'Reads this instance\'s texels from a data texture (a Feedback simulation, a JS dataTexture...): instance i is texel (i mod W, i div W) of each of `blocks` attribute blocks stacked vertically (block k = rows k*H/blocks .. ). b0..b3 = the texel of block 0..3. Mesh.count 0 = W x H / blocks instances.',
        inputs: [
            { name: 'texture', type: 'sampler2D' },
            { name: 'blocks', type: 'float', default: '1.0' }
        ],
        outputs: [
            { name: 'b0', type: 'vec4' },
            { name: 'b1', type: 'vec4' },
            { name: 'b2', type: 'vec4' },
            { name: 'b3', type: 'vec4' }
        ],
        isInstanceSource: true,
        body: (I, { v, compiler, types }) => {
            const id = lp(compiler, 'r3id', '0.0');
            if (!types.texture) return { out: { b0: 'vec4(0.0)', b1: 'vec4(0.0)', b2: 'vec4(0.0)', b3: 'vec4(0.0)' } };
            const code = [
                `ivec2 ${v}_sz = textureSize(${I.texture}, 0);`,
                `int ${v}_nb = int(max(${I.blocks}, 1.0));`
            ].join('\n');
            const fetch = k => `(${v}_nb > ${k} ? texelFetch(${I.texture}, pt_r3InstanceTexel(${v}_sz, ${id}, ${v}_nb, ${k}), 0) : vec4(0.0))`;
            return { code, out: { b0: `texelFetch(${I.texture}, pt_r3InstanceTexel(${v}_sz, ${id}, ${v}_nb, 0), 0)`, b1: fetch(1), b2: fetch(2), b3: fetch(3) } };
        }
    }),
    'InstancesFromTexture': libNode({
        category: C,
        description: 'Instances straight from a data texture (see Instance Data for the layout): position = block 0 xyz (w x scale when scaleFromW is 1), forward = block 1 xyz (velocity: the mesh turns along it, blocks >= 2), colour = block 2 x color (blocks >= 3). Wire into Mesh.instances; Mesh.count 0 draws W x H / blocks instances.',
        inputs: [
            { name: 'texture', type: 'sampler2D' },
            { name: 'blocks', type: 'float', default: '1.0' },
            { name: 'scale', type: 'float', default: '0.1' },
            { name: 'scaleFromW', type: 'float', default: '0.0' },
            { name: 'color', type: 'vec4', default: 'vec4(1.0)' }
        ],
        outputs: [{ name: 'instance', type: 'Instance' }],
        isInstanceSource: true,
        body: (I, { v, compiler, types }) => {
            const id = lp(compiler, 'r3id', '0.0');
            if (!types.texture) return { out: { instance: `Instance(vec3(0.0), vec4(0.0, 0.0, 0.0, 1.0), vec3(${I.scale}), ${I.color}, 1.0)` } };
            const code = [
                `ivec2 ${v}_sz = textureSize(${I.texture}, 0);`,
                `int ${v}_nb = int(max(${I.blocks}, 1.0));`,
                `vec4 ${v}_p = texelFetch(${I.texture}, pt_r3InstanceTexel(${v}_sz, ${id}, ${v}_nb, 0), 0);`,
                `vec4 ${v}_f = ${v}_nb > 1 ? texelFetch(${I.texture}, pt_r3InstanceTexel(${v}_sz, ${id}, ${v}_nb, 1), 0) : vec4(0.0);`,
                `vec4 ${v}_c = ${v}_nb > 2 ? texelFetch(${I.texture}, pt_r3InstanceTexel(${v}_sz, ${id}, ${v}_nb, 2), 0) : vec4(1.0);`,
                `float ${v}_s = ${I.scale} * (${I.scaleFromW} > 0.5 ? ${v}_p.w : 1.0);`
            ].join('\n');
            return { code, out: { instance: `Instance(${v}_p.xyz, pt_r3QuatLook(${v}_f.xyz, vec3(0.0, 1.0, 0.0)), vec3(${v}_s), ${v}_c * ${I.color}, 1.0)` } };
        }
    }),
    'InstanceGrid': libNode({
        category: C,
        description: 'Inside Mesh.instances: lays instances out on an nx x ny x nz grid centred on the origin, spacing apart. position = this instance\'s cell centre, cell = its cell coordinates in 0..1. Mesh.count 0 = nx x ny x nz.',
        inputs: [
            { name: 'nx', type: 'float', default: '10.0' },
            { name: 'ny', type: 'float', default: '1.0' },
            { name: 'nz', type: 'float', default: '10.0' },
            { name: 'spacing', type: 'float', default: '1.0' }
        ],
        outputs: [
            { name: 'position', type: 'vec3' },
            { name: 'cell', type: 'vec3' }
        ],
        isInstanceSource: true,
        body: (I, { v, compiler }) => {
            const id = lp(compiler, 'r3id', '0.0');
            return {
                code: [
                    `vec3 ${v}_n = max(floor(vec3(${I.nx}, ${I.ny}, ${I.nz}) + 0.5), vec3(1.0));`,
                    `float ${v}_i = floor(${id} + 0.5);`,
                    `vec3 ${v}_g = vec3(mod(${v}_i, ${v}_n.x), mod(floor(${v}_i / (${v}_n.x * ${v}_n.z)), ${v}_n.y), mod(floor(${v}_i / ${v}_n.x), ${v}_n.z));`
                ].join('\n'),
                out: {
                    position: `(${v}_g - (${v}_n - 1.0) * 0.5) * ${I.spacing}`,
                    cell: `${v}_g / max(${v}_n - 1.0, vec3(1.0))`
                }
            };
        }
    }),

    // ---------------------------------------------------------------- lights
    'DirectionalLight': libNode({
        category: C,
        description: 'Sun light for Render 3D: parallel rays from direction (towards the light). data.castShadow = true renders a soft PCF shadow map covering a box of half-size shadowSize around shadowCenter (one shadow-casting light per scene; data.softness widens the penumbra).',
        inputs: [
            { name: 'direction', type: 'vec3', default: 'vec3(0.5, 1.0, 0.35)', description: 'Direction towards the light' },
            { name: 'color', type: 'vec3', default: 'vec3(1.0, 0.96, 0.9)' },
            { name: 'intensity', type: 'float', default: '3.0' },
            { name: 'shadowCenter', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'shadowSize', type: 'float', default: '6.0', description: 'Half-size of the shadowed box' }
        ],
        outputs: [{ name: 'light', type: 'Light' }],
        data: { castShadow: true, softness: 1.0 },
        isLight: true,
        expr: (I, { data }) => `Light(1.0, ${I.shadowCenter}, normalize(${I.direction}), ${I.color}, ${I.intensity}, ${I.shadowSize}, vec2(0.0), vec3(0.0), ${data.castShadow === false ? '0.0' : '1.0'})`
    }),
    'PointLight': libNode({
        category: C,
        description: 'Point light for Render 3D: inverse-square falloff that fades to 0 at range.',
        inputs: [
            { name: 'position', type: 'vec3', default: 'vec3(0.0, 2.0, 0.0)' },
            { name: 'color', type: 'vec3', default: 'vec3(1.0, 0.85, 0.6)' },
            { name: 'intensity', type: 'float', default: '12.0' },
            { name: 'range', type: 'float', default: '10.0' }
        ],
        outputs: [{ name: 'light', type: 'Light' }],
        isLight: true,
        expr: I => `Light(2.0, ${I.position}, vec3(0.0, -1.0, 0.0), ${I.color}, ${I.intensity}, ${I.range}, vec2(0.0), vec3(0.0), 0.0)`
    }),
    'SpotLight': libNode({
        category: C,
        description: 'Spot light for Render 3D: a cone from position towards target, angle = half-angle in degrees, softness = fraction of the cone that fades.',
        inputs: [
            { name: 'position', type: 'vec3', default: 'vec3(0.0, 4.0, 2.0)' },
            { name: 'target', type: 'vec3', default: 'vec3(0.0)' },
            { name: 'color', type: 'vec3', default: 'vec3(1.0)' },
            { name: 'intensity', type: 'float', default: '30.0' },
            { name: 'range', type: 'float', default: '15.0' },
            { name: 'angle', type: 'float', default: '30.0' },
            { name: 'softness', type: 'float', default: '0.3' }
        ],
        outputs: [{ name: 'light', type: 'Light' }],
        isLight: true,
        expr: I => `Light(3.0, ${I.position}, normalize(${I.target} - ${I.position} + vec3(0.0, 1e-5, 0.0)), ${I.color}, ${I.intensity}, ${I.range}, vec2(cos(radians(${I.angle}) * (1.0 - clamp(${I.softness}, 0.0, 1.0))), cos(radians(${I.angle}))), vec3(0.0), 0.0)`
    }),
    'AmbientLight': libNode({
        category: C,
        description: 'Ambient / environment light for Render 3D: a sky over ground hemisphere that lights every surface softly and is reflected by shiny materials.',
        inputs: [
            { name: 'sky', type: 'vec3', default: 'vec3(0.38, 0.45, 0.6)' },
            { name: 'ground', type: 'vec3', default: 'vec3(0.12, 0.1, 0.09)' },
            { name: 'intensity', type: 'float', default: '1.0' }
        ],
        outputs: [{ name: 'light', type: 'Light' }],
        isLight: true,
        expr: I => `Light(0.0, vec3(0.0), vec3(0.0, 1.0, 0.0), ${I.sky}, ${I.intensity}, 0.0, vec2(0.0), ${I.ground}, 0.0)`
    })
};
