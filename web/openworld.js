// Monet open world: painted Seine valley around Giverny
export function buildOpenWorld(THREE, T) {
  // T: { sky, detail, trees, paint: {key: texture}, aspect: {key: h/w} }
  const scene = new THREE.Scene();
  const imul = Math.imul;
  const h32 = x => { x >>>= 0; x ^= x >>> 16; x = imul(x, 0x7feb352d) >>> 0; x ^= x >>> 15; x = imul(x, 0x846ca68b) >>> 0; x ^= x >>> 16; return x >>> 0; };
  const hcell = (cx, cy) => h32((((cx + 1000) * 4096) + (cy + 1000)) >>> 0) / 4294967296;
  const hash2 = (x, y) => h32((imul(x | 0, 73856093) ^ imul(y | 0, 19349663)) >>> 0) / 4294967296;
  const sm = t => t * t * (3 - 2 * t);
  const vnoise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy; };
  const fbm = (x, y) => { let v = 0, a = 0.5, f = 1; for (let i = 0; i < 5; i++) { v += a * vnoise(x * f + i * 17.3, y * f - i * 9.1); f *= 2.03; a *= 0.5; } return v / 0.97; };
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let rs = 12345; const rnd = () => { rs = (imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };

  const riverZ = x => -560 + 140 * Math.sin(x * 0.0016) + 60 * Math.sin(x * 0.0041 + 1.3);
  const POND = { x: 350, z: -200, rx: 18, rz: 55 };
  function H(x, z) {
    const d = z - riverZ(x);
    let h = 3 + fbm(x * 0.004, z * 0.004) * 6;
    // flatten the poppy-field start corridor
    const corr = (1 - sstep(120, 220, Math.abs(x + 15))) * sstep(150, 200, z) * (1 - sstep(520, 600, z));
    h = h * (1 - corr) + 4 * corr;
    const north = sstep(-220, -1150, d);
    h += north * (60 + 110 * fbm(x * 0.0016 + 3, z * 0.0016));
    const south = sstep(1250, 2500, z);
    h += south * (50 + 90 * fbm(x * 0.002 + 7, z * 0.002));
    const far = sstep(2200, 5200, Math.hypot(x * 0.8, (z + 700)));
    h += far * (120 + 300 * fbm(x * 0.0008 + 11, z * 0.0008));
    const rv = 1 - sstep(50, 95, Math.abs(d));
    h = h * (1 - rv) - 4 * rv;
    const pe = Math.hypot((x - POND.x) / POND.rx, (z - POND.z) / POND.rz);
    const pv = 1 - sstep(0.8, 1.15, pe);
    h = h * (1 - pv) - 2.5 * pv;
    return h;
  }
  const fieldQ = (x, z) => { const a = 0.35, c = Math.cos(a), s = Math.sin(a); return [x * c - z * s, x * s + z * c]; };
  const CELL = [80, 50];
  function cropType(x, z) {
    const [qx, qz] = fieldQ(x, z);
    const cx = Math.floor(qx / CELL[0]), cz = Math.floor(qz / CELL[1]);
    return Math.floor(hcell(cx, cz) * 7);
  }

  // ---------------------------------------------------------------- landcover map (irregular fields)
  const LX0 = -2600, LZ0 = -3300, LW = 5200, LH = 5400, LN = 1024, LM = Math.round(LN * LH / LW);
  const land = new Uint8Array(LN * LM * 4);
  const TYPE_W = [[0, 0.28], [1, 0.22], [3, 0.2], [2, 0.07], [4, 0.05], [5, 0.08], [6, 0.10]];
  const typeOf = h => { let a = 0; for (const [t, w] of TYPE_W) { a += w; if (h < a) return t; } return 0; };
  const seedCache = new Map();
  const seed = (cx, cz) => { const k = cx * 100000 + cz; let v = seedCache.get(k); if (!v) { v = [(cx + 0.15 + 0.7 * hash2(cx * 3 + 1, cz * 7 + 2)) * 95, (cz + 0.15 + 0.7 * hash2(cx * 5 + 3, cz * 11 + 5)) * 60, hash2(cx * 13 + 7, cz * 17 + 9), hash2(cx * 19 + 4, cz * 23 + 1)]; seedCache.set(k, v); } return v; };
  function landAt(x, z) {
    const wx = x + 45 * (fbm(x * 0.0035, z * 0.0035) - 0.5) * 2, wz = z + 45 * (fbm(x * 0.0035 + 19, z * 0.0035 - 7) - 0.5) * 2;
    const [qx, qz] = fieldQ(wx, wz);
    const cx = Math.floor(qx / 95), cz = Math.floor(qz / 60);
    let f1 = 1e9, f2 = 1e9, best = null;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const sd = seed(cx + i, cz + j); const dx = (qx - sd[0]) * 0.8, dz = qz - sd[1]; const d = Math.sqrt(dx * dx + dz * dz); if (d < f1) { f2 = f1; f1 = d; best = sd; } else if (d < f2) f2 = d; }
    let ty = typeOf(best[2]);
    const d = z - riverZ(x);
    if (Math.max(sstep(-220, -1150, d), sstep(1250, 2500, z)) > 0.35) ty = 7;
    if (Math.abs(d) < 125) ty = 8;
    if (Math.abs(x + 15) < 260 && z > 160 && z < 640) ty = 2;
    if (Math.hypot(x - 350, z + 260) < 95) ty = 6;
    return [ty, (f2 - f1) * 0.5, best[3]];
  }
  for (let j = 0; j < LM; j++) for (let i = 0; i < LN; i++) {
    const x = LX0 + (i + 0.5) / LN * LW, z = LZ0 + (j + 0.5) / LM * LH;
    const [ty, e, r] = landAt(x, z), o = (j * LN + i) * 4;
    land[o] = ty; land[o + 1] = Math.min(255, e * 20); land[o + 2] = r * 255; land[o + 3] = 255;
  }
  const landTex = new THREE.DataTexture(land, LN, LM, THREE.RGBAFormat); landTex.magFilter = THREE.LinearFilter; landTex.minFilter = THREE.LinearFilter; landTex.needsUpdate = true;
  const landSample = (x, z) => { const i = Math.min(LN - 1, Math.max(0, Math.floor((x - LX0) / LW * LN))), j = Math.min(LM - 1, Math.max(0, Math.floor((z - LZ0) / LH * LM))); const o = (j * LN + i) * 4; return [land[o], land[o + 1] / 20, land[o + 2] / 255]; };
  const ACCENT = { 0: [[0.30, 0.46, 0.42], [0.70, 0.74, 0.34], [0.60, 0.58, 0.78], [0.78, 0.66, 0.36]], 1: [[0.98, 0.70, 0.36], [0.88, 0.58, 0.52], [0.66, 0.60, 0.78], [0.99, 0.88, 0.58]], 2: [[0.86, 0.24, 0.14], [0.70, 0.74, 0.36], [0.40, 0.52, 0.30]], 3: [[0.82, 0.84, 0.44], [0.42, 0.58, 0.40], [0.66, 0.64, 0.80]], 4: [[0.52, 0.44, 0.78], [0.80, 0.62, 0.78], [0.44, 0.56, 0.74]], 5: [[0.92, 0.62, 0.42], [0.72, 0.52, 0.64], [0.88, 0.76, 0.56]], 6: [[0.36, 0.56, 0.36], [0.74, 0.76, 0.40], [0.66, 0.60, 0.80]], 7: [[0.28, 0.42, 0.40], [0.52, 0.48, 0.70], [0.60, 0.66, 0.36]], 8: [[0.30, 0.46, 0.36], [0.62, 0.66, 0.34]] };
  const PALETTE = { 0: [[0.40, 0.55, 0.25], [0.56, 0.66, 0.30]], 1: [[0.86, 0.70, 0.38], [0.96, 0.82, 0.50]], 2: [[0.56, 0.62, 0.30], [0.74, 0.72, 0.42]], 3: [[0.60, 0.72, 0.33], [0.76, 0.80, 0.42]], 4: [[0.60, 0.54, 0.74], [0.70, 0.62, 0.78]], 5: [[0.76, 0.58, 0.48], [0.86, 0.68, 0.54]], 6: [[0.46, 0.62, 0.30], [0.64, 0.72, 0.36]], 7: [[0.33, 0.47, 0.30], [0.50, 0.58, 0.32]], 8: [[0.30, 0.44, 0.24], [0.52, 0.58, 0.30]] };

  // ---------------------------------------------------------------- shared uniforms & GLSL
  const sun = new THREE.Vector3(-0.78, 0.30, 0.48).normalize();
  const U = {
    uSun: { value: sun }, uSunCol: { value: new THREE.Color(1.30, 1.05, 0.74) }, uAmb: { value: new THREE.Color(0.47, 0.50, 0.62) },
    uFogA: { value: new THREE.Color(1.0, 0.88, 0.72) }, uFogB: { value: new THREE.Color(0.72, 0.76, 0.90) }, uFogDen: { value: 1 / 5200 },
    uTime: { value: 0 }, uDetail: { value: T.detail }, uLand: { value: landTex }, uLandRect: { value: new THREE.Vector4(LX0, LZ0, 1 / LW, 1 / LH) },
  };
  const COMMON = /* glsl */`
    uniform vec3 uSun, uSunCol, uAmb, uFogA, uFogB; uniform float uFogDen, uTime;
    vec3 fogCol(vec3 dir){ float s = pow(max(dot(dir, uSun), 0.0), 3.0); return mix(uFogB, uFogA, s); }
    vec3 applyFog(vec3 c, vec3 wp){
      vec3 v = wp - cameraPosition; float d = length(v); vec3 dir = v / max(d, 1e-3);
      float hf = exp(-max(wp.y, 0.0) / 300.0);
      float f = 1.0 - exp(-d * uFogDen * (0.55 + 0.45 * hf));
      return mix(c, fogCol(dir), f);
    }
    uint h32(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
    float hcell(vec2 c){ uint k = uint(int(c.x) + 1000) * 4096u + uint(int(c.y) + 1000); return float(h32(k)) / 4294967296.0; }
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  `;

  // ---------------------------------------------------------------- sky dome
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uSky: { value: T.sky }, uCloudLo: { value: 0.74 } }, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `uniform sampler2D uSky; uniform float uCloudLo; varying vec3 vW;
      void main(){
        vec3 dir = normalize(vW - cameraPosition);
        float el = dir.y;
        vec3 grad = mix(vec3(0.99,0.89,0.74), vec3(0.62,0.74,0.92), smoothstep(0.0, 0.2, el));
        grad = mix(grad, vec3(0.36,0.52,0.84), smoothstep(0.2, 0.85, el));
        float az = atan(dir.x, dir.z);
        vec2 suv = vec2(az / 6.2831853 * 5.0 + 0.3, clamp(el / 0.5, 0.02, 0.98));
        vec3 cl = texture2D(uSky, suv).rgb; float lum = dot(cl, vec3(0.3, 0.59, 0.11));
        float mask = smoothstep(uCloudLo, uCloudLo + 0.12, lum) * smoothstep(0.015, 0.12, el);
        float sd = max(dot(dir, uSun), 0.0);
        vec3 cloudC = mix(vec3(0.84,0.80,0.90), vec3(1.0,0.92,0.80), pow(sd, 2.0)) * (0.82 + 0.3 * lum);
        vec3 c = mix(grad, cloudC, mask * 0.92);
        c *= 0.94 + 0.12 * lum;
        c += vec3(1.0, 0.78, 0.48) * (pow(sd, 6.0) * 0.30 + pow(sd, 90.0) * 0.7);
        c = mix(fogCol(dir), c, smoothstep(-0.01, 0.06, el));
        gl_FragColor = vec4(c, 1.0);
      }`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMat); sky.frustumCulled = false; sky.renderOrder = -10;
  scene.add(sky);

  // ---------------------------------------------------------------- terrain
  function gridGeo(x0, x1, z0, z1, nx, nz, hf) {
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (x1 - x0) * i / (nx - 1), z = z0 + (z1 - z0) * j / (nz - 1), o = (j * nx + i) * 3;
      pos[o] = x; pos[o + 1] = hf(x, z); pos[o + 2] = z;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6); let c = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1; idx[c++] = a; idx[c++] = d; idx[c++] = b; idx[c++] = b; idx[c++] = d; idx[c++] = e; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeVertexNormals();
    return g;
  }
  const MX0 = -2600, MX1 = 2600, MZ0 = -3300, MZ1 = 2100;
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; vN = normal; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `uniform sampler2D uDetail, uLand; uniform vec4 uLandRect; varying vec3 vW; varying vec3 vN;
      float riverZ(float x){ return -560.0 + 140.0*sin(x*0.0016) + 60.0*sin(x*0.0041+1.3); }
      void main(){
        vec3 n = normalize(vN);
        float slope = 1.0 - n.y;
        vec2 luv = (vW.xz - uLandRect.xy) * uLandRect.zw;
        ivec2 ts = textureSize(uLand, 0);
        vec4 Ln = texelFetch(uLand, clamp(ivec2(luv * vec2(ts)), ivec2(0), ts - 1), 0);
        int ty = int(Ln.r * 255.0 + 0.5);
        float edge = texture2D(uLand, luv).g * 255.0 / 20.0;
        float fr = Ln.b;
        float n1 = vnoise(vW.xz*0.05), n2 = vnoise(vW.xz*0.35), n3 = vnoise(vW.xz*1.7);
        float ang = fr * 3.1416; vec2 sdir = vec2(cos(ang), sin(ang));
        float stripes = 0.5 + 0.5 * sin(dot(vW.xz, sdir) * 0.9 + n2 * 2.0);
        vec3 c = mix(vec3(0.40,0.55,0.25), vec3(0.56,0.66,0.30), n1);
        if (ty == 1) c = mix(vec3(0.86,0.70,0.38), vec3(0.96,0.82,0.50), mix(n2, stripes, 0.5));
        else if (ty == 2) { c = mix(vec3(0.56,0.62,0.30), vec3(0.74,0.72,0.42), n1); float pp = vnoise(vW.xz*3.1 + 7.0) * 0.75 + vnoise(vW.xz*0.2) * 0.25; if (pp > 0.74) c = mix(vec3(0.84,0.22,0.13), vec3(0.95,0.40,0.22), n3); }
        else if (ty == 3) c = mix(vec3(0.60,0.72,0.33), vec3(0.76,0.80,0.42), mix(n2, stripes, 0.35));
        else if (ty == 4) c = mix(vec3(0.58,0.52,0.74), vec3(0.70,0.62,0.80), mix(n2, stripes, 0.6));
        else if (ty == 5) c = mix(vec3(0.74,0.56,0.46), vec3(0.86,0.68,0.54), mix(n2, stripes, 0.7));
        else if (ty == 6) c = mix(vec3(0.46,0.62,0.30), vec3(0.64,0.72,0.36), n2);
        c = mix(c, vec3(0.54, 0.60, 0.38), 0.22);
        if (ty < 7) c = mix(c, mix(vec3(0.20,0.31,0.25), vec3(0.32,0.42,0.28), n3), (1.0 - smoothstep(0.8, 2.4 + n2 * 1.6, edge)) * (0.45 + 0.45 * n3));
        // hills / river banks / chalk
        float d = vW.z - riverZ(vW.x);
        float north = smoothstep(-220.0, -1150.0, d);
        float hill = max(north, smoothstep(1250.0, 2500.0, vW.z));
        hill = max(hill, smoothstep(40.0, 120.0, vW.y));
        vec3 hillC = mix(vec3(0.33,0.47,0.30), vec3(0.50,0.58,0.32), n1);
        hillC = mix(hillC, vec3(0.42,0.44,0.62), smoothstep(0.55, 0.8, vnoise(vW.xz*0.01)) * 0.5);
        c = mix(c, hillC, hill);
        c = mix(c, vec3(0.86,0.82,0.74), smoothstep(0.35, 0.6, slope) * hill);
        float bank = 1.0 - smoothstep(95.0, 140.0, abs(d));
        c = mix(c, mix(vec3(0.30,0.44,0.24), vec3(0.52,0.58,0.30), n2), bank);
        c = mix(c, vec3(0.45,0.40,0.30), 1.0 - smoothstep(-1.0, 1.5, vW.y));
        // painted brush detail
        vec2 dt = texture2D(uDetail, vW.xz / 22.0).rg;
        float det = mix(dt.r, dt.g, step(0.5, vnoise(vW.xz*0.02)));
        c *= 0.80 + 0.42 * det;
        c *= 0.92 + 0.16 * n3;
        float diff = max(dot(n, uSun), 0.0);
        vec3 lit = c * (uAmb + uSunCol * diff * 0.95);
        gl_FragColor = vec4(applyFog(lit, vW), 1.0);
      }`
  });
  const terrain = new THREE.Mesh(gridGeo(MX0, MX1, MZ0, MZ1, 420, 440, H), terrainMat); terrain.frustumCulled = false; scene.add(terrain);
  const farH = (x, z) => { const inside = x > MX0 + 20 && x < MX1 - 20 && z > MZ0 + 20 && z < MZ1 - 20; return H(x, z) - (inside ? 40 : 0); };
  const farTerrain = new THREE.Mesh(gridGeo(-16000, 16000, -18000, 12000, 170, 160, farH), terrainMat); farTerrain.frustumCulled = false; scene.add(farTerrain);

  // ---------------------------------------------------------------- water
  const waterMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `varying vec3 vW; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `varying vec3 vW;
      vec3 skyCol(vec3 dir){ float el = max(dir.y, 0.0); vec3 g = mix(vec3(0.98,0.88,0.74), vec3(0.62,0.74,0.90), smoothstep(0.0,0.4,el)); return g; }
      void main(){
        vec3 v = normalize(vW - cameraPosition);
        float ripple = vnoise(vec2(vW.x*0.06, vW.z*0.5) + vec2(uTime*0.3, 0.0)) - 0.5;
        vec3 r = reflect(v, normalize(vec3(ripple*0.15, 1.0, ripple*0.05)));
        float fr = 0.35 + 0.6 * pow(1.0 - max(-v.y, 0.0), 3.0);
        vec3 deep = vec3(0.22, 0.36, 0.44);
        vec3 c = mix(deep, skyCol(r), fr);
        float strokes = vnoise(vec2(vW.x*0.09, vW.z*0.9) + vec2(uTime*0.2, 3.0));
        c = mix(c, vec3(0.40,0.55,0.66), smoothstep(0.62, 0.75, strokes) * 0.5);
        float gl = pow(max(dot(r, uSun), 0.0), 40.0);
        c += vec3(1.0, 0.82, 0.55) * gl * smoothstep(0.5, 0.8, vnoise(vec2(vW.x*0.15, vW.z*1.1) + uTime*0.5)) * 1.4;
        gl_FragColor = vec4(applyFog(c, vW), 1.0);
      }`
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(MX1 - MX0, MZ1 - MZ0, 1, 1), waterMat);
  water.rotation.x = -Math.PI / 2; water.position.set((MX0 + MX1) / 2, 0, (MZ0 + MZ1) / 2); water.frustumCulled = false; scene.add(water);

  // ---------------------------------------------------------------- tree sprites
  const trees = [];
  const addTree = (x, z, kind, hgt, wid, tint) => { const y = H(x, z); if (y < 0.8) return; trees.push([x, y - 0.5, z, wid, hgt, kind, tint[0], tint[1], tint[2], rnd()]); };
  const KIND = { poplar: [0, 1, 7], round: [2, 3, 6], willow: [4], bush: [5] };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const tintV = () => { const k = 0.85 + rnd() * 0.3; return [k * (0.95 + rnd() * 0.1), k, k * (0.9 + rnd() * 0.15)]; };
  // poplar row the camera crests
  for (let x = -430; x <= 430; x += 10 + rnd() * 3) { const h = 26 + rnd() * 7; addTree(x + rnd() * 2, 200 + rnd() * 3, pick(KIND.poplar), h, h * 0.42, tintV()); }
  // poplars along both river banks
  for (let x = -2500; x <= 2500; x += 13 + rnd() * 6) for (const side of [-1, 1]) if (rnd() < 0.72) { const h = 22 + rnd() * 9; addTree(x, riverZ(x) + side * (100 + rnd() * 14), pick(KIND.poplar), h, h * 0.42, tintV()); }
  // hedgerow trees along field borders
  for (let i = 0; i < 90000; i++) {
    const x = -2400 + rnd() * 4800, z = -1300 + rnd() * 2500;
    const [ty, e] = landSample(x, z);
    if (ty >= 7 || e > 1.6 || rnd() > 0.55) continue;
    if (Math.abs(x + 15) < 240 && z > 150 && z < 620) continue;
    if (Math.hypot(x - 350, z + 260) < 110) continue;
    const bush = rnd() > 0.65, h = bush ? 12 + rnd() * 6 : 14 + rnd() * 8; addTree(x, z, bush ? pick(KIND.bush) : pick(KIND.round), h, h * 0.6, tintV());
  }
  // forests on hills
  for (let i = 0; i < 2600; i++) {
    const x = MX0 + 100 + rnd() * (MX1 - MX0 - 200), z = MZ0 + 100 + rnd() * (MZ1 - MZ0 - 200);
    const d = z - riverZ(x); const hill = Math.max(sstep(-260, -1150, d), sstep(1250, 2500, z));
    if (hill < 0.25 || fbm(x * 0.003 + 5, z * 0.003) < 0.48) continue;
    { const h = 16 + rnd() * 8; addTree(x, z, pick(KIND.round), h, h * 0.6, tintV().map(v => v * 0.85)); }
  }
  // willows around pond and along water
  for (let a = 0; a < Math.PI * 2; a += 0.42) { const r = 1.25 + rnd() * 0.15; { const h = 14 + rnd() * 4; addTree(POND.x + Math.cos(a) * POND.rx * r, POND.z + Math.sin(a) * POND.rz * r * 1.15, 4, h, h * 0.7, tintV()); } }
  for (let x = -2000; x <= 2000; x += 90 + rnd() * 120) { const h = 13 + rnd() * 4; addTree(x, riverZ(x) + (rnd() < 0.5 ? -1 : 1) * (88 + rnd() * 8), 4, h, h * 0.7, tintV()); }
  {
    const N = trees.length, base = new THREE.PlaneGeometry(1, 1); base.translate(0, 0.5, 0);
    const ig = new THREE.InstancedBufferGeometry(); ig.index = base.index; ig.setAttribute('position', base.attributes.position); ig.setAttribute('uv', base.attributes.uv);
    const a0 = new Float32Array(N * 4), a1 = new Float32Array(N * 4), a2 = new Float32Array(N * 4);
    trees.forEach((t, i) => { a0.set([t[0], t[1], t[2], t[9]], i * 4); a1.set([t[3], t[4], t[5], 0], i * 4); a2.set([t[6], t[7], t[8], 0], i * 4); });
    ig.setAttribute('aP', new THREE.InstancedBufferAttribute(a0, 4)); ig.setAttribute('aS', new THREE.InstancedBufferAttribute(a1, 4)); ig.setAttribute('aT', new THREE.InstancedBufferAttribute(a2, 4));
    ig.instanceCount = N;
    const tm = new THREE.ShaderMaterial({
      uniforms: { ...U, uAtlas: { value: T.trees } },
      vertexShader: `attribute vec4 aP, aS, aT; uniform float uTime; varying vec2 vUv; varying vec3 vT; varying vec3 vW;
        void main(){
          vec3 base = aP.xyz;
          vec3 toC = cameraPosition - base; toC.y = 0.0; vec3 fwd = normalize(toC + vec3(1e-4,0.0,0.0));
          vec3 right = normalize(cross(vec3(0.0,1.0,0.0), fwd));
          float sway = sin(uTime*1.3 + aP.w*20.0) * 0.015 * position.y * aS.y;
          vec3 p = base + right * (position.x * aS.x + sway) + vec3(0.0, position.y * aS.y, 0.0);
          float k = aS.z; float col = mod(k, 4.0), row = floor(k / 4.0);
          vUv = vec2((col + uv.x) / 4.0, (1.0 - (row + 1.0) / 2.0) + uv.y / 2.0);
          vT = aT.rgb; vW = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: COMMON + `uniform sampler2D uAtlas; varying vec2 vUv; varying vec3 vT; varying vec3 vW;
        void main(){ vec4 t = texture2D(uAtlas, vUv); if (t.a < 0.5) discard;
          vec3 c = t.rgb * vT * vec3(0.94, 0.98, 1.0);
          float l = dot(c, vec3(0.3,0.59,0.11));
          c = mix(c * vec3(0.66, 0.80, 1.15), c * vec3(0.98, 0.98, 0.84), smoothstep(0.22, 0.55, l)) * vec3(0.90, 0.96, 1.0);
          gl_FragColor = vec4(applyFog(c, vW), 1.0); }`
    });
    const tmesh = new THREE.Mesh(ig, tm); tmesh.frustumCulled = false; scene.add(tmesh);
  }

  // ---------------------------------------------------------------- lit solid material (houses, haystacks, frames, bridge, boats)
  const solidMat = (opts = {}, inst = true) => { const MM = inst ? 'modelMatrix*instanceMatrix' : 'modelMatrix'; return new THREE.ShaderMaterial({
    uniforms: { ...U, uSpec: { value: opts.spec || 0 }, uShadowTint: { value: new THREE.Color(...(opts.shadow || [0.42, 0.40, 0.62])) } },
    vertexColors: true,
    vertexShader: `varying vec3 vC; varying vec3 vN; varying vec3 vW;
      void main(){ vec4 wp = ${MM}*vec4(position,1.0); vW = wp.xyz; vN = normalize(mat3(${MM})*normal); vC = color; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `uniform float uSpec; uniform vec3 uShadowTint; varying vec3 vC; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 n = normalize(vN); float diff = dot(n, uSun);
        float k = smoothstep(-0.15, 0.55, diff);
        vec3 c = mix(vC * uShadowTint * 1.2, vC * uSunCol * 0.95, k);
        vec3 V = normalize(cameraPosition - vW); float sp = pow(max(dot(n, normalize(uSun + V)), 0.0), 30.0) * uSpec;
        c += sp * vec3(1.0, 0.85, 0.6);
        float nz = hash(floor(vW.xz * 1.5) + floor(vW.y * 2.0));
        c *= 0.93 + 0.14 * nz;
        gl_FragColor = vec4(applyFog(c, vW), 1.0); }`
  }); };
  const colorGeo = (g, col) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(col, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  function instanced(geo, mat, list) { // list of [x,y,z, ry, sx,sy,sz, r,g,b]
    const m = new THREE.InstancedMesh(geo, mat, list.length); const o = new THREE.Object3D();
    const cols = new Float32Array(list.length * 3);
    list.forEach((it, i) => { o.position.set(it[0], it[1], it[2]); o.rotation.set(0, it[3], 0); o.scale.set(it[4], it[5], it[6]); o.updateMatrix(); m.setMatrixAt(i, o.matrix); cols.set([it[7], it[8], it[9]], i * 3); });
    m.geometry = geo.clone(); m.geometry.setAttribute('color', new THREE.InstancedBufferAttribute(cols, 3));
    m.frustumCulled = false; scene.add(m); return m;
  }

  // haystacks in wheat fields
  const stacks = [];
  for (let i = 0; i < 60000 && stacks.length < 150; i++) {
    const x = -1200 + rnd() * 2600, z = -500 + rnd() * 1100;
    const [ty, e] = landSample(x, z);
    if (ty !== 1 || e < 8) continue;
    if (stacks.some(s => Math.hypot(s[0] - x, s[2] - z) < 22)) continue;
    stacks.push([x, H(x, z) - 0.3, z, rnd() * 6, 1 + rnd() * 0.25, 1 + rnd() * 0.3, 1 + rnd() * 0.25, 0.95, 0.74, 0.44]);
  }
  const prof = [[0.01, 0], [3.7, 0], [3.9, 1.6], [3.6, 3.2], [2.6, 4.6], [1.1, 5.5], [0.0, 5.8]].map(p => new THREE.Vector2(p[0], p[1]));
  const stackGeo = new THREE.LatheGeometry(prof, 14);
  instanced(stackGeo, solidMat({ shadow: [0.40, 0.36, 0.66], spec: 0.15 }), stacks);
  // haystack shadows
  {
    const N = stacks.length, base = new THREE.PlaneGeometry(1, 1); base.rotateX(-Math.PI / 2);
    const sh = []; const dir = new THREE.Vector2(-sun.x, -sun.z).normalize(); const ang = Math.atan2(dir.x, dir.y);
    stacks.forEach(s => sh.push([s[0] + dir.x * 8, H(s[0] + dir.x * 8, s[2] + dir.y * 8) + 0.25, s[2] + dir.y * 8, ang, 7.5, 1, 18, 0, 0, 0]));
    const m = new THREE.InstancedMesh(base, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: U,
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 wp = modelMatrix*instanceMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: COMMON + `varying vec2 vUv; varying vec3 vW; void main(){ vec2 p = (vUv-0.5)*2.0; float a = smoothstep(1.0, 0.3, length(p*vec2(1.0,1.0))) * 0.42; float fd = 1.0 - exp(-length(vW-cameraPosition)*uFogDen); gl_FragColor = vec4(0.30,0.26,0.48, a*(1.0-fd)); }` }), N);
    const o = new THREE.Object3D(); sh.forEach((it, i) => { o.position.set(it[0], it[1], it[2]); o.rotation.set(0, it[3], 0); o.scale.set(it[4], 1, it[6]); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
    m.frustumCulled = false; scene.add(m);
  }
  // village with church on the north bank
  const houses = [], roofs = [];
  const WALLS = [[0.93, 0.86, 0.74], [0.95, 0.80, 0.70], [0.88, 0.84, 0.78], [0.96, 0.90, 0.80]], ROOFS = [[0.56, 0.36, 0.32], [0.45, 0.47, 0.60], [0.62, 0.42, 0.34]];
  const addHouse = (x, z, w, d, h, ry, wall, roof) => { const y = H(x, z) - 0.5; houses.push([x, y, z, ry, w, h, d, ...wall]); roofs.push([x, y + h, z, ry, w * 0.56, h * 0.55, d * 0.56, ...roof]); };
  const VX = -520, VZ = -880;
  for (let i = 0; i < 46; i++) { const a = rnd() * Math.PI * 2, r = 18 + rnd() * 95; const x = VX + Math.cos(a) * r * 1.4, z = VZ + Math.sin(a) * r * 0.8; addHouse(x, z, 8 + rnd() * 6, 7 + rnd() * 4, 6 + rnd() * 3, rnd() * 0.5 - 0.25 + (rnd() < 0.5 ? 0 : Math.PI / 2), pick(WALLS), pick(ROOFS)); }
  // a second hamlet south-west
  for (let i = 0; i < 18; i++) { const x = -980 + rnd() * 120, z = -150 + rnd() * 90; addHouse(x, z, 8 + rnd() * 5, 7 + rnd() * 3, 6 + rnd() * 2, rnd() * 0.4, pick(WALLS), pick(ROOFS)); }
  // Monet's house (pink, long) north of the garden
  addHouse(350, -330, 42, 10, 8, 0, [0.92, 0.62, 0.62], [0.42, 0.46, 0.52]);
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  instanced(box, solidMat({ shadow: [0.50, 0.48, 0.72] }), houses);
  const roofGeo = new THREE.ConeGeometry(Math.SQRT1_2 * 2, 1, 4, 1); roofGeo.rotateY(Math.PI / 4); roofGeo.translate(0, 0.5, 0);
  instanced(roofGeo, solidMat({ shadow: [0.45, 0.42, 0.66] }), roofs);
  // church
  {
    const y = H(VX, VZ) - 0.5;
    instanced(box, solidMat({ shadow: [0.5, 0.48, 0.72] }), [[VX, y, VZ, 0.2, 14, 13, 32, 0.92, 0.88, 0.80], [VX + Math.sin(0.2) * 18, y, VZ + Math.cos(0.2) * 18, 0.2, 8, 30, 8, 0.90, 0.86, 0.80]]);
    const sp = new THREE.ConeGeometry(5.6, 1, 8, 1); sp.translate(0, 0.5, 0);
    instanced(sp, solidMat({ shadow: [0.45, 0.42, 0.66] }), [[VX + Math.sin(0.2) * 18, y + 30, VZ + Math.cos(0.2) * 18, 0, 1, 18, 1, 0.44, 0.48, 0.62]]);
    const nr = new THREE.ConeGeometry(Math.SQRT1_2 * 2, 1, 4, 1); nr.rotateY(Math.PI / 4); nr.translate(0, 0.5, 0);
    instanced(nr, solidMat({ shadow: [0.45, 0.42, 0.66] }), [[VX, y + 13, VZ, 0.2, 7.8, 7, 17, 0.50, 0.40, 0.40]]);
  }
  // sailboats on the Seine
  {
    const hulls = [], sails = [];
    for (const [x, off] of [[-260, -25], [80, 20], [180, -30], [560, 10], [880, -15], [-640, 18]]) {
      const z = riverZ(x) + off, ang = Math.atan2(1, (riverZ(x + 1) - riverZ(x - 1)) / 2) ;
      hulls.push([x, 0.2, z, ang, 2.6, 1.2, 9, 0.95, 0.94, 0.90]);
      sails.push([x, 1.2, z, ang + 0.25, 1, 9, 5, 0.98, 0.97, 0.92]);
    }
    instanced(box, solidMat({ shadow: [0.5, 0.5, 0.7] }), hulls);
    const sailGeo = new THREE.BufferGeometry(); sailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, -0.5, 0, 1, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0.5, 0, 1, 0]), 3)); sailGeo.computeVertexNormals();
    const sm2 = solidMat({ shadow: [0.6, 0.6, 0.8] }); sm2.side = THREE.DoubleSide; instanced(sailGeo, sm2, sails);
  }
  // Japanese bridge over the pond (spans east-west so it reads as an arch from the south)
  {
    const g = new THREE.Group(); const mat = solidMat({ shadow: [0.30, 0.42, 0.52], spec: 0.2 }, false);
    const bz = -200, x0 = 328, x1 = 372, N = 20, arc = t => 1.0 + 5.0 * (1 - Math.pow(2 * t - 1, 2));
    const col = [0.26, 0.48, 0.36];
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N, xa = x0 + (x1 - x0) * t0, xb = x0 + (x1 - x0) * t1, ya = arc(t0), yb = arc(t1);
      const len = Math.hypot(xb - xa, yb - ya), pitch = Math.atan2(yb - ya, xb - xa);
      for (const [dz, h, w, yo] of [[0, 0.35, 4.4, 0], [-2.1, 0.25, 0.25, 1.4], [2.1, 0.25, 0.25, 1.4], [-2.1, 0.2, 0.2, 0.7], [2.1, 0.2, 0.2, 0.7]]) {
        const m = new THREE.Mesh(colorGeo(new THREE.BoxGeometry(len * 1.05, h, w), col), mat); m.position.set((xa + xb) / 2, (ya + yb) / 2 + yo, bz + dz); m.rotation.z = pitch; g.add(m);
      }
    }
    for (let i = 0; i <= N; i += 2) { const t = i / N, x = x0 + (x1 - x0) * t, y = arc(t); for (const dz of [-2.1, 2.1]) { const m = new THREE.Mesh(colorGeo(new THREE.BoxGeometry(0.3, 1.6, 0.3), col), mat); m.position.set(x, y + 0.7, bz + dz); g.add(m); } }
    g.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(g);
  }

  // ---------------------------------------------------------------- brush-stroke particles (poppy corridor, garden, lily pads)
  const strokes = [];
  const pushS = (x, y, z, col, len, wid, ang, mode) => strokes.push([x, y, z, col[0], col[1], col[2], len, wid, ang, mode, rnd(), 0]);
  for (let i = 0; i < 30000; i++) {
    const x = -95 + rnd() * 170, z = 185 + rnd() * 300, y = H(x, z);
    if (rnd() < 0.42) { const c = rnd() < 0.5 ? [0.86, 0.20, 0.12] : [0.96, 0.42, 0.20]; const s = 0.16 + rnd() * 0.16; pushS(x, y + 0.45 + rnd() * 0.45, z, c, s, s * 0.85, rnd() * 3, 0); }
    else { const k = rnd(); const c = [0.40 + 0.38 * k, 0.52 + 0.2 * k, 0.22 + 0.12 * k]; pushS(x, y + 0.45, z, c, 0.8 + rnd() * 0.7, 0.07 + rnd() * 0.06, 1.45 + rnd() * 0.3, 0); }
  }
  // world-anchored brush dabs over the valley floor around the flight path
  for (let i = 0; i < 170000; i++) {
    const x = -700 + rnd() * 1700, z = -760 + rnd() * 1300;
    const y = H(x, z); if (y < 0.5) continue;
    if (Math.abs(x + 15) < 270 && z > 140 && z < 650) continue;
    const [ty, e, fr] = landSample(x, z);
    const pal = PALETTE[ty] || PALETTE[0]; const k = rnd();
    let c = pal[0].map((v, j) => v + (pal[1][j] - v) * k);
    const acc = ACCENT[ty] || ACCENT[0]; if (rnd() < 0.38) c = acc[Math.floor(rnd() * acc.length)].slice();
    if (ty < 7 && e < 1.4) c = [0.26, 0.38, 0.23];
    if (ty === 2 && rnd() < 0.3) c = [0.86, 0.24, 0.14];
    const v = 0.86 + rnd() * 0.26; c = c.map(q => q * v);
    const ang = ty === 1 || ty === 4 || ty === 5 ? fr * Math.PI + (rnd() - 0.5) * 0.4 : rnd() * Math.PI;
    const L = 3.0 + rnd() * 4.5; pushS(x, y + 1.4, z, c, L, L * (0.30 + rnd() * 0.15), ang, 1);
  }
  for (let i = 0; i < 45000; i++) {
    const x = -2400 + rnd() * 4800, z = -2600 + rnd() * 1900;
    const y = H(x, z); const [ty] = landSample(x, z); if (ty !== 7 || y < 2) continue;
    const pal = PALETTE[7], acc = ACCENT[7]; const k = rnd();
    let c = rnd() < 0.4 ? acc[Math.floor(rnd() * acc.length)].slice() : pal[0].map((v, j) => v + (pal[1][j] - v) * k);
    c = c.map(q => q * (0.85 + rnd() * 0.3));
    const L = 9 + rnd() * 10; pushS(x, y + 3.5, z, c, L, L * 0.35, rnd() * Math.PI, 1);
  }
  const FLOWERS = [[0.62, 0.42, 0.78], [0.95, 0.62, 0.72], [0.98, 0.62, 0.22], [0.98, 0.96, 0.90], [0.88, 0.22, 0.24], [0.98, 0.86, 0.32], [0.48, 0.38, 0.80]];
  for (let row = 0; row < 14; row++) {
    const z = -306 + row * 4.2, c = FLOWERS[row % FLOWERS.length];
    for (let i = 0; i < 700; i++) { const x = 302 + rnd() * 96; const zz = z + rnd() * 2.2; const cc = rnd() < 0.25 ? [0.36, 0.52, 0.26] : c; pushS(x, H(x, zz) + 0.4 + rnd() * 0.5, zz, cc, 0.7 + rnd() * 0.5, 0.35 + rnd() * 0.2, rnd() * 3, 0); }
  }
  for (let i = 0; i < 700; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.92;
    const x = POND.x + Math.cos(a) * POND.rx * r, z = POND.z + Math.sin(a) * POND.rz * r;
    if (Math.abs(z + 200) < 4) continue;
    const fl = rnd() < 0.12; const c = fl ? (rnd() < 0.5 ? [0.98, 0.70, 0.78] : [0.99, 0.97, 0.92]) : [0.30 + rnd() * 0.15, 0.50 + rnd() * 0.15, 0.30];
    const s = fl ? 0.9 : 1.6 + rnd() * 1.6;
    pushS(x, 0.12, z, c, s, s * (fl ? 0.9 : 0.75), rnd() * 6, 1);
  }
  {
    const N = strokes.length, base = new THREE.PlaneGeometry(1, 1);
    const ig = new THREE.InstancedBufferGeometry(); ig.index = base.index; ig.setAttribute('position', base.attributes.position); ig.setAttribute('uv', base.attributes.uv);
    const a0 = new Float32Array(N * 4), a1 = new Float32Array(N * 4), a2 = new Float32Array(N * 4);
    strokes.forEach((s, i) => { a0.set([s[0], s[1], s[2], s[10] + (s[9] > 0.5 && s[6] > 2 ? 2 : 0)], i * 4); a1.set([s[3], s[4], s[5], s[9]], i * 4); a2.set([s[6], s[7], s[8], 0], i * 4); });
    ig.setAttribute('aP', new THREE.InstancedBufferAttribute(a0, 4)); ig.setAttribute('aC', new THREE.InstancedBufferAttribute(a1, 4)); ig.setAttribute('aS', new THREE.InstancedBufferAttribute(a2, 4));
    ig.instanceCount = N;
    const m = new THREE.ShaderMaterial({ uniforms: U, transparent: false,
      vertexShader: `attribute vec4 aP, aC, aS; uniform float uTime; varying vec2 vUv; varying vec3 vC; varying vec3 vW; varying float vR;
        void main(){
          vec2 cs = vec2(cos(aS.z), sin(aS.z));
          vec2 q = position.xy * aS.xy; q = vec2(q.x*cs.x - q.y*cs.y, q.x*cs.y + q.y*cs.x);
          vec3 p;
          if (aC.w < 0.5) {
            vec3 toC = cameraPosition - aP.xyz; toC.y = 0.0; vec3 f = normalize(toC + vec3(1e-4,0.0,0.0));
            vec3 r = normalize(cross(vec3(0.0,1.0,0.0), f));
            p = aP.xyz + r * q.x + vec3(0.0, q.y, 0.0) + r * sin(uTime*2.0 + aP.w*30.0) * 0.06 * (q.y + 0.3);
          } else { p = aP.xyz + vec3(q.x, 0.0, -q.y); }
          vUv = uv; vC = aC.rgb; vW = p; vR = aP.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: COMMON + `varying vec2 vUv; varying vec3 vC; varying vec3 vW; varying float vR;
        void main(){
          float x = vUv.x, y = vUv.y - 0.5;
          float edge = smoothstep(0.5, 0.36, abs(y) / mix(0.6, 1.0, sin(3.1416*x)));
          float ends = smoothstep(0.0, 0.15, x) * smoothstep(1.0, 0.8, x);
          float a = edge * ends;
          if (a < 0.5) discard;
          if (vR > 1.5 && length(vW - cameraPosition) < 14.0) discard;
          float br = 0.85 + 0.15 * sin(y * 40.0 + vR * 20.0);
          vec3 c = vC * br * (vR > 1.5 ? (uAmb + uSunCol * 0.28) : (uAmb * 0.55 + uSunCol * 0.55));
          gl_FragColor = vec4(applyFog(c, vW), 1.0);
        }` });
    const mesh = new THREE.Mesh(ig, m); mesh.frustumCulled = false; scene.add(mesh);
  }

  // ---------------------------------------------------------------- floating paintings
  const FLOAT = [
    { key: 'bridge', C: [350, 45, -170], w: 40, yaw: 0, bob: 0 },
    { key: 'poppy', C: [-270, 118, 30], w: 58, yaw: 0.55, bob: 1 },
    { key: 'lilies', C: [760, 150, -430], w: 54, yaw: -0.65, bob: 1 },
    { key: 'irises', C: [-720, 96, -330], w: 46, yaw: 0.75, bob: 1 },
    { key: 'allee', C: [170, 215, -1080], w: 74, yaw: 0.08, bob: 1 },
    { key: 'magpie', C: [-160, 270, -1700], w: 96, yaw: -0.12, bob: 1 },
  ];
  const goldMat = solidMat({ shadow: [0.42, 0.34, 0.40], spec: 0.8 }, false);
  const paintMat = tex => new THREE.ShaderMaterial({ uniforms: { ...U, uMap: { value: tex } },
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `uniform sampler2D uMap; varying vec2 vUv; varying vec3 vW; void main(){ vec3 c = texture2D(uMap, vUv).rgb; float far = smoothstep(150.0, 600.0, length(vW - cameraPosition)); c = mix(c, c * 1.25 + 0.06, far); gl_FragColor = vec4(applyFog(c, vW), 1.0); }` });
  const haloMat = new THREE.ShaderMaterial({ uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: COMMON + `varying vec2 vUv; varying vec3 vW; void main(){ vec2 p = (vUv-0.5)*2.0; float r = length(p); float a = smoothstep(1.0, 0.35, r) * 0.42; float fd = exp(-length(vW-cameraPosition)*uFogDen*0.6); gl_FragColor = vec4(vec3(1.0,0.85,0.6)*a*fd, 1.0); }` });
  const floats = FLOAT.map((F, i) => {
    const g = new THREE.Group(); const w = F.w, h = w * T.aspect[F.key];
    const pm = new THREE.Mesh(new THREE.PlaneGeometry(w, h), paintMat(T.paint[F.key])); g.add(pm);
    const fw = w * 0.075, fd = w * 0.035, gold = [0.52, 0.40, 0.21];
    for (const [bw, bh, x, y] of [[w + 2 * fw, fw, 0, h / 2 + fw / 2], [w + 2 * fw, fw, 0, -h / 2 - fw / 2], [fw, h, -w / 2 - fw / 2, 0], [fw, h, w / 2 + fw / 2, 0]]) {
      const b = new THREE.Mesh(colorGeo(new THREE.BoxGeometry(bw, bh, fd), gold), goldMat); b.position.set(x, y, -fd / 2 + fd * 0.3); g.add(b);
    }
    const lip = fw * 0.3;
    for (const [bw, bh, x, y] of [[w + 2 * fw, lip, 0, h / 2 + fw - lip / 2], [w + 2 * fw, lip, 0, -h / 2 - fw + lip / 2], [lip, h + 2 * fw, -w / 2 - fw + lip / 2, 0], [lip, h + 2 * fw, w / 2 + fw - lip / 2, 0],
                                [w, lip * 0.6, 0, h / 2 - lip * 0.3], [w, lip * 0.6, 0, -h / 2 + lip * 0.3], [lip * 0.6, h, -w / 2 + lip * 0.3, 0], [lip * 0.6, h, w / 2 - lip * 0.3, 0]]) {
      const b = new THREE.Mesh(colorGeo(new THREE.BoxGeometry(bw, bh, fd * 1.5), [0.46, 0.33, 0.16]), goldMat); b.position.set(x, y, fd * 0.2); g.add(b);
    }
    const back = new THREE.Mesh(colorGeo(new THREE.BoxGeometry(w, h, fd * 0.5), [0.30, 0.24, 0.18]), goldMat); back.position.z = -fd * 0.45; g.add(back);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(w * 2.0, h * 2.0), haloMat); halo.position.z = -fd * 1.2; g.add(halo);
    g.position.set(...F.C); g.rotation.y = F.yaw;
    g.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(g);
    return { ...F, g, h };
  });

  function update(t) {
    U.uTime.value = t;
    floats.forEach((F, i) => { if (!F.bob) return; F.g.position.y = F.C[1] + Math.sin(t * 0.45 + i * 1.7) * 2.5; F.g.rotation.y = F.yaw + Math.sin(t * 0.3 + i) * 0.04; F.g.rotation.z = Math.sin(t * 0.37 + i * 2.1) * 0.02; });
  }
  return { scene, sky, H, riverZ, update, floats, U, counts: { trees: trees.length, stacks: stacks.length, strokes: strokes.length } };
}
