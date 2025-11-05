// @node raymarchScene
// @input Camera camera
// @input vec2 uv
// @return vec4

// SDF for a box
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// SDF for a plane
float sdPlane(vec3 p, vec3 n, float h) {
    return dot(p, n) + h;
}

// Scene SDF
float scene(vec3 p) {
    // Glass cube at origin, size 1.0
    float cube = sdBox(p, vec3(1.0));

    // Checkboard floor at y = -2.0
    float floor = sdPlane(p, vec3(0.0, 1.0, 0.0), 2.0);

    return min(cube, floor);
}

// Calculate normal using gradient
vec3 calcNormal(vec3 p) {
    const float h = 0.0001;
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * scene(p + k.xyy * h) +
        k.yyx * scene(p + k.yyx * h) +
        k.yxy * scene(p + k.yxy * h) +
        k.xxx * scene(p + k.xxx * h)
    );
}

// Raymarching
float raymarch(vec3 ro, vec3 rd) {
    float t = 0.0;
    for (int i = 0; i < 100; i++) {
        vec3 p = ro + rd * t;
        float d = scene(p);
        if (d < 0.001) break;
        if (t > 100.0) return -1.0;
        t += d;
    }
    return t;
}

// Generate ray from camera
vec3 getRayDirection(Camera cam, vec2 uv) {
    // Calculate camera basis vectors
    vec3 forward = normalize(cam.target - cam.position);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, forward);

    // Apply FOV
    float fovRadians = radians(cam.fov);
    float aspectRatio = u_resolution.x / u_resolution.y;

    vec3 rd = normalize(
        forward +
        uv.x * right * tan(fovRadians * 0.5) * aspectRatio +
        uv.y * up * tan(fovRadians * 0.5)
    );

    return rd;
}

// Checkboard pattern
float checkboard(vec2 p) {
    vec2 q = floor(p);
    return mod(q.x + q.y, 2.0);
}

// Main raymarching function
vec4 raymarchScene(Camera cam, vec2 uv) {
    // Get ray from camera
    vec3 ro = cam.position;
    vec3 rd = getRayDirection(cam, uv);

    // Raymarch
    float t = raymarch(ro, rd);

    // Background color
    if (t < 0.0) {
        return vec4(0.2, 0.3, 0.4, 1.0);
    }

    vec3 p = ro + rd * t;
    vec3 normal = calcNormal(p);

    // Determine what we hit
    float cube = sdBox(p, vec3(1.0));
    float floor = sdPlane(p, vec3(0.0, 1.0, 0.0), 2.0);

    vec3 color = vec3(0.0);

    if (cube < 0.01) {
        // Glass cube - simple refraction approximation
        vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
        float fresnel = pow(1.0 - abs(dot(rd, normal)), 3.0);

        // Glass appearance
        vec3 glassColor = vec3(0.9, 0.95, 1.0);
        float specular = pow(max(dot(reflect(-lightDir, normal), -rd), 0.0), 32.0);

        color = glassColor * (0.3 + fresnel * 0.7) + vec3(specular);

    } else if (floor < 0.01) {
        // Checkboard floor
        float check = checkboard(p.xz * 0.5);
        vec3 floorColor = mix(vec3(0.2), vec3(0.8), check);

        // Simple lighting
        vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
        float diff = max(dot(normal, lightDir), 0.0);
        float ambient = 0.3;

        color = floorColor * (ambient + diff * 0.7);
    }

    return vec4(color, 1.0);
}