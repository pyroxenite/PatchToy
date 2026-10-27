/**
 * 3D signed distance fields and raymarching.
 *
 * How a scene works: the Raymarch node's `sdf` input is compiled into a GLSL
 * function `float scene(vec3 p)`. Every node upstream of that input runs once
 * per march step with its own `p`: 3D primitives and domain ops whose `p`
 * input is left unconnected automatically use the scene point (or connect a
 * ScenePoint node explicitly). Combine primitives with the SDF* operators
 * (shape category), e.g. Sphere + Plane -> SDFSmoothUnion -> Raymarch.sdf.
 *
 * Outside a scene (e.g. previewing a Sphere directly) `p` falls back to a z = 0
 * slice of the screen, so the preview shows a distance-field cross-section.
 */
import { libNode, SCENE_P } from './define.js';

const C = 'sdf3d';
const P = { name: 'p', type: 'vec3', default: SCENE_P, description: '3D sample point (default: the scene point)' };
const CENTER3 = { name: 'center', type: 'vec3', default: 'vec3(0.0)' };
const DEFAULT_CAMERA = 'Camera(vec3(0.0, 1.0, 4.5), vec3(0.0), 45.0)';
const DEFAULT_LIGHT = 'normalize(vec3(0.6, 0.8, 0.4))';

/**
 * Optional raster depth (Render 3D depth texture, r = distance along the view ray): the march
 * limit becomes min(maxDist, raster depth) at this pixel. The texture covers the screen, so
 * the centered uv maps back to it (x / aspect).
 */
function rasterDepth(I, v, types) {
    if (!types || !types.depth) return { code: [], max: I.maxDist, under: false };
    return {
        code: [
            `vec2 ${v}_suv = ${I.uv} * vec2(u_resolution.y / u_resolution.x, 1.0) * 0.5 + 0.5;`,
            `float ${v}_rz = texture(${I.depth}, ${v}_suv).r;`
        ],
        max: `min(${I.maxDist}, ${v}_rz)`,
        under: !!types.under
    };
}

function prim(description, params, dist) {
    return libNode({
        category: C,
        description,
        inputs: [P, CENTER3, ...params],
        outputs: [{ name: 'd', type: 'float' }],
        body: (I, { v }) => ({
            code: `vec3 ${v}_q = ${I.p} - ${I.center};`,
            out: { d: dist(I, v) }
        })
    });
}

export const SDF3DNodes = {
    'ScenePoint': libNode({
        category: C,
        description: 'The 3D point p being evaluated inside a Raymarch scene (outside a scene: a z=0 slice of the screen).',
        inputs: [],
        outputs: [{ name: 'p', type: 'vec3' }],
        body: (I, { compiler }) => ({
            out: { p: (compiler && compiler.getLambdaParam && compiler.getLambdaParam('p')) || 'vec3(pt_centeredUV() * 2.0, 0.0)' }
        })
    }),

    'Sphere': prim('Sphere SDF.', [{ name: 'radius', type: 'float', default: '1.0' }],
        (I, v) => `length(${v}_q) - ${I.radius}`),

    'Box': prim('Box SDF; size is the full width / height / depth, round rounds the edges.',
        [{ name: 'size', type: 'vec3', default: 'vec3(1.5)' }, { name: 'round', type: 'float', default: '0.0' }],
        (I, v) => `pt_sdBox3(${v}_q, max(${I.size} * 0.5 - vec3(${I.round}), vec3(0.0))) - ${I.round}`),

    'Torus': prim('Torus (donut) SDF lying in the XZ plane: radius = ring radius, thickness = tube radius.',
        [{ name: 'radius', type: 'float', default: '1.0' }, { name: 'thickness', type: 'float', default: '0.3' }],
        (I, v) => `pt_sdTorus(${v}_q, ${I.radius}, ${I.thickness})`),

    'Cylinder': prim('Capped vertical cylinder SDF (height = full height along Y).',
        [{ name: 'height', type: 'float', default: '1.5' }, { name: 'radius', type: 'float', default: '0.5' }],
        (I, v) => `pt_sdCylinder(${v}_q, ${I.height} * 0.5, ${I.radius})`),

    'Capsule': libNode({
        category: C,
        description: 'Capsule SDF: a segment from a to b with radius.',
        inputs: [
            P,
            { name: 'a', type: 'vec3', default: 'vec3(0.0, -0.6, 0.0)' },
            { name: 'b', type: 'vec3', default: 'vec3(0.0, 0.6, 0.0)' },
            { name: 'radius', type: 'float', default: '0.4' }
        ],
        outputs: [{ name: 'd', type: 'float' }],
        expr: I => `pt_sdCapsule(${I.p}, ${I.a}, ${I.b}, ${I.radius})`
    }),

    'Plane': libNode({
        category: C,
        description: 'Infinite plane SDF with the given normal; height moves it along the normal (default: a floor at y = -1).',
        inputs: [
            P,
            { name: 'normal', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' },
            { name: 'height', type: 'float', default: '-1.0' }
        ],
        outputs: [{ name: 'd', type: 'float' }],
        expr: I => `dot(${I.p}, normalize(${I.normal})) - ${I.height}`
    }),

    'Translate3D': libNode({
        category: C,
        description: 'Moves a 3D shape by offset (feed the result into a primitive\'s p).',
        inputs: [P, { name: 'offset', type: 'vec3', default: 'vec3(0.0, 0.5, 0.0)' }],
        outputs: [{ name: 'p', type: 'vec3' }],
        expr: I => `${I.p} - ${I.offset}`
    }),

    'Rotate3D': libNode({
        category: C,
        description: 'Rotates a 3D shape around axis by angle (radians) (feed the result into a primitive\'s p).',
        inputs: [
            P,
            { name: 'axis', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' },
            { name: 'angle', type: 'float', default: '0.785' }
        ],
        outputs: [{ name: 'p', type: 'vec3' }],
        expr: I => `pt_rotateAxis(${I.p}, ${I.axis}, -${I.angle})`
    }),

    'Repeat3D': libNode({
        category: C,
        description: 'Infinitely repeats space every `spacing` units per axis (0 = no repeat on that axis).',
        inputs: [P, { name: 'spacing', type: 'vec3', default: 'vec3(3.0, 0.0, 3.0)' }],
        outputs: [{ name: 'p', type: 'vec3' }],
        body: (I, { v }) => ({
            code: [
                `vec3 ${v}_s = ${I.spacing};`,
                `vec3 ${v}_r = ${I.p} - ${v}_s * round(${I.p} / max(abs(${v}_s), vec3(1e-4)));`
            ].join('\n'),
            out: { p: `mix(${I.p}, ${v}_r, step(vec3(1e-4), abs(${v}_s)))` }
        })
    }),

    'CameraRay': libNode({
        category: C,
        description: 'Primary ray for a camera: ro = origin, rd = normalized direction (uv = centered coords, see CenteredUV.p).',
        inputs: [
            { name: 'camera', type: 'Camera', default: DEFAULT_CAMERA },
            { name: 'uv', type: 'vec2', default: 'pt_centeredUV()' }
        ],
        outputs: [
            { name: 'ro', type: 'vec3' },
            { name: 'rd', type: 'vec3' },
            { name: 'ray', type: 'Ray' }
        ],
        body: (I, { v, compiler }) => {
            if (compiler && compiler.usedStructs) compiler.usedStructs.add('Ray');
            return {
                code: `Camera ${v}_cam = ${I.camera};`,
                out: {
                    ro: `${v}_cam.position`,
                    rd: `pt_cameraRayDir(${v}_cam.position, ${v}_cam.target, ${v}_cam.fov, ${I.uv})`,
                    ray: `Ray(${v}_cam.position, pt_cameraRayDir(${v}_cam.position, ${v}_cam.target, ${v}_cam.fov, ${I.uv}))`
                }
            };
        }
    }),

    'Raymarch': libNode({
        category: C,
        description: 'Sphere-traces a 3D SDF scene. Connect any distance graph to sdf (unconnected primitives use the scene point). color = ready-made shaded image; hit/t/p/n/ao/shadow/rd for custom shading. Raster compositing: wire a Render 3D depth into depth (same camera) and rays stop at its surfaces; also wire its color into under and color shows the rasterized objects where they are nearer (t = the nearer distance).',
        inputs: [
            {
                name: 'sdf', type: 'float', default: 'min(length(p) - 1.0, p.y + 1.0)',
                functionOf: { params: [{ name: 'p', type: 'vec3' }], returns: 'float' },
                description: 'Scene distance, evaluated per step with the scene point p'
            },
            { name: 'camera', type: 'Camera', default: DEFAULT_CAMERA },
            { name: 'uv', type: 'vec2', default: 'pt_centeredUV()', description: 'Centered coords (CenteredUV.p)' },
            { name: 'light', type: 'vec3', default: DEFAULT_LIGHT, description: 'Direction towards the light' },
            { name: 'steps', type: 'int', default: '96' },
            { name: 'maxDist', type: 'float', default: '40.0' },
            { name: 'depth', type: 'sampler2D', description: 'Optional Render 3D depth: rays stop at the rasterized surfaces (same camera)' },
            { name: 'under', type: 'sampler2D', description: 'Optional Render 3D color, shown where the rasterized surface is nearer' }
        ],
        outputs: [
            { name: 'color', type: 'vec3', description: 'Shaded image (gamma corrected)' },
            { name: 'hit', type: 'float', description: '1 where a surface was hit' },
            { name: 't', type: 'float', description: 'Distance along the ray' },
            { name: 'p', type: 'vec3', description: 'Hit position' },
            { name: 'n', type: 'vec3', description: 'Surface normal (0 where nothing was hit)' },
            { name: 'ao', type: 'float', description: 'Ambient occlusion (1 = open)' },
            { name: 'shadow', type: 'float', description: 'Soft shadow towards light (1 = lit)' },
            { name: 'rd', type: 'vec3', description: 'Ray direction' }
        ],
        body: (I, { v, types }) => {
            const scene = I.sdf; // generated function name: float scene(vec3 p)
            // Raster x raymarch (Render 3D): its depth texture = distance along the same rays (= t)
            const rz = rasterDepth(I, v, types);
            const preamble = `
vec3 ${v}_fnMarch(vec3 ro, vec3 rd, int maxSteps, float maxDist) {
    float t = 0.0;
    float hit = 0.0;
    float steps = 0.0;
    for (int i = 0; i < 512; i++) {
        if (i >= maxSteps) break;
        float d = ${scene}(ro + rd * t);
        if (abs(d) < 0.0005 * (1.0 + t)) {
            hit = 1.0;
            break;
        }
        t += d * 0.9;
        steps += 1.0;
        if (t > maxDist) break;
    }
    return vec3(min(t, maxDist), hit, steps);
}

vec3 ${v}_fnNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * ${scene}(p + k.xyy * h) +
                     k.yyx * ${scene}(p + k.yyx * h) +
                     k.yxy * ${scene}(p + k.yxy * h) +
                     k.xxx * ${scene}(p + k.xxx * h));
}

float ${v}_fnAO(vec3 p, vec3 n) {
    float occ = 0.0;
    float sca = 1.0;
    for (int i = 0; i < 5; i++) {
        float h = 0.01 + 0.12 * float(i) / 4.0;
        occ += (h - ${scene}(p + h * n)) * sca;
        sca *= 0.95;
    }
    return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}

float ${v}_fnShadow(vec3 ro, vec3 rd) {
    float res = 1.0;
    float t = 0.02;
    for (int i = 0; i < 48; i++) {
        float h = ${scene}(ro + rd * t);
        res = min(res, 8.0 * h / t);
        t += clamp(h, 0.02, 0.25);
        if (res < 0.002 || t > 12.0) break;
    }
    return clamp(res, 0.0, 1.0);
}`;
            const code = [
                `Camera ${v}_cam = ${I.camera};`,
                `vec3 ${v}_ro = ${v}_cam.position;`,
                `vec3 ${v}_rdir = pt_cameraRayDir(${v}_cam.position, ${v}_cam.target, ${v}_cam.fov, ${I.uv});`,
                ...rz.code,
                `vec3 ${v}_m = ${v}_fnMarch(${v}_ro, ${v}_rdir, ${I.steps}, ${rz.max});`,
                `vec3 ${v}_pos = ${v}_ro + ${v}_rdir * ${v}_m.x;`,
                `vec3 ${v}_nrm = ${v}_fnNormal(${v}_pos);`,
                `vec3 ${v}_lig = normalize(${I.light});`,
                `float ${v}_occ = ${v}_m.y > 0.5 ? ${v}_fnAO(${v}_pos, ${v}_nrm) : 1.0;`,
                `float ${v}_sha = ${v}_m.y > 0.5 ? ${v}_fnShadow(${v}_pos + ${v}_nrm * 0.002, ${v}_lig) : 1.0;`,
                `float ${v}_dif = clamp(dot(${v}_nrm, ${v}_lig), 0.0, 1.0) * ${v}_sha;`,
                `float ${v}_spe = pow(clamp(dot(reflect(${v}_rdir, ${v}_nrm), ${v}_lig), 0.0, 1.0), 32.0) * ${v}_sha;`,
                `vec3 ${v}_bg = mix(vec3(0.07, 0.08, 0.11), vec3(0.32, 0.38, 0.5), clamp(${v}_rdir.y * 0.5 + 0.5, 0.0, 1.0));`,
                `vec3 ${v}_col = vec3(0.8) * (${v}_dif * vec3(1.0, 0.95, 0.85) + (0.5 + 0.5 * ${v}_nrm.y) * vec3(0.18, 0.22, 0.3) * ${v}_occ) + 0.4 * ${v}_spe;`,
                `${v}_col = mix(${v}_col, ${v}_bg, 1.0 - exp(-0.003 * ${v}_m.x * ${v}_m.x));`,
                `${v}_col = mix(${v}_bg, ${v}_col, ${v}_m.y);`,
                ...(rz.under ? [`if (${v}_m.y < 0.5 && ${v}_rz < ${I.maxDist}) { vec4 ${v}_un = texture(${I.under}, ${v}_suv); ${v}_col = mix(${v}_col, pow(max(${v}_un.rgb / max(${v}_un.a, 1e-4), vec3(0.0)), vec3(2.2)), clamp(${v}_un.a, 0.0, 1.0)); }`] : [])
            ].join('\n');
            return {
                code,
                preamble,
                out: {
                    color: `pow(clamp(${v}_col, 0.0, 1.0), vec3(0.4545))`,
                    hit: `${v}_m.y`,
                    t: `${v}_m.x`,
                    p: `${v}_pos`,
                    n: `${v}_nrm * ${v}_m.y`,
                    ao: `${v}_occ`,
                    shadow: `${v}_sha`,
                    rd: `${v}_rdir`
                }
            };
        }
    }),

    'GlassRaymarch': libNode({
        category: C,
        description: 'Traces a ray through a glass SDF: it refracts in, marches the interior, exits, and can re-enter other parts of the object (total internal reflection, Beer absorption). Feed exitP + exitR/G/B into an environment for dispersive refraction.',
        inputs: [
            {
                name: 'sdf', type: 'float', default: 'length(p) - 1.0',
                functionOf: { params: [{ name: 'p', type: 'vec3' }], returns: 'float' },
                description: 'Glass object distance, evaluated with the scene point p'
            },
            { name: 'camera', type: 'Camera', default: DEFAULT_CAMERA },
            { name: 'uv', type: 'vec2', default: 'pt_centeredUV()', description: 'Centered coords (CenteredUV.p)' },
            { name: 'ior', type: 'float', default: '1.45', description: 'Index of refraction (green)' },
            { name: 'dispersion', type: 'float', default: '0.04', description: 'IOR spread between red and blue' },
            { name: 'absorb', type: 'vec3', default: 'vec3(0.04, 0.1, 0.02)', description: 'Beer absorption per unit travelled inside' },
            { name: 'bounces', type: 'int', default: '6', description: 'Max interface crossings after the first hit' },
            { name: 'steps', type: 'int', default: '96' },
            { name: 'maxDist', type: 'float', default: '30.0' },
            { name: 'depth', type: 'sampler2D', description: 'Optional Render 3D depth: the glass is only hit in front of the rasterized surfaces' }
        ],
        outputs: [
            { name: 'hit', type: 'float', description: '1 where the glass was hit' },
            { name: 't', type: 'float', description: 'Distance to the first hit' },
            { name: 'p', type: 'vec3', description: 'First hit position' },
            { name: 'n', type: 'vec3', description: 'Normal at the first hit (0 on a miss)' },
            { name: 'rd', type: 'vec3', description: 'Camera ray direction' },
            { name: 'refl', type: 'vec3', description: 'Reflected direction at the first hit' },
            { name: 'fresnel', type: 'float', description: 'Schlick reflectance at the first hit' },
            { name: 'exitP', type: 'vec3', description: 'Where the ray finally leaves the glass' },
            { name: 'exitR', type: 'vec3', description: 'Exit direction for red' },
            { name: 'exitG', type: 'vec3', description: 'Exit direction for green' },
            { name: 'exitB', type: 'vec3', description: 'Exit direction for blue' },
            { name: 'transmit', type: 'vec3', description: 'Light that makes it through (absorption + interface losses)' },
            { name: 'passes', type: 'float', description: 'Number of glass surfaces crossed' }
        ],
        body: (I, { v, types }) => {
            const scene = I.sdf; // generated function name: float scene(vec3 p)
            const rz = rasterDepth(I, v, types);
            const preamble = `
vec2 ${v}_fnHit(vec3 ro, vec3 rd, int maxSteps, float maxDist) {
    float t = 0.0;
    for (int i = 0; i < 512; i++) {
        if (i >= maxSteps) break;
        float d = ${scene}(ro + rd * t);
        if (d < 0.0005 * (1.0 + t)) return vec2(t, 1.0);
        t += d * 0.9;
        if (t > maxDist) break;
    }
    return vec2(maxDist, 0.0);
}

// March inside the glass (distance = -sdf) until the surface is reached from within
vec2 ${v}_fnExit(vec3 ro, vec3 rd, int maxSteps, float maxDist) {
    float t = 0.0;
    for (int i = 0; i < 512; i++) {
        if (i >= maxSteps) break;
        float d = -${scene}(ro + rd * t);
        if (d < 0.0005) return vec2(t, 1.0);
        t += max(d * 0.9, 0.002);
        if (t > maxDist) break;
    }
    return vec2(t, 0.0);
}

vec3 ${v}_fnNormal(vec3 p) {
    const vec2 k = vec2(1.0, -1.0);
    const float h = 0.0005;
    return normalize(k.xyy * ${scene}(p + k.xyy * h) +
                     k.yyx * ${scene}(p + k.yyx * h) +
                     k.yxy * ${scene}(p + k.yxy * h) +
                     k.xxx * ${scene}(p + k.xxx * h));
}`;
            const code = `Camera ${v}_cam = ${I.camera};
    vec3 ${v}_ro = ${v}_cam.position;
    vec3 ${v}_rdir = pt_cameraRayDir(${v}_cam.position, ${v}_cam.target, ${v}_cam.fov, ${I.uv});
    float ${v}_ior = max(${I.ior}, 1.0001);
    ${rz.code.join('\n    ')}
    vec2 ${v}_h = ${v}_fnHit(${v}_ro, ${v}_rdir, ${I.steps}, ${rz.max});
    vec3 ${v}_pos = ${v}_ro + ${v}_rdir * ${v}_h.x;
    vec3 ${v}_nrm = ${v}_fnNormal(${v}_pos);
    float ${v}_r0 = pow((${v}_ior - 1.0) / (${v}_ior + 1.0), 2.0);
    float ${v}_fres = ${v}_r0 + (1.0 - ${v}_r0) * pow(1.0 - clamp(dot(-${v}_rdir, ${v}_nrm), 0.0, 1.0), 5.0);
    vec3 ${v}_P = ${v}_pos;
    vec3 ${v}_D = refract(${v}_rdir, ${v}_nrm, 1.0 / ${v}_ior);
    vec3 ${v}_lastN = ${v}_nrm;
    vec3 ${v}_din = ${v}_D;
    vec3 ${v}_nout = ${v}_nrm;
    float ${v}_inside = 1.0;
    float ${v}_npass = 1.0;
    vec3 ${v}_tr = vec3(1.0 - ${v}_fres);
    vec3 ${v}_xR = ${v}_rdir;
    vec3 ${v}_xG = ${v}_rdir;
    vec3 ${v}_xB = ${v}_rdir;
    if (${v}_h.y > 0.5) {
        for (int b = 0; b < 16; b++) {
            if (b >= ${I.bounces}) break;
            if (${v}_inside > 0.5) {
                vec3 st = ${v}_P - ${v}_lastN * 0.003;
                vec2 e = ${v}_fnExit(st, ${v}_D, ${I.steps}, ${I.maxDist} * 0.5);
                ${v}_P = st + ${v}_D * e.x;
                ${v}_tr *= exp(-${I.absorb} * e.x);
                vec3 n2 = ${v}_fnNormal(${v}_P);
                vec3 o = refract(${v}_D, -n2, ${v}_ior);
                ${v}_lastN = n2;
                if (dot(o, o) < 1e-6) {
                    ${v}_D = reflect(${v}_D, -n2);   // total internal reflection: stay inside
                    continue;
                }
                ${v}_din = ${v}_D;
                ${v}_nout = n2;
                ${v}_D = o;
                ${v}_inside = 0.0;
                ${v}_npass += 1.0;
            } else {
                vec3 st = ${v}_P + ${v}_lastN * 0.003;
                vec2 h2 = ${v}_fnHit(st, ${v}_D, ${I.steps}, ${I.maxDist});
                if (h2.y < 0.5) break;               // escaped: done
                ${v}_P = st + ${v}_D * h2.x;
                vec3 n3 = ${v}_fnNormal(${v}_P);
                float f3 = ${v}_r0 + (1.0 - ${v}_r0) * pow(1.0 - clamp(dot(-${v}_D, n3), 0.0, 1.0), 5.0);
                ${v}_tr *= 1.0 - f3;
                ${v}_D = refract(${v}_D, n3, 1.0 / ${v}_ior);
                ${v}_lastN = n3;
                ${v}_inside = 1.0;
                ${v}_npass += 1.0;
            }
        }
        if (${v}_inside < 0.5) {
            // Dispersion: split the last exit by wavelength
            vec3 r = refract(${v}_din, -${v}_nout, ${v}_ior - ${I.dispersion});
            vec3 bl = refract(${v}_din, -${v}_nout, ${v}_ior + ${I.dispersion});
            ${v}_xG = ${v}_D;
            ${v}_xR = dot(r, r) > 1e-6 ? r : ${v}_D;
            ${v}_xB = dot(bl, bl) > 1e-6 ? bl : ${v}_D;
        } else {
            // Still trapped after the last bounce: let it out dimmed
            ${v}_xR = ${v}_D; ${v}_xG = ${v}_D; ${v}_xB = ${v}_D;
            ${v}_tr *= 0.35;
        }
    }`;
            return {
                code,
                preamble,
                out: {
                    hit: `${v}_h.y`,
                    t: `${v}_h.x`,
                    p: `${v}_pos`,
                    n: `${v}_nrm * ${v}_h.y`,
                    rd: `${v}_rdir`,
                    refl: `reflect(${v}_rdir, ${v}_nrm)`,
                    fresnel: `${v}_fres * ${v}_h.y`,
                    exitP: `${v}_P`,
                    exitR: `${v}_xR`,
                    exitG: `${v}_xG`,
                    exitB: `${v}_xB`,
                    transmit: `${v}_tr`,
                    passes: `${v}_npass * ${v}_h.y`
                }
            };
        }
    }),

    'Lambert': libNode({
        category: C,
        description: 'Diffuse lighting term: max(dot(n, light), 0).',
        inputs: [
            { name: 'n', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)', description: 'Surface normal' },
            { name: 'light', type: 'vec3', default: DEFAULT_LIGHT, description: 'Direction towards the light' }
        ],
        outputs: [{ name: 'diffuse', type: 'float' }],
        expr: I => `max(dot(pt_safeNormalize(${I.n}), pt_safeNormalize(${I.light})), 0.0)`
    }),

    'BlinnPhong': libNode({
        category: C,
        description: 'Specular highlight (Blinn-Phong). v = direction towards the viewer (e.g. -rd).',
        inputs: [
            { name: 'n', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' },
            { name: 'light', type: 'vec3', default: DEFAULT_LIGHT },
            { name: 'v', type: 'vec3', default: 'vec3(0.0, 0.0, 1.0)' },
            { name: 'shininess', type: 'float', default: '32.0' }
        ],
        outputs: [{ name: 'specular', type: 'float' }],
        expr: I => `pow(max(dot(pt_safeNormalize(${I.n}), pt_safeNormalize(pt_safeNormalize(${I.light}) + pt_safeNormalize(${I.v}))), 0.0), ${I.shininess})`
    }),

    'Fresnel': libNode({
        category: C,
        description: 'Fresnel / rim term: bright where the surface faces away from the viewer. v = direction towards the viewer (e.g. -rd).',
        inputs: [
            { name: 'n', type: 'vec3', default: 'vec3(0.0, 1.0, 0.0)' },
            { name: 'v', type: 'vec3', default: 'vec3(0.0, 0.0, 1.0)' },
            { name: 'power', type: 'float', default: '5.0' }
        ],
        outputs: [{ name: 'fresnel', type: 'float' }],
        expr: I => `pow(1.0 - clamp(dot(pt_safeNormalize(${I.n}), pt_safeNormalize(${I.v})), 0.0, 1.0), ${I.power})`
    })
};
