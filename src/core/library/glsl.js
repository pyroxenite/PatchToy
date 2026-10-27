/**
 * Shared GLSL function library for the built-in node library.
 *
 * Every function is prefixed `pt_` and has a unique name (GLSL overloads would
 * collide with the compiler's per-name de-duplication). Node definitions never
 * list dependencies by hand: `collectLibrary(code)` scans generated code for
 * `pt_*` identifiers and returns the needed functions in dependency order, so
 * each shared function is emitted exactly once per shader.
 *
 * Functions may reference the built-in uniforms (u_resolution, u_time, ...);
 * the node helper detects those and declares them.
 */

export const GLSL_LIB = {
    // ------------------------------------------------------------------
    // Coordinates
    // ------------------------------------------------------------------

    /** Aspect-correct UV: (0.5, 0.5) at the center, short axis spans [0, 1]. */
    pt_uv: `vec2 pt_uv() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float aspect = u_resolution.x / u_resolution.y;
    if (aspect > 1.0) {
        uv.x = (uv.x - 0.5) * aspect + 0.5;
    } else {
        uv.y = (uv.y - 0.5) / aspect + 0.5;
    }
    return uv;
}`,

    /** Stretched UV: (0,0) bottom-left, (1,1) top-right. */
    pt_uvStretch: `vec2 pt_uvStretch() {
    return gl_FragCoord.xy / u_resolution;
}`,

    /** Centered coordinates: (0,0) at the center, y spans [-1, 1]. */
    pt_centeredUV: `vec2 pt_centeredUV() {
    return (2.0 * gl_FragCoord.xy - u_resolution) / u_resolution.y;
}`,

    pt_rot2: `mat2 pt_rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, s, -s, c);
}`,

    /** Rodrigues rotation of p around axis by angle (radians). */
    pt_rotateAxis: `vec3 pt_rotateAxis(vec3 p, vec3 axis, float angle) {
    vec3 k = length(axis) > 1e-6 ? normalize(axis) : vec3(0.0, 1.0, 0.0);
    float c = cos(angle);
    float s = sin(angle);
    return p * c + cross(k, p) * s + k * dot(k, p) * (1.0 - c);
}`,

    // ------------------------------------------------------------------
    // Hashes (Dave Hoskins, "Hash without Sine", MIT)
    // ------------------------------------------------------------------

    pt_hash11: `float pt_hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}`,

    pt_hash12: `float pt_hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}`,

    pt_hash13: `float pt_hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}`,

    pt_hash22: `vec2 pt_hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}`,

    pt_hash33: `vec3 pt_hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}`,

    // ------------------------------------------------------------------
    // Noise. pt_perlin2 / pt_perlin3 / pt_simplex2 / pt_fbm2 return ~[-1, 1].
    // ------------------------------------------------------------------

    pt_valueNoise2: `float pt_valueNoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = pt_hash12(i);
    float b = pt_hash12(i + vec2(1.0, 0.0));
    float c = pt_hash12(i + vec2(0.0, 1.0));
    float d = pt_hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,

    pt_grad2: `float pt_grad2(vec2 cell, vec2 offset, vec2 f) {
    float a = 6.2831853 * pt_hash12(cell + offset);
    return dot(vec2(cos(a), sin(a)), f - offset);
}`,

    pt_perlin2: `float pt_perlin2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = pt_grad2(i, vec2(0.0, 0.0), f);
    float b = pt_grad2(i, vec2(1.0, 0.0), f);
    float c = pt_grad2(i, vec2(0.0, 1.0), f);
    float d = pt_grad2(i, vec2(1.0, 1.0), f);
    return 1.4142 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`,

    pt_grad3: `float pt_grad3(vec3 cell, vec3 offset, vec3 f) {
    vec3 g = normalize(pt_hash33(cell + offset) * 2.0 - 1.0 + vec3(1e-6));
    return dot(g, f - offset);
}`,

    pt_perlin3: `float pt_perlin3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = pt_grad3(i, vec3(0.0, 0.0, 0.0), f);
    float n100 = pt_grad3(i, vec3(1.0, 0.0, 0.0), f);
    float n010 = pt_grad3(i, vec3(0.0, 1.0, 0.0), f);
    float n110 = pt_grad3(i, vec3(1.0, 1.0, 0.0), f);
    float n001 = pt_grad3(i, vec3(0.0, 0.0, 1.0), f);
    float n101 = pt_grad3(i, vec3(1.0, 0.0, 1.0), f);
    float n011 = pt_grad3(i, vec3(0.0, 1.0, 1.0), f);
    float n111 = pt_grad3(i, vec3(1.0, 1.0, 1.0), f);
    float x00 = mix(n000, n100, u.x);
    float x10 = mix(n010, n110, u.x);
    float x01 = mix(n001, n101, u.x);
    float x11 = mix(n011, n111, u.x);
    return 1.1547 * mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}`,

    // Simplex noise 2D (Ashima Arts / Stefan Gustavson, MIT)
    pt_permute3: `vec3 pt_permute3(vec3 x) {
    return mod(((x * 34.0) + 1.0) * x, 289.0);
}`,

    pt_simplex2: `float pt_simplex2(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = pt_permute3(pt_permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}`,

    pt_fbm2: `float pt_fbm2(vec2 p, int octaves, float lacunarity, float gain) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 12; i++) {
        if (i >= octaves) break;
        sum += amp * pt_perlin2(p);
        norm += amp;
        p = rot * p * lacunarity + vec2(17.13, 9.71);
        amp *= gain;
    }
    return sum / max(norm, 1e-4);
}`,

    /** x: distance to nearest point (F1), y: F2 - F1 (cell edges), z: cell id in [0, 1]. */
    pt_voronoi2: `vec3 pt_voronoi2(vec2 p, float jitter) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    float id = 0.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = 0.5 + (pt_hash22(n + g) - 0.5) * jitter;
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < d1) {
                d2 = d1;
                d1 = d;
                id = pt_hash12(n + g);
            } else if (d < d2) {
                d2 = d;
            }
        }
    }
    d1 = sqrt(d1);
    d2 = sqrt(d2);
    return vec3(d1, d2 - d1, id);
}`,

    /** Inigo Quilez style two-level domain warp; returns the warped point. */
    pt_domainWarp2: `vec2 pt_domainWarp2(vec2 p, float strength, int octaves) {
    vec2 q = vec2(pt_fbm2(p, octaves, 2.0, 0.5), pt_fbm2(p + vec2(5.2, 1.3), octaves, 2.0, 0.5));
    vec2 r = vec2(pt_fbm2(p + strength * q + vec2(1.7, 9.2), octaves, 2.0, 0.5),
                  pt_fbm2(p + strength * q + vec2(8.3, 2.8), octaves, 2.0, 0.5));
    return p + strength * r;
}`,

    // Ordered dithering thresholds in [0, 1)
    pt_bayer2: `float pt_bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
}`,

    pt_bayer4: `float pt_bayer4(vec2 a) {
    return pt_bayer2(0.5 * a) * 0.25 + pt_bayer2(a);
}`,

    // ------------------------------------------------------------------
    // 2D signed distance functions (Inigo Quilez, MIT)
    // ------------------------------------------------------------------

    pt_sdBox2: `float pt_sdBox2(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`,

    pt_sdSegment: `float pt_sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return length(pa - ba * h);
}`,

    pt_sdEqTriangle: `float pt_sdEqTriangle(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
}`,

    pt_sdHexagon: `float pt_sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
}`,

    /** n points; m in [2, n] (2 = spiky star, n = regular polygon). */
    pt_sdStar: `float pt_sdStar(vec2 p, float r, float n, float m) {
    n = max(n, 2.0);
    m = clamp(m, 2.0, n);
    float an = 3.141593 / n;
    float en = 3.141593 / m;
    vec2 acs = vec2(cos(an), sin(an));
    vec2 ecs = vec2(cos(en), sin(en));
    float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
    p = length(p) * vec2(cos(bn), abs(sin(bn)));
    p -= r * acs;
    p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
    return length(p) * sign(p.x);
}`,

    /** Polynomial smooth minimum (k = blend radius). */
    pt_smin: `float pt_smin(float a, float b, float k) {
    k = max(k, 1e-5);
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
}`,

    pt_smax: `float pt_smax(float a, float b, float k) {
    return -pt_smin(-a, -b, k);
}`,

    /** normalize() that returns vec3(0) for a zero vector (GLSL leaves that undefined, e.g. normals on raymarch misses). */
    pt_safeNormalize: `vec3 pt_safeNormalize(vec3 v) {
    float l = length(v);
    return l > 0.0 ? v / l : vec3(0.0);
}`,

    // ------------------------------------------------------------------
    // 3D signed distance functions (Inigo Quilez, MIT)
    // ------------------------------------------------------------------

    pt_sdBox3: `float pt_sdBox3(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}`,

    pt_sdTorus: `float pt_sdTorus(vec3 p, float major, float minor) {
    vec2 q = vec2(length(p.xz) - major, p.y);
    return length(q) - minor;
}`,

    pt_sdCapsule: `float pt_sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return length(pa - ba * h) - r;
}`,

    pt_sdCylinder: `float pt_sdCylinder(vec3 p, float h, float r) {
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}`,

    /** Camera ray direction from eye `ro` looking at `ta`, vertical fov in degrees. p = centered coords. */
    pt_cameraRayDir: `vec3 pt_cameraRayDir(vec3 ro, vec3 ta, float fovDeg, vec2 p) {
    vec3 ww = normalize(ta - ro + vec3(0.0, 0.0, 1e-6));
    vec3 up = abs(ww.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 uu = normalize(cross(ww, up));
    vec3 vv = cross(uu, ww);
    float f = 1.0 / tan(radians(clamp(fovDeg, 1.0, 179.0)) * 0.5);
    return normalize(p.x * uu + p.y * vv + f * ww);
}`,

    // ------------------------------------------------------------------
    // Color
    // ------------------------------------------------------------------

    pt_hsv2rgb: `vec3 pt_hsv2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
}`,

    pt_rgb2hsv: `vec3 pt_rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}`,

    pt_luma: `float pt_luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}`,

    /** ACES filmic tonemapping curve (Krzysztof Narkowicz fit). */
    pt_aces: `vec3 pt_aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}`,
};

/** Return the distinct `pt_*` identifiers referenced in a code string. */
function libraryRefs(code) {
    return [...new Set(code.match(/\bpt_[A-Za-z0-9_]+/g) || [])].filter(name => GLSL_LIB[name]);
}

/**
 * Collect every library function referenced (transitively) by `code`,
 * dependencies first. Returns a GLSL source string ('' if none).
 */
export function collectLibrary(code) {
    const ordered = [];
    const seen = new Set();
    const visit = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        for (const dep of libraryRefs(GLSL_LIB[name])) {
            if (dep !== name) visit(dep);
        }
        ordered.push(name);
    };
    for (const name of libraryRefs(code)) visit(name);
    return ordered.map(name => GLSL_LIB[name]).join('\n\n');
}
