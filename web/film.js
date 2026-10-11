// Painting fly-through renderer (three.js, runs headless via web/render.js)
// ---------------------------------------------------------------------------
// Layout of this file:
//   1. helpers (texture/bin loaders, easing, Catmull-Rom camera tracks)
//   2. DEPTH_GLSL        - depth curve: painting disparity -> camera distance, 2D<->3D blend (uFlat)
//   3. PaintWorld        - one painting = fg depth mesh + bg "far envelope" mesh + brush-stroke particles
//                          (+ optional flow animation / volumetric strokes / light glows for paintings with a flow map)
//   4. makeGallery       - dark gallery wall + gold frame around a painting (with edge dissolve)
//   5. MicroWorld        - impasto relief terrain from a painting crop (fly over brushstrokes)
//   6. post-processing   - DOF (3-level blur), grading, fog, bloom, zoom blur, painted-occlusion "curtain" transitions
//   7. cut timelines     - one function per cut returning {sh: shot, zoom, fade, cur}; starryShot() is the template
//   8. renderAt(t)       - entry point called by render.js for every frame
// Select a cut with ?cut=starry|fusion2|fusion|open|short (empty = original Monet film).
import * as THREE from './three.module.js';
import { buildOpenWorld } from './openworld.js';
THREE.ColorManagement.enabled = false;

const Q = new URLSearchParams(location.search);
const W = +(Q.get('w') || 1920), H = +(Q.get('h') || 1080);
const ASP = W / H;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------- loaders
const texLoader = new THREE.TextureLoader();
const loadTex = (url, mirror) => new Promise((r, rej) => texLoader.load(url, t => {
  t.colorSpace = THREE.NoColorSpace;
  if (mirror) t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.anisotropy = 4; r(t);
}, undefined, () => rej(new Error(`missing ${url} - run the prep step for this cut`))));
const fetchOk = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`missing ${url} - run the prep step for this cut`); return r; };
const loadBin = async url => new Float32Array(await (await fetchOk(url)).arrayBuffer());
const loadJSON = async url => (await fetchOk(url)).json();

// ---------------------------------------------------------------- math helpers
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ramp = (t, a, b) => sstep(a, b, t);
const lin = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const mixv = (a, b, m) => a.map((v, i) => v + (b[i] - v) * m);
// keyframed vector track with Catmull-Rom between keys: keys = [[t,[x,y,z]],...]
function track(keys, t) {
  if (t <= keys[0][0]) return keys[0][1].slice();
  const n = keys.length;
  if (t >= keys[n - 1][0]) return keys[n - 1][1].slice();
  let i = 0; while (keys[i + 1][0] < t) i++;
  const p0 = keys[Math.max(i - 1, 0)][1], p1 = keys[i][1], p2 = keys[i + 1][1], p3 = keys[Math.min(i + 2, n - 1)][1];
  let u = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const ease = keys[i + 1][2]; if (ease === 'in') u = u * u; else if (ease === 'out') u = 1 - (1 - u) * (1 - u); else if (ease === 'io') u = u * u * (3 - 2 * u);
  const u2 = u * u, u3 = u2 * u;
  return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
}
const strack = (keys, t) => track(keys.map(k => [k[0], [k[1]], k[2]]), t)[0];

// ---------------------------------------------------------------- shared GLSL
const DEPTH_GLSL = /* glsl */`
uniform float uTanX, uTanY, uZn, uZf, uGamma, uD, uOpen, uSmooth, uLayers, uFlat;
float zOf(float d){ return uZn*pow(uZf/uZn, pow(1.0-clamp(d,0.0,1.0), uGamma)); }
float easeOutBack(float x){ float c1=1.3; float c3=c1+1.0; return 1.0+c3*pow(x-1.0,3.0)+c1*pow(x-1.0,2.0); }
float layerOf(float d){ return min(floor(clamp(d,0.0,0.9999)*uLayers), uLayers-1.0); }
float openZ(float d){
  float li = layerOf(d);
  float dq = (li+0.5)/uLayers;
  float st = dq*0.45;
  float p = clamp((uOpen-st)/0.55, 0.0, 1.0);
  p = p<=0.0 ? 0.0 : easeOutBack(p);
  float zl = mix(uD + 0.012, zOf(dq), p);
  return mix(zl, mix(uD + 0.012, zOf(d), uFlat), uSmooth);
}
vec3 unproj(vec2 uv, float z){ return vec3((uv.x-0.5)*2.0*uTanX*z, (0.5-uv.y)*2.0*uTanY*z, -z); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
`;

// ---------------------------------------------------------------- painting world
class PaintWorld {
  constructor(key, cfg) { this.key = key; this.cfg = cfg; this.scene = new THREE.Scene(); }
  async load() {
    const k = this.key, cfg = this.cfg;
    const [meta, geo, st, tex, bgt] = await Promise.all([
      loadJSON(`data/${k}.json`), loadBin(`data/${k}_geo.bin`), loadBin(`data/${k}_strokes.bin`),
      loadTex(`data/${k}.jpg`, true), loadTex(`data/${k}_bg.jpg`, true)]);
    this.meta = meta;
    if (cfg.flow) { this.flowTex = await loadTex(`data/${k}_flow.png`, true); this.lights = await loadJSON(`data/${k}_lights.json`); }
    else { this.flowTex = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, THREE.RGBAFormat); this.flowTex.needsUpdate = true; }
    const tanX = Math.tan(cfg.fov * Math.PI / 360), tanY = tanX * meta.aspect;
    this.tanX = tanX; this.tanY = tanY;
    const U = this.U = {
      uTanX: { value: tanX }, uTanY: { value: tanY }, uZn: { value: cfg.zn }, uZf: { value: cfg.zf }, uGamma: { value: cfg.gamma },
      uD: { value: cfg.D }, uOpen: { value: 1 }, uSmooth: { value: 1 }, uLayers: { value: cfg.layers || 7 },
      uEdgeThr: { value: cfg.edge || 0.07 }, uGal: { value: 0 }, uFly: { value: 0 }, uStrokeA: { value: 1 }, uTime: { value: 0 },
      uStrokeScale: { value: 1.0 }, uFlat: { value: 1.0 },
      uFlow: { value: this.flowTex }, uFlowAmt: { value: 0 }, uVol: { value: 0 }, uGlow: { value: 0 }, cfgOutsideBg: { value: cfg.flow ? 1 : 0 },
    };
    // grid
    const nx = meta.GW + 1, ny = meta.GH + 1, M = meta.margin;
    const pos = new Float32Array(nx * ny * 3), ag = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const o = j * nx + i;
      pos[o * 3] = -M + (1 + 2 * M) * i / (nx - 1); pos[o * 3 + 1] = -M + (1 + 2 * M) * j / (ny - 1); pos[o * 3 + 2] = 0;
      ag[o * 3] = geo[o * 3]; ag[o * 3 + 1] = geo[o * 3 + 1]; ag[o * 3 + 2] = geo[o * 3 + 2];
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let c = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx[c++] = a; idx[c++] = d; idx[c++] = b; idx[c++] = b; idx[c++] = d; idx[c++] = e;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aGeo', new THREE.BufferAttribute(ag, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const meshVS = DEPTH_GLSL + `
      attribute vec3 aGeo; uniform float uIsBg;
      varying vec2 vUv; varying float vEdge; varying float vLayer;
      void main(){
        float d = uIsBg>0.5 ? aGeo.z : aGeo.x;
        float z = openZ(d);
        if(uIsBg>0.5) z = z*1.035 + 0.02;
        vec3 P = unproj(position.xy, z);
        vUv = position.xy; vEdge = aGeo.y; vLayer = layerOf(d);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(P,1.0);
      }`;
    const meshFS = DEPTH_GLSL + `
      uniform float cfgOutsideBg;
      uniform sampler2D uMap, uFlow, uBgMap; uniform float uIsBg, uEdgeThr, uGal, uFlowAmt, uTime;
      varying vec2 vUv; varying float vEdge; varying float vLayer;
      void main(){
        vec2 uv = vUv;
        float outside = max(max(-uv.x, uv.x-1.0), max(-uv.y, uv.y-1.0));
        if(outside>0.0 && uOpen<0.02) discard;
        float fl = abs(fract(vLayer+0.5)-0.5);
        if(uOpen>0.001 && fl>0.02 && hash12(gl_FragCoord.xy) > uSmooth) discard;
        if(uIsBg<0.5 && uOpen>0.001 && vEdge>uEdgeThr / max(uFlat * uFlat, 1e-4)) discard;
        vec2 tuv = vec2(uv.x, 1.0-uv.y);
        vec3 c;
        if (uFlowAmt > 0.001) {
          vec4 fw = texture2D(uFlow, tuv);
          vec2 fl = (fw.rg*2.0-1.0) * fw.b; fl.y = -fl.y;
          float ph0 = fract(uTime*0.2), ph1 = fract(uTime*0.2 + 0.5);
          vec2 dd = fl * uFlowAmt * 0.02;
          vec3 c0 = texture2D(uMap, tuv - dd*ph0).rgb, c1 = texture2D(uMap, tuv - dd*ph1).rgb;
          c = mix(c0, c1, abs(1.0 - 2.0*ph0));
        } else c = texture2D(uMap, tuv).rgb;
        if (cfgOutsideBg > 0.5 && outside > 0.0) { if (uIsBg < 0.5) discard; }
        vec2 q = (uv-vec2(0.5,0.40))*vec2(1.5,1.7);
        c *= mix(1.0, 0.42+0.7*exp(-dot(q,q)*1.3), uGal);
        gl_FragColor = vec4(c,1.0);
      }`;
    const mk = (isBg, map) => new THREE.ShaderMaterial({ uniforms: { ...U, uMap: { value: map }, uBgMap: { value: bgt }, uIsBg: { value: isBg } }, vertexShader: meshVS, fragmentShader: meshFS });
    this.bgMesh = new THREE.Mesh(g, mk(1, bgt)); this.fgMesh = new THREE.Mesh(g, mk(0, tex));
    this.bgMesh.frustumCulled = this.fgMesh.frustumCulled = false;
    this.scene.add(this.bgMesh, this.fgMesh);

    // strokes
    const N = meta.nstroke, base = new THREE.PlaneGeometry(1, 1);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = base.index; ig.setAttribute('position', base.attributes.position); ig.setAttribute('uv', base.attributes.uv);
    const a0 = new Float32Array(N * 4), a1 = new Float32Array(N * 4), a2 = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) for (let k2 = 0; k2 < 4; k2++) { a0[i * 4 + k2] = st[i * 12 + k2]; a1[i * 4 + k2] = st[i * 12 + 4 + k2]; a2[i * 4 + k2] = st[i * 12 + 8 + k2]; }
    ig.setAttribute('aS0', new THREE.InstancedBufferAttribute(a0, 4)); ig.setAttribute('aS1', new THREE.InstancedBufferAttribute(a1, 4)); ig.setAttribute('aS2', new THREE.InstancedBufferAttribute(a2, 4));
    ig.instanceCount = N;
    const smat = new THREE.ShaderMaterial({
      uniforms: { ...U, uMap: { value: tex } }, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: DEPTH_GLSL + `
        attribute vec4 aS0, aS1, aS2; uniform float uFly, uStrokeA, uTime, uStrokeScale, uFlowAmt, uVol; uniform sampler2D uFlow;
        varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vR; varying vec2 vC0; varying vec3 vLWA;
        void main(){
          float d = aS0.z;
          vec4 fw = texture2D(uFlow, vec2(aS0.x, 1.0 - aS0.y));
          vec2 fl = fw.rg*2.0-1.0; float fm = fw.b;
          float ph = fract(uTime*0.18 + aS2.x*7.0);
          vec2 suv = aS0.xy + fl * fm * uFlowAmt * 0.045 * (ph - 0.5);
          float skyS = smoothstep(0.55, 0.8, fm);
          float z = openZ(d) * (1.0 - 0.012 - 0.035*aS2.y);
          z = max(z, uD + 0.03);
          float brS = dot(aS1.rgb, vec3(0.3,0.59,0.11)); float ylS = (aS1.r+aS1.g)*0.5 - aS1.b;
          float keep = smoothstep(0.02, 0.15, ylS) * smoothstep(0.42, 0.6, brS);
          z *= mix(1.0, 0.5 + 0.5*aS2.y, uVol * skyS * (1.0 - keep));
          vec3 P = unproj(suv, z);
          float pw = 2.0*uTanX*z;
          float len = aS1.w*pw*uStrokeScale, wid = len*(0.30+0.14*aS2.x);
          float ang = aS0.w;
          // flyers drift out of the frame toward the viewer
          float isF = step(aS2.x, 0.06);
          float f = isF*smoothstep(0.0,1.0,clamp(uFly*1.4 - aS2.y*0.4,0.0,1.0));
          vec2 dir = normalize(aS0.xy-0.5+0.001);
          vec3 Pf = vec3((aS0.x-0.5)*2.0*uTanX*uD*(1.3+aS2.y*1.6) + dir.x*0.4*aS2.y,
                         (0.5-aS0.y)*2.0*uTanY*uD*(1.2+aS2.y*1.2) + 0.25*sin(uTime*0.4+aS2.y*20.0),
                         -uD + 0.25 + aS2.y*2.2 + 0.25*sin(uTime*0.3+aS2.x*40.0));
          P = mix(P, Pf, f);
          len = mix(len, 0.05+0.06*aS2.y, f); wid = mix(wid, len*0.3, f);
          ang += f*(uTime*0.25*(aS2.y-0.5) + aS2.y*6.0);
          vec2 cs = vec2(cos(ang), sin(ang));
          vC0 = suv; vLWA = vec3(aS1.w*uStrokeScale, aS1.w*uStrokeScale*(0.30+0.14*aS2.x), ang) * (1.0 - f);
          vec2 cxy = position.xy*vec2(len, wid);
          P.xy += vec2(cxy.x*cs.x - cxy.y*cs.y, cxy.x*cs.y + cxy.y*cs.x);
          vec4 mv = modelViewMatrix*vec4(P,1.0);
          vUv = uv; vCol = aS1.rgb; vR = aS2.y;
          float near = mix(smoothstep(0.04, 0.45, -mv.z), smoothstep(0.6, 1.8, -mv.z), f);
          vA = uStrokeA*near*mix(smoothstep(0.0,0.3,uOpen), 1.0, f) * mix(1.0, sin(3.14159*ph), step(0.001, uFlowAmt) * fm);
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uTanX, uTanY;
        varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vR; varying vec2 vC0; varying vec3 vLWA;
        float h1(float x){ return fract(sin(x*91.7)*43758.5); }
        void main(){
          float x = vUv.x, y = vUv.y-0.5;
          float wprof = mix(0.55, 1.0, smoothstep(0.0,0.35,x)) * mix(1.0, 0.6, smoothstep(0.6,1.0,x));
          float edge = smoothstep(0.5*wprof, 0.36*wprof, abs(y));
          float bristle = 0.72 + 0.28*sin(y*55.0 + vR*30.0 + sin(x*6.0+vR*9.0)*2.0);
          float ends = smoothstep(0.0, 0.12+0.08*h1(floor(y*14.0)+vR), x) * smoothstep(1.0, 0.72 + 0.2*h1(floor(y*11.0)+vR*3.0), x);
          float a = edge*ends*mix(0.75,1.0,bristle)*vA*0.92;
          if(a<0.01) discard;
          vec2 l = vec2((vUv.x-0.5)*vLWA.x, (vUv.y-0.5)*vLWA.y);
          vec2 cs = vec2(cos(vLWA.z), sin(vLWA.z));
          vec2 o = vec2(l.x*cs.x - l.y*cs.y, l.x*cs.y + l.y*cs.x);
          vec2 iuv = vC0 + vec2(o.x, -o.y * uTanX / uTanY);
          vec3 tc = texture2D(uMap, vec2(iuv.x, 1.0 - iuv.y)).rgb;
          vec3 c = mix(tc, vCol, 0.2)*(0.9+0.16*bristle);
          gl_FragColor = vec4(c*a, a);
        }`
    });
    this.strokes = new THREE.Mesh(ig, smat); this.strokes.frustumCulled = false;
    this.scene.add(this.strokes);

    if (this.lights) {
      const L = this.lights, items = [];
      const dAt = (u, v) => { const i = Math.round((u + M) / (1 + 2 * M) * (nx - 1)), j = Math.round((v + M) / (1 + 2 * M) * (ny - 1)); return geo[(j * nx + i) * 3]; };
      (L.stars || []).forEach((st, i) => items.push([st.u, st.v, 0.02 + 0.06 * st.v, st.r * (st.r > 0.05 ? 1.7 : 2.1), 1.0, 0.94, i === 10 ? 0.85 : 0.62, 1.0]));
      if (L.moon) items.push([L.moon.u, L.moon.v, 0.02 + 0.06 * L.moon.v, L.moon.r * 1.55, 1.0, 0.86, 0.42, 1.0]);
      (L.windows || []).forEach(wd => items.push([wd.u, wd.v, dAt(wd.u, wd.v), Math.max(wd.r * 5, 0.007), 1.0, 0.72, 0.32, 0.985]));
      const N = items.length, base = new THREE.PlaneGeometry(2, 2);
      const gg = new THREE.InstancedBufferGeometry(); gg.index = base.index; gg.setAttribute('position', base.attributes.position); gg.setAttribute('uv', base.attributes.uv);
      const b0 = new Float32Array(N * 4), b1 = new Float32Array(N * 4);
      items.forEach((it, i) => { b0.set([it[0], it[1], it[2], it[3]], i * 4); b1.set([it[4], it[5], it[6], it[7]], i * 4); });
      gg.setAttribute('aL', new THREE.InstancedBufferAttribute(b0, 4)); gg.setAttribute('aC', new THREE.InstancedBufferAttribute(b1, 4)); gg.instanceCount = N;
      const gm = new THREE.ShaderMaterial({ uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: DEPTH_GLSL + `attribute vec4 aL, aC; uniform float uVol, uTime; varying vec2 vUv; varying vec3 vC; varying float vSeed;
          void main(){
            float z = openZ(aL.z) * 0.8;
            vec3 P = unproj(aL.xy, z);
            float size = aL.w * 2.0 * uTanX * z;
            vec4 mv = modelViewMatrix * vec4(P, 1.0);
            mv.xy += position.xy * size;
            vUv = position.xy; vC = aC.rgb; vSeed = aL.x * 37.0 + aL.y * 91.0;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform float uGlow, uTime; varying vec2 vUv; varying vec3 vC; varying float vSeed;
          void main(){
            float r = length(vUv);
            if (r > 1.0) discard;
            float pulse = 0.82 + 0.18 * sin(uTime * 2.2 + vSeed);
            float core = exp(-r*r*22.0) * 0.28;
            float halo = exp(-r*r*4.5) * 0.16;
            float ang = atan(vUv.y, vUv.x);
            float rings = (0.5 + 0.5 * sin(r * 34.0 - uTime * 2.6 + sin(ang * 3.0 + uTime * 0.7) * 0.8 + vSeed)) * smoothstep(0.2, 0.45, r) * smoothstep(1.0, 0.55, r) * 0.10;
            float a = (core + halo + rings) * pulse * uGlow * smoothstep(1.0, 0.8, r);
            gl_FragColor = vec4(vC * a, 1.0);
          }` });
      this.glow = new THREE.Mesh(gg, gm); this.glow.frustumCulled = false; this.scene.add(this.glow);
    }
  }
  set(u) { for (const k in u) if (this.U[k]) this.U[k].value = u[k]; }
  // world position of painting pixel (u,v) at final depth (approx using disparity from geo grid not needed for camera planning)
}

// ---------------------------------------------------------------- gallery (wall + frame + floor)
function makeGallery(world) {
  const D = world.cfg.D, cw = 2 * world.tanX * D, ch = 2 * world.tanY * D;
  const g = new THREE.Group();
  const U = { uLight: { value: new THREE.Vector3(0, ch * 1.4, -D + 2.6) }, uTarget: { value: new THREE.Vector3(0, 0, -D) }, uGalA: { value: 1 }, uDiss: { value: 0 }, uHalf: { value: new THREE.Vector2(cw / 2, ch / 2) }, uWallZ: { value: -D } };
  const mat = (col, spec, shin) => new THREE.ShaderMaterial({
    uniforms: { ...U, uCol: { value: new THREE.Color(...col) }, uSpec: { value: spec }, uShin: { value: shin } },
    vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vP = wp.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `uniform vec3 uCol, uLight, uTarget; uniform float uSpec, uShin, uGalA, uDiss, uWallZ; uniform vec2 uHalf; varying vec3 vN; varying vec3 vP;
      float gh(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
      float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
      void main(){
        float edgeAmt = 0.0;
        if (uDiss > 0.0) {
          vec2 q = max(abs(vP.xy) - uHalf, 0.0);
          float dd = length(q) + max(vP.z - uWallZ, 0.0) * 0.8;
          float n = gn(vP.xy * 3.0 + vP.z * 2.0) * 0.55 + gn(vec2(vP.x * 1.2 + vP.z, vP.y * 10.0 + vP.z * 3.0)) * 0.45;
          float v = dd + n * 0.9;
          float thr = uDiss * 7.5 - 0.5;
          if (v < thr) discard;
          edgeAmt = smoothstep(0.25, 0.0, v - thr);
        }
        vec3 L = normalize(uLight-vP); float diff = max(dot(vN,L),0.0);
        vec3 sd = normalize(uTarget-uLight); float cosA = dot(-L, sd);
        float spot = smoothstep(0.78, 0.97, cosA);
        float dist = length(uLight-vP); float att = 3.2/(1.0+0.35*dist*dist);
        vec3 V = normalize(cameraPosition-vP); vec3 Hh = normalize(L+V);
        float sp = pow(max(dot(vN,Hh),0.0), uShin)*uSpec;
        vec3 c = uCol*(0.035 + diff*spot*att) + sp*spot*att*vec3(1.0,0.88,0.68);
        c = c * uGalA;
        c = mix(c, vec3(0.50, 0.44, 0.46), edgeAmt * 0.6);
        gl_FragColor = vec4(c, 1.0);
      }`
  });
  const wallM = mat([0.20, 0.21, 0.22], 0.0, 1.0), floorM = mat([0.16, 0.12, 0.09], 0.15, 20.0), goldM = mat([0.78, 0.58, 0.28], 1.1, 28.0), darkGold = mat([0.42, 0.30, 0.14], 0.6, 16.0);
  const z = -D - 0.004, BIG = 40;
  const addPlane = (w, h, x, y, m) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.position.set(x, y, z); g.add(p); };
  addPlane(BIG, BIG, 0, ch / 2 + BIG / 2, wallM); addPlane(BIG, BIG, 0, -ch / 2 - BIG / 2, wallM);
  addPlane(BIG, ch, -cw / 2 - BIG / 2, 0, wallM); addPlane(BIG, ch, cw / 2 + BIG / 2, 0, wallM);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(BIG, BIG), floorM); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -ch * 1.25, -D + BIG / 2); g.add(floor);
  const fw = cw * 0.085, fd = 0.07;
  const bar = (w, h, x, y, m, depth, zz) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), m); b.position.set(x, y, zz); g.add(b); };
  // outer moulding
  bar(cw + 2 * fw, fw, 0, ch / 2 + fw / 2, goldM, fd, -D + fd / 2); bar(cw + 2 * fw, fw, 0, -ch / 2 - fw / 2, goldM, fd, -D + fd / 2);
  bar(fw, ch, -cw / 2 - fw / 2, 0, goldM, fd, -D + fd / 2); bar(fw, ch, cw / 2 + fw / 2, 0, goldM, fd, -D + fd / 2);
  // raised outer lip
  const lip = fw * 0.28;
  bar(cw + 2 * fw, lip, 0, ch / 2 + fw - lip / 2, darkGold, fd * 1.6, -D + fd * 0.8); bar(cw + 2 * fw, lip, 0, -ch / 2 - fw + lip / 2, darkGold, fd * 1.6, -D + fd * 0.8);
  bar(lip, ch + 2 * fw, -cw / 2 - fw + lip / 2, 0, darkGold, fd * 1.6, -D + fd * 0.8); bar(lip, ch + 2 * fw, cw / 2 + fw - lip / 2, 0, darkGold, fd * 1.6, -D + fd * 0.8);
  // inner slip
  const sl = fw * 0.18;
  bar(cw, sl, 0, ch / 2 - sl / 2 + 0.002, darkGold, fd * 0.5, -D + fd * 0.25); bar(cw, sl, 0, -ch / 2 + sl / 2 - 0.002, darkGold, fd * 0.5, -D + fd * 0.25);
  bar(sl, ch, -cw / 2 + sl / 2 - 0.002, 0, darkGold, fd * 0.5, -D + fd * 0.25); bar(sl, ch, cw / 2 - sl / 2 + 0.002, 0, darkGold, fd * 0.5, -D + fd * 0.25);
  g.userData.U = U; g.userData.cw = cw; g.userData.ch = ch;
  return g;
}

// ---------------------------------------------------------------- micro (impasto terrain) world
class MicroWorld {
  constructor(name = 'micro', ext = [-0.85, 0.85, -0.85, 0.85, 560, 560], kNorm = 0.024) { this.scene = new THREE.Scene(); this.name = name; this.ext = ext; this.kNorm = kNorm; }
  async load() {
    const nm = this.name;
    const [meta, hb, tex, nrm] = await Promise.all([loadJSON(`data/${nm}.json`), loadBin(`data/${nm}_h.bin`), loadTex(`data/${nm}.jpg`, true), loadTex(`data/${nm}_n.png`, true)]);
    this.G = meta.G; this.h = hb;
    const [X0, X1, Z0, Z1, NX, NZ] = this.ext;
    const pos = new Float32Array(NX * NZ * 3), ah = new Float32Array(NX * NZ);
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const o = j * NX + i, x = X0 + (X1 - X0) * i / (NX - 1), z = Z0 + (Z1 - Z0) * j / (NZ - 1);
      pos[o * 3] = x; pos[o * 3 + 1] = 0; pos[o * 3 + 2] = z; ah[o] = this.hAt(x, z);
    }
    const idx = new Uint32Array((NX - 1) * (NZ - 1) * 6); let c = 0;
    for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, d = a + NX, e = d + 1; idx[c++] = a; idx[c++] = d; idx[c++] = b; idx[c++] = b; idx[c++] = d; idx[c++] = e; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aH', new THREE.BufferAttribute(ah, 1)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.U = { uHS: { value: 0 }, uKN: { value: this.kNorm }, uMap: { value: tex }, uN: { value: nrm }, uLight: { value: new THREE.Vector3(-0.55, 0.38, -0.6).normalize() } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.U,
      vertexShader: `attribute float aH; uniform float uHS; varying vec2 vUv; varying vec3 vP;
        void main(){ vec3 p = position; p.y = (aH-0.5)*uHS; vUv = vec2(p.x+0.5, p.z+0.5); vP = p; gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
      fragmentShader: `uniform sampler2D uMap, uN; uniform float uHS, uKN; uniform vec3 uLight; varying vec2 vUv; varying vec3 vP;
        void main(){
          vec2 tuv = vec2(vUv.x, 1.0-vUv.y);
          vec3 col = texture2D(uMap, tuv).rgb;
          vec3 n = texture2D(uN, tuv).rgb*2.0-1.0;
          float k = clamp(uHS/uKN, 0.0, 1.0);
          float F = 260.0*6.2831;
          vec2 wv = vec2(cos(vUv.x*F)*sin(vUv.y*F*1.03), sin(vUv.x*F)*cos(vUv.y*F*1.03))*0.10;
          vec3 N = normalize(vec3((n.x+wv.x)*k, 1.0, (-n.y+wv.y)*k));
          float diff = max(dot(N,uLight),0.0);
          float amb = 0.42, dg = 0.95;
          vec3 V = normalize(cameraPosition - vP); vec3 Hh = normalize(uLight+V);
          float sp = pow(max(dot(N,Hh),0.0), 48.0)*0.16*k;
          vec3 c = col*(amb + dg*diff)/(amb + dg*uLight.y) + sp*vec3(1.0,0.95,0.88);
          gl_FragColor = vec4(c,1.0);
        }`
    });
    this.mesh = new THREE.Mesh(g, m); this.mesh.frustumCulled = false; this.scene.add(this.mesh);
  }
  hAt(x, z) { // mirrored bilinear sample of height grid; crop occupies x,z in [-0.5,0.5]
    const mir = v => { let m = ((v % 2) + 2) % 2; return m <= 1 ? m : 2 - m; };
    const u = mir(x + 0.5) * (this.G - 1), v = mir(z + 0.5) * (this.G - 1);
    const i = Math.min(Math.floor(u), this.G - 2), j = Math.min(Math.floor(v), this.G - 2), fu = u - i, fv = v - j, G = this.G, h = this.h;
    return (h[j * G + i] * (1 - fu) + h[j * G + i + 1] * fu) * (1 - fv) + (h[(j + 1) * G + i] * (1 - fu) + h[(j + 1) * G + i + 1] * fu) * fv;
  }
  ground(x, z, hs) { let m = -1; for (const [dx, dz] of [[0, 0], [0.012, 0], [-0.012, 0], [0, 0.012], [0, -0.012]]) m = Math.max(m, (this.hAt(x + dx, z + dz) - 0.5) * hs); return m; }
}

// ---------------------------------------------------------------- post processing
const rtScene = new THREE.WebGLRenderTarget(W, H, { depthTexture: new THREE.DepthTexture(W, H), type: THREE.UnsignedByteType });
const rtHalf = new THREE.WebGLRenderTarget(W / 2, H / 2), rtQ1 = new THREE.WebGLRenderTarget(W / 4, H / 4), rtQ2 = new THREE.WebGLRenderTarget(W / 4, H / 4);
const rtA = new THREE.WebGLRenderTarget(W, H), rtB = new THREE.WebGLRenderTarget(W, H);
for (const r of [rtHalf, rtQ1, rtQ2]) { r.texture.minFilter = r.texture.magFilter = THREE.LinearFilter; }
const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; quadScene.add(quad);
const QVS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const blurMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uR: { value: 1 } }, vertexShader: QVS,
  fragmentShader: `uniform sampler2D tSrc; uniform vec2 uPx; uniform float uR; varying vec2 vUv;
    void main(){ vec3 c = vec3(0.0); float w = 0.0;
      for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ float k = (i==0?2.0:1.0)*(j==0?2.0:1.0); c += texture2D(tSrc, vUv+vec2(float(i),float(j))*uPx*uR).rgb*k; w+=k; }
      gl_FragColor = vec4(c/w,1.0); }`
});
const postMat = new THREE.ShaderMaterial({
  uniforms: {
    tCol: { value: null }, tDep: { value: null }, tHalf: { value: null }, tQ: { value: null }, uNear: { value: 0.05 }, uFar: { value: 200 },
    uFocus: { value: 5 }, uAper: { value: 0 }, uG: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uGMix: { value: 0 }, uGSweep: { value: 0 }, uVig: { value: 0.35 }, uFogStart: { value: 0 }, uBloom: { value: 0 }, uBloomTh: { value: 0.6 }
  }, vertexShader: QVS,
  fragmentShader: `uniform sampler2D tCol, tDep, tHalf, tQ; uniform float uNear, uFar, uFocus, uAper, uGMix, uGSweep, uVig, uFogStart, uBloom, uBloomTh; uniform vec4 uG[6]; varying vec2 vUv;
    float linZ(float d){ return (uNear*uFar)/(uFar - d*(uFar-uNear)); }
    vec3 grade(vec3 c, vec4 g0, vec4 g1){ c = c*g0.rgb*g0.a; float l = dot(c, vec3(0.299,0.587,0.114)); c = mix(vec3(l), c, g1.a); return c + g1.rgb*(1.0-c); }
    void main(){
      float d = texture2D(tDep, vUv).r; float z = linZ(d);
      if(d>=0.99999) z = uFar;
      float coc = uAper*abs(1.0/z - 1.0/uFocus);
      vec3 c0 = texture2D(tCol, vUv).rgb, c1 = texture2D(tHalf, vUv).rgb, c2 = texture2D(tQ, vUv).rgb;
      vec3 c = mix(c0, c1, smoothstep(0.0, 0.35, coc)); c = mix(c, c2, smoothstep(0.35, 1.0, coc));
      c += max(c2 - uBloomTh, 0.0) * uBloom;
      float s = vUv.x*0.7 + clamp(log(z+1.0)/4.0,0.0,1.0)*0.3;
      float m = clamp(uGMix*(1.0+uGSweep) - s*uGSweep, 0.0, 1.0); m = m*m*(3.0-2.0*m);
      vec4 g0 = mix(uG[0], uG[3], m), g1 = mix(uG[1], uG[4], m), g2 = mix(uG[2], uG[5], m);
      float fog = 1.0 - exp(-max(z-uFogStart,0.0)*g2.a);
      c = mix(c, g2.rgb, fog);
      c = grade(c, g0, g1);
      vec2 q = (vUv-0.5)*vec2(1.0,0.85); c *= 1.0 - uVig*pow(clamp(length(q)*1.35,0.0,1.0), 2.4);
      gl_FragColor = vec4(c,1.0);
    }`
});
const compMat = new THREE.ShaderMaterial({
  uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 0 }, uFade: { value: 1 }, uZoom: { value: 0 }, uCurU: { value: 0 }, uCurType: { value: 0 }, uCurOn: { value: 0 }, tCur: { value: null }, uCurRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uTime: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uAsp: { value: ASP } },
  vertexShader: QVS,
  fragmentShader: `uniform sampler2D tA, tB, tCur; uniform vec4 uCurRect; uniform float uMix, uFade, uTime, uAsp, uZoom, uCurU, uCurType, uCurOn; uniform vec2 uCenter; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
    float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }

    float h1(float n){ return fract(sin(n*127.1)*43758.5453); }
    vec3 curPal(float t, float k){
      if (t < 0.5) { if (k < 0.25) return vec3(0.18,0.32,0.20); if (k < 0.5) return vec3(0.34,0.50,0.27); if (k < 0.75) return vec3(0.55,0.62,0.30); if (k < 0.9) return vec3(0.28,0.42,0.40); return vec3(0.52,0.45,0.70); }
      if (t < 1.5) { if (k < 0.3) return vec3(0.42,0.55,0.25); if (k < 0.55) return vec3(0.62,0.68,0.32); if (k < 0.8) return vec3(0.24,0.37,0.23); return vec3(0.78,0.74,0.42); }
      if (k < 0.3) return vec3(0.16,0.14,0.18); if (k < 0.55) return vec3(0.42,0.18,0.24); if (k < 0.8) return vec3(0.22,0.28,0.18); return vec3(0.55,0.30,0.45);
    }
    vec3 curtain(vec3 col, vec2 uv){
      float u = uCurU;
      float zoomF = exp(-0.9 * u);
      vec2 fuv = uCurRect.xy + uCurRect.zw * (0.5 + (vec2((uv.x - 0.5) * uAsp / 1.6, uv.y - 0.5)) * zoomF);
      vec3 base = texture2D(tCur, fuv, 1.0).rgb * (uCurType > 1.5 ? 0.55 : 0.85);
      float fill = 1.0 - smoothstep(0.0, 0.45, abs(u));
      col = mix(col, base, fill);
      float vis = smoothstep(-1.0, -0.55, u) * (1.0 - smoothstep(0.55, 1.0, u));
      float grow = exp(1.5 * u);
      vec2 p = vec2(uv.x * uAsp, uv.y), c = vec2(0.5 * uAsp, 0.5);
      if (uCurType > 1.5) return col;
      for (int i = 0; i < 46; i++) {
        float fi = float(i);
        float a = h1(fi + 1.3), b = h1(fi + 7.7), cc = h1(fi + 3.1), d = h1(fi + 11.9), e = h1(fi + 5.5);
        float al = 0.0, along = 0.0, across = 0.0, w_ = 0.0, top_ = 0.0;
        if (uCurType < 1.5) {
          float y = uCurType < 0.5 ? p.y : 1.0 - p.y;
          float x0 = c.x + (a - 0.5) * uAsp * 1.25 * grow;
          float top = (0.35 + 0.75 * b) * min(0.7 + 0.5 * grow, 3.0);
          along = clamp(y / top, 0.0, 1.0);
          float w = (0.02 + 0.045 * cc) * grow * (uCurType > 0.5 ? 2.1 : 1.5) * (1.0 - 0.75 * along * along) * (0.92 + 0.12 * sin(along * 6.0 + fi * 3.0));
          float xc = x0 + (d - 0.5) * 0.35 * y * y * grow;
          across = (p.x - xc) / max(w, 1e-4); w_ = w; top_ = top;
          al = smoothstep(1.0, 0.6, abs(across) + 0.07 * sin(y * 90.0 + fi * 7.0)) * smoothstep(top, top - 0.04 * grow, y) * step(-0.1, y);
        } else {
          vec2 dir = normalize(vec2(a, b) - 0.5 + 1e-3);
          vec2 q0 = c + dir * vec2(uAsp, 1.0) * (0.15 + 0.6 * cc) * grow;
          float ang = atan(dir.y, dir.x); vec2 dq = p - q0; dq = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * dq;
          vec2 r = vec2(0.10 + 0.14 * d, 0.02 + 0.03 * e) * grow;
          along = dq.x / r.x * 0.5 + 0.5; across = dq.y / r.y;
          al = smoothstep(1.0, 0.7, length(dq / r));
        }
        vec2 tuv = uCurRect.xy + uCurRect.zw * (vec2(0.15 + 0.5 * a, 0.1 + 0.3 * b) + vec2(across * w_, along * top_) * 0.55 / grow);
        tuv = clamp(tuv, uCurRect.xy, uCurRect.xy + uCurRect.zw);
        vec3 sc = texture2D(tCur, tuv).rgb * (0.92 + 0.16 * e);
        col = mix(col, sc, al * vis);
      }
      return col;
    }
    void main(){
      vec3 a = texture2D(tA, vUv).rgb;
      if(uZoom>0.001){ vec2 dv = (vUv-0.5); float r = length(dv*vec2(uAsp,1.0)); vec3 acc=a; float ws=1.0;
        for(int i=1;i<10;i++){ float k = float(i)/9.0; float w = 1.0-k*0.6; acc += texture2D(tA, vUv - dv*k*uZoom*smoothstep(0.05,0.6,r)).rgb*w; ws+=w; }
        a = acc/ws; }
      vec3 c = a;
      if(uMix>0.0){
        vec3 b = texture2D(tB, vUv).rgb;
        vec2 p = (vUv-uCenter)*vec2(uAsp,1.0);
        float ang = 0.6 + fbm(vUv*1.5)*2.2;
        vec2 sp = mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*vUv*vec2(uAsp,1.0);
        float strokes = fbm(sp*vec2(3.0,26.0));
        float v = 0.5*strokes + 0.5*(1.0 - clamp(length(p)*0.9,0.0,1.0));
        float th = 1.0 - uMix*1.35;
        float m = smoothstep(th, th+0.07, v);
        c = mix(a, b, m);
      }
      if (uCurOn > 0.5) c = curtain(c, vUv);
      float g = hash(vUv*vec2(1931.0,1171.0)+fract(uTime*7.13)) - 0.5;
      c += g*0.012;
      gl_FragColor = vec4(c*uFade, 1.0);
    }`
});
function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }


// ---------------------------------------------------------------- painterly filter (Kuwahara + flow smear)
const rtK = new THREE.WebGLRenderTarget(W / 2, H / 2), rtPaint = new THREE.WebGLRenderTarget(W, H);
rtK.texture.minFilter = rtK.texture.magFilter = THREE.LinearFilter;
const kuwMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uPx: { value: new THREE.Vector2(2 / W, 2 / H) } }, vertexShader: QVS,
  fragmentShader: `uniform sampler2D tSrc; uniform vec2 uPx; varying vec2 vUv;
    void main(){
      vec3 m0=vec3(0.),m1=vec3(0.),m2=vec3(0.),m3=vec3(0.),s0=vec3(0.),s1=vec3(0.),s2=vec3(0.),s3=vec3(0.);
      for(int j=-3;j<=3;j++) for(int i=-3;i<=3;i++){
        vec3 c = texture2D(tSrc, vUv + vec2(float(i),float(j))*uPx).rgb; vec3 c2 = c*c;
        if(i<=0&&j<=0){m0+=c;s0+=c2;} if(i>=0&&j<=0){m1+=c;s1+=c2;} if(i<=0&&j>=0){m2+=c;s2+=c2;} if(i>=0&&j>=0){m3+=c;s3+=c2;}
      }
      float n = 16.0;
      m0/=n; m1/=n; m2/=n; m3/=n;
      vec3 v0=abs(s0/n-m0*m0), v1=abs(s1/n-m1*m1), v2=abs(s2/n-m2*m2), v3=abs(s3/n-m3*m3);
      float a0=v0.r+v0.g+v0.b, a1=v1.r+v1.g+v1.b, a2=v2.r+v2.g+v2.b, a3=v3.r+v3.g+v3.b;
      vec3 r = m0; float b = a0;
      if(a1<b){b=a1;r=m1;} if(a2<b){b=a2;r=m2;} if(a3<b){b=a3;r=m3;}
      gl_FragColor = vec4(r,1.0);
    }` });
const smearMat = new THREE.ShaderMaterial({ uniforms: { tK: { value: null }, tO: { value: null }, uPx: { value: new THREE.Vector2(1 / W, 1 / H) }, uPaint: { value: 1 } }, vertexShader: QVS,
  fragmentShader: `uniform sampler2D tK, tO; uniform vec2 uPx; uniform float uPaint; varying vec2 vUv;
    float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
    void main(){
      vec3 o = texture2D(tO, vUv).rgb;
      vec2 e = uPx*2.5;
      float gx = lum(texture2D(tK, vUv+vec2(e.x,0.)).rgb) - lum(texture2D(tK, vUv-vec2(e.x,0.)).rgb);
      float gy = lum(texture2D(tK, vUv+vec2(0.,e.y)).rgb) - lum(texture2D(tK, vUv-vec2(0.,e.y)).rgb);
      vec2 dir = normalize(vec2(-gy, gx) + vec2(0.0006, 0.0011));
      vec3 acc = vec3(0.); float ws = 0.;
      for(int i=-5;i<=5;i++){ float w = exp(-float(i*i)/16.0); acc += texture2D(tK, vUv + dir*float(i)*uPx*1.7).rgb*w; ws += w; }
      vec3 p = acc/ws;
      float br = sin(dot(vUv/uPx, vec2(-dir.y, dir.x))*1.1);
      p *= 1.0 + br*0.025;
      p = mix(p, o, 0.18);
      gl_FragColor = vec4(mix(o, p, uPaint), 1.0);
    }` });

const GRADES = {
  neutral: [[1, 1, 1, 1], [0, 0, 0, 1.0], [0.62, 0.66, 0.72, 0.004]],
  morning: [[0.88, 0.95, 1.08, 1.04], [0.05, 0.06, 0.09, 0.78], [0.74, 0.80, 0.90, 0.055]],
  noon: [[1.10, 1.03, 0.88, 1.10], [0.03, 0.02, 0.0, 1.22], [0.95, 0.88, 0.70, 0.012]],
  sunset: [[1.14, 0.88, 0.84, 0.97], [0.07, 0.02, 0.06, 1.06], [0.90, 0.60, 0.58, 0.035]],
  dusk: [[0.78, 0.74, 1.02, 0.80], [0.04, 0.02, 0.10, 0.85], [0.36, 0.30, 0.50, 0.05]],
  micro: [[1.02, 1.0, 1.0, 1.04], [0.0, 0.0, 0.02, 1.08], [0.80, 0.78, 0.92, 1.6]],
  warm: [[1.04, 1.0, 0.95, 1.04], [0.01, 0.0, 0.0, 1.08], [0.85, 0.80, 0.75, 0.006]],
  snow: [[0.96, 0.99, 1.04, 1.06], [0.02, 0.03, 0.05, 1.0], [0.85, 0.87, 0.92, 0.008]],
  starry: [[1.02, 1.0, 1.02, 1.03], [0.0, 0.0, 0.01, 1.08], [0.10, 0.16, 0.36, 0.003]],
  ow: [[1.02, 1.0, 0.97, 1.04], [0.0, 0.0, 0.01, 1.12], [0.8, 0.8, 0.9, 0.0]],
};

// ---------------------------------------------------------------- render one shot to target
const cam = new THREE.PerspectiveCamera(35, ASP, 0.05, 200);
function renderShot(sh, target) {
  const hf = sh.hfov || 58;
  cam.fov = 2 * Math.atan(Math.tan(hf * Math.PI / 360) / ASP) * 180 / Math.PI;
  cam.near = sh.near || 0.05; cam.far = sh.far || 200; cam.updateProjectionMatrix();
  cam.position.set(...sh.pos); cam.up.set(0, 1, 0); cam.lookAt(...sh.look);
  if (sh.roll) cam.rotateZ(sh.roll);
  renderer.setClearColor(sh.clear || 0x050505, 1);
  if (sh.before) sh.before(cam);
  renderer.setRenderTarget(rtScene); renderer.render(sh.scene, cam);
  let colTex = rtScene.texture;
  if (sh.paint > 0.001) {
    kuwMat.uniforms.tSrc.value = rtScene.texture; pass(kuwMat, rtK);
    smearMat.uniforms.tK.value = rtK.texture; smearMat.uniforms.tO.value = rtScene.texture; smearMat.uniforms.uPaint.value = sh.paint; pass(smearMat, rtPaint);
    colTex = rtPaint.texture;
  }
  blurMat.uniforms.tSrc.value = colTex; blurMat.uniforms.uPx.value.set(1 / W, 1 / H); blurMat.uniforms.uR.value = 1.0; pass(blurMat, rtHalf);
  blurMat.uniforms.tSrc.value = rtHalf.texture; blurMat.uniforms.uPx.value.set(2 / W, 2 / H); blurMat.uniforms.uR.value = 1.5; pass(blurMat, rtQ1);
  blurMat.uniforms.tSrc.value = rtQ1.texture; blurMat.uniforms.uPx.value.set(4 / W, 4 / H); blurMat.uniforms.uR.value = 1.5; pass(blurMat, rtQ2);
  const P = postMat.uniforms;
  P.tCol.value = colTex; P.tDep.value = rtScene.depthTexture; P.tHalf.value = rtHalf.texture; P.tQ.value = rtQ2.texture;
  P.uNear.value = cam.near; P.uFar.value = cam.far; P.uFocus.value = sh.focus || 5; P.uAper.value = sh.aper || 0;
  const ga = GRADES[sh.gradeA || 'neutral'], gb = GRADES[sh.gradeB || sh.gradeA || 'neutral'];
  for (let i = 0; i < 3; i++) { P.uG.value[i].set(...ga[i]); P.uG.value[i + 3].set(...gb[i]); }
  if (sh.fogMul) { P.uG.value[2].w *= sh.fogMul; P.uG.value[5].w *= sh.fogMul; }
  P.uBloom.value = sh.bloom || 0; P.uBloomTh.value = sh.bloomTh ?? 0.6; P.uGMix.value = sh.gmix || 0; P.uGSweep.value = sh.sweep || 0; P.uVig.value = sh.vig ?? 0.38; P.uFogStart.value = sh.fogStart || 0;
  pass(postMat, target);
}

// ---------------------------------------------------------------- worlds
const worlds = {};
const micro = new MicroWorld();
const pond = new MicroWorld('pond', [-1.4, 1.4, -2.7, 0.6, 600, 700], 0.008);
let galBridge, galMagpie;

// ---------------------------------------------------------------- the film timeline
const T = { micro0: 60, end: 120 };
export const DURATION = T.end;

function bridgeShot(t) {
  const w = worlds.bridge;
  w.set({ uOpen: lin(t, 7.0, 13.6), uSmooth: ramp(t, 12.6, 16.2), uFly: ramp(t, 8.0, 15.5), uStrokeA: ramp(t, 8.0, 12.0), uGal: 1 - ramp(t, 11.5, 17.5), uTime: t });
  galBridge.userData.U.uGalA.value = 1 - 0.55 * ramp(t, 11.5, 16);
  const pos = track([
    [0, [0.30, 0.10, 6.4]], [7, [-0.2, 0.02, 3.0], 'out'], [10.5, [-0.55, 0.06, 2.5]], [13.6, [0.38, 0.0, 1.8]], [16.0, [0.12, -0.10, 0.2]],
    [18.0, [0.0, -0.25, -1.6], 'in'], [21.5, [0.03, -0.50, -2.3]], [25.5, [0.18, -0.55, -2.8]], [30, [0.05, -0.47, -3.1]], [34, [-0.10, -0.45, -3.3]],
    [38, [0.0, -0.45, -3.4], 'out'], [44, [-0.08, -0.44, -3.55]], [50, [0.08, -0.44, -3.7]], [55, [0.0, -0.46, -3.85]], [60.2, [0.0, -0.50, -4.5], 'io']], t);
  const look = track([
    [0, [0.05, 0.05, -1.8]], [7, [0, 0, -2.2]], [10.5, [0, 0, -2.6]], [13.6, [0, 0, -3.2]], [18, [0, -0.15, -8]], [21.5, [0.1, -0.9, -10]],
    [25.5, [-4.0, 0.2, -10]], [30, [1.8, 0.6, -10]], [34, [0.2, 1.0, -10]], [38, [0.0, 1.3, -10]], [44, [-0.9, 1.25, -10]], [50, [0.9, 1.3, -10]],
    [55, [0.0, 1.1, -10]], [58, [0.0, -0.5, -9.5], 'io'], [60.2, [0.0, -1.0, -9.0]]], t);
  const gal = 1 - ramp(t, 13, 17);
  const sh = { scene: w.scene, clear: w.cfg.clear, pos, look, hfov: 58 + 4 * ramp(t, 15, 22),
    focus: gal * Math.max(pos[2] + 2.4, 1.2) + (1 - gal) * (5.0 - 2.2 * ramp(t, 55, 59.5)),
    aper: 0.14 * gal + 0.12 * (1 - gal) + 0.22 * ramp(t, 56, 59.5) };
  const tod = [[38, 'neutral', 'morning'], [42.5, 'morning', 'noon'], [47, 'noon', 'sunset'], [51.5, 'sunset', 'dusk'], [55, 'dusk', 'neutral']];
  sh.gradeA = 'neutral'; sh.gradeB = 'neutral'; sh.gmix = 0; sh.sweep = 1.6;
  for (const [t0, a, b] of tod) if (t >= t0) { sh.gradeA = a; sh.gradeB = b; sh.gmix = lin(t, t0, t0 + 3.4); }
  sh.vig = 0.38 + 0.35 * gal;
  return sh;
}

function microShot(t) {
  const lt = t - 58.5;
  const hs = 0.024 * ramp(lt, 1.5, 7.5);
  micro.U.uHS.value = hs;
  const pos = track([[0, [0.093, 0.95, 0.04]], [5.5, [0.09, 0.22, 0.05], 'out'], [8.5, [0.02, 0.11, 0.12]], [12, [-0.22, 0.075, 0.16]], [15, [-0.47, 0.085, 0.02]], [17.5, [-0.50, 0.25, -0.12]], [18.8, [-0.50, 0.42, -0.18], 'in']], lt);
  const look = track([[0, [0.093, 0, 0.0]], [5.5, [0.09, 0, 0.0]], [8.5, [-0.12, -0.02, -0.06]], [12, [-0.40, 0.0, 0.08]], [15, [-0.39, 0.0, 0.10]], [17.5, [-0.42, 0.05, 0.02]], [18.8, [-0.45, 0.2, 0.05]]], lt);
  pos[1] = Math.max(pos[1], micro.ground(pos[0], pos[2], hs) + 0.03);
  const dl = Math.hypot(pos[0] - look[0], pos[1] - look[1], pos[2] - look[2]);
  return { scene: micro.scene, pos, look, hfov: 64, near: 0.002, far: 12, focus: Math.min(dl, pos[1] * 1.8), aper: 0.03, gradeA: 'micro', fogStart: 0.3 + pos[1] * 1.3, vig: 0.42, clear: 0xcfc6dc };
}

function gardenShot(key, t, t0, keysPos, keysLook, extra) {
  const w = worlds[key]; w.set({ uOpen: 1, uSmooth: 1, uFly: 0, uStrokeA: 1, uGal: 0, uTime: t });
  return { scene: w.scene, clear: w.cfg.clear, pos: track(keysPos, t - t0), look: track(keysLook, t - t0), hfov: 62, focus: 4, aper: 0.1, gradeA: 'warm', ...extra };
}
const irisesShot = t => gardenShot('irises', t, 75.5, [[0, [-0.30, 0.05, 0.3]], [8.7, [0.35, -0.12, -0.9]]], [[0, [0.4, -0.1, -6]], [8.7, [-0.4, -0.25, -6]]], { focus: 2.6 });
const poppyShot = t => gardenShot('poppy', t, 82.5, [[0, [0.25, -0.05, 0.2]], [9.7, [-0.25, -0.35, -2.4]]], [[0, [-0.3, -0.1, -10]], [9.7, [0.7, -0.15, -10]]], { focus: 6 });
const alleeShot = t => gardenShot('allee', t, 90.5, [[0, [0.0, -0.12, 0.2]], [10.2, [0.05, -0.30, -3.6]]], [[0, [0.0, -0.08, -8]], [5, [0.25, -0.1, -8]], [10.2, [-0.15, -0.05, -8]]], { focus: 5 });
function magpieShot(t) {
  const w = worlds.magpie;
  const close = ramp(t, 109, 115);
  w.set({ uOpen: 1 - lin(t, 109.5, 115.5), uSmooth: 1 - ramp(t, 109.0, 112.5), uFly: 0, uStrokeA: 1 - ramp(t, 111, 113.5), uGal: ramp(t, 110.5, 115.5), uTime: t });
  galMagpie.userData.U.uGalA.value = 0.35 + 0.65 * ramp(t, 110.5, 116); galMagpie.visible = t > 109;
  const pos = track([[99, [0.15, -0.02, -0.3]], [107, [-0.2, -0.12, -1.6]], [109.5, [-0.15, -0.08, -1.85], 'out'], [117, [0.0, 0.05, 5.6], 'io'], [120, [0.0, 0.05, 6.2]]], t);
  const look = track([[99, [-0.2, -0.1, -8]], [107, [-0.6, -0.1, -8]], [109.5, [-0.3, 0.0, -8]], [117, [0.0, 0.0, -1.8]]], t);
  return { scene: w.scene, clear: w.cfg.clear, pos, look, hfov: 62 - 4 * close, focus: (1 - close) * 4 + close * Math.max(pos[2] + 1.8, 1.0), aper: 0.1 + 0.08 * close, gradeA: 'snow', vig: 0.38 + 0.35 * ramp(t, 110.5, 116) };
}

const SEQ = [
  [0, 60.2, bridgeShot],
  [58.5, 77.2, microShot],
  [75.5, 84.2, irisesShot],
  [82.5, 92.2, poppyShot],
  [90.5, 100.7, alleeShot],
  [99, 120.01, magpieShot],
];
function frameAt(t) {
  const act = SEQ.filter(s => t >= s[0] && t < s[1]);
  if (act.length === 1) return { a: act[0][2](t), b: null, mix: 0 };
  const [s1, s2] = act;
  return { a: s1[2](t), b: s2[2](t), mix: lin(t, s2[0], s1[1]) };
}


// ---------------------------------------------------------------- short cut (fast immersive -> reveal)
function shortShot(t) {
  const w = worlds.bridge;
  if (t < 10.5) {
    galBridge.visible = false;
    w.set({ uOpen: 1, uSmooth: 1, uFly: 0, uStrokeA: 1, uGal: 0, uTime: t });
    const pos = track([[0, [0.05, -0.42, -0.6]], [2.5, [0.10, -0.52, -2.2]], [5, [-0.05, -0.50, -3.6]], [7.5, [0.05, -0.45, -4.6]], [9.2, [0.0, 0.2, -6.3]], [10.5, [0.0, 1.0, -7.3], 'in']], t);
    const look = track([[0, [0.0, -0.7, -10]], [2.5, [0.3, -0.5, -10]], [5, [-0.6, 0.6, -10]], [7.5, [0, 1.4, -10]], [9.2, [0, 1.4, -10]], [10.5, [0, 1.5, -10]]], t);
    return { sh: { scene: w.scene, clear: w.cfg.clear, pos, look, hfov: 64, focus: 4, aper: 0.08, gradeA: 'neutral', gradeB: 'noon', gmix: lin(t, 5.0, 8.5), sweep: 1.6, vig: 0.4 },
      zoom: 0.05 * (1 - ramp(t, 0, 2.5)) + 0.035 + 0.32 * ramp(t, 8.6, 10.5), fade: ramp(t, 0, 0.5) * (1 - 0.9 * ramp(t, 9.8, 10.5)) };
  }
  galBridge.visible = true;
  galBridge.userData.U.uGalA.value = ramp(t, 11.5, 15);
  w.set({ uOpen: 1 - lin(t, 11.0, 16.0), uSmooth: 1 - ramp(t, 10.8, 13.5), uFly: 0, uStrokeA: 1 - ramp(t, 13, 15.5), uGal: ramp(t, 12, 16), uTime: t });
  const pos = track([[10.5, [0, -0.05, -2.6]], [13, [0, 0, -1.0]], [17, [0, 0, 1.5], 'io'], [28, [0, 0, 2.0]]], t);
  const look = track([[10.5, [0, 0, -10]], [17, [0, 0, -1.8]]], t);
  return { sh: { scene: w.scene, clear: w.cfg.clear, pos, look, hfov: 58, focus: Math.max(pos[2] + 1.8, 0.8), aper: 0.1, gradeA: 'neutral', vig: 0.38 + 0.3 * ramp(t, 13, 17) },
    zoom: 0.3 * (1 - ramp(t, 10.5, 12.2)), fade: (0.1 + 0.9 * ramp(t, 10.5, 11.3)) * (1 - ramp(t, 27, 28)) };
}

// ---------------------------------------------------------------- open-world cut
let OW = null;
function openShot(t) {
  const B = worlds.bridge, D = B.cfg.D, sc = 40 / (2 * B.tanX * D), md = (D + 0.012) * sc;
  const C = [350, 45, -170], M = [350, 45, -170 + md];
  if (t < 16 || t >= 25.5) {
    OW.update(t);
    let pos, look, hf, zoom, paint;
    if (t < 16) {
      pos = track([[0, [-35, 0, 445]], [2.6, [-22, 0, 330]], [4.0, [-8, 14, 250]], [5.2, [4, 40, 200]], [8, [60, 105, 70]], [11, [170, 118, -20]], [13.6, [305, 72, -78]], [16, M, 'io']], t);
      look = track([[0, [-12, 3, 300]], [2.6, [0, 8, 150]], [4.0, [10, 40, 100]], [5.2, [50, 40, 0]], [8, [230, 10, -520]], [11, [340, 30, -300]], [13.6, C], [16, C]], t);
      pos[1] = Math.max(pos[1], OW.H(pos[0], pos[2]) + 2.6);
      if (t < 4.0) look[1] = Math.max(look[1], OW.H(look[0], look[2]) + 3);
      hf = 66 - 8 * ramp(t, 13, 15.9);
      zoom = 0.035 * (1 - ramp(t, 4.5, 6.5)) + 0.03 * ramp(t, 13, 14.5) * (1 - ramp(t, 15, 15.9));
      paint = 1 - ramp(t, 14.6, 15.9);
    } else {
      pos = track([[25.5, M], [27.6, [352, 53, -96], 'out'], [30.5, [330, 108, 40]], [34, [250, 175, 225]]], t);
      look = track([[25.5, C], [27.6, C], [30.5, [350, 20, -240]], [34, [300, 0, -420]]], t);
      hf = 58 + 8 * ramp(t, 26, 30); zoom = 0; paint = ramp(t, 25.6, 27.2);
    }
    return { sh: { scene: OW.scene, pos, look, hfov: hf, near: 0.5, far: 14000, focus: 100, aper: 0, gradeA: 'ow', gradeB: 'neutral', gmix: 1 - Math.min(paint * 1.2, 1), fogMul: 0, vig: 0.36, clear: 0xb8b6d0, paint: 0,
      before: c => OW.sky.position.copy(c.position) }, zoom, fade: ramp(t, 0, 0.3) * (1 - ramp(t, 33.2, 34)) };
  }
  galBridge.visible = false;
  const op = lin(t, 16.0, 17.4) * (1 - lin(t, 23.8, 25.5));
  B.set({ uOpen: op, uSmooth: ramp(t, 16.9, 17.9) * (1 - ramp(t, 23.4, 25.0)), uFly: 0, uStrokeA: ramp(t, 16.4, 17.5) * (1 - ramp(t, 23.6, 25.0)), uGal: 0, uTime: t });
  const pos = track([[16, [0, 0, 0]], [16.7, [0, -0.04, -0.25]], [17.6, [0, -0.22, -1.2]], [19.5, [0.06, -0.47, -2.5]], [21.4, [-0.04, -0.47, -3.7]], [22.7, [0, -0.42, -4.15], 'out'], [24.8, [0, -0.05, -0.5], 'io'], [25.5, [0, 0, 0], 'out']], t);
  const look = track([[16, [0, 0, -10]], [17, [0, -0.1, -10]], [19.5, [0.3, -0.4, -10]], [21.4, [0, 0.9, -10]], [22.7, [0, 1.1, -10]], [24.0, [0, 0.3, -10]], [25.0, [0, 0, -10]], [25.5, [0, 0, -10]]], t);
  const zoom = 0.03 * ramp(t, 17, 18) * (1 - ramp(t, 22, 22.7)) + 0.05 * ramp(t, 23, 23.6) * (1 - ramp(t, 24.9, 25.4));
  return { sh: { scene: B.scene, clear: B.cfg.clear, pos, look, hfov: 58, focus: 1.8 + 2.5 * ramp(t, 17, 18.5) * (1 - ramp(t, 23.5, 25)), aper: 0.08, gradeA: 'neutral', vig: 0.36 }, zoom, fade: 1 };
}

// ---------------------------------------------------------------- fusion cut (2D/3D, natural occlusion transitions)
let CURTEX = null;
const FCUTS = [[6.0, 0.75, 2], [12.4, 0.8, 0], [20.6, 0.8, 1]];   // [cut time, half-duration, curtain type]
function fusionShot(t) {
  let cur = null;
  for (const [tc, hd, ty] of FCUTS) if (Math.abs(t - tc) <= hd) cur = { u: (t - tc) / hd, ty };
  const caption = 0;
  if (t < 6.0) {   // rush down the garden path
    const w = worlds.allee; w.set({ uOpen: 1, uSmooth: 1, uFly: 0, uStrokeA: 1, uGal: 0, uTime: t });
    const pos = track([[0, [0.0, -0.55, 0.6]], [1.5, [0.02, -0.62, -2.0]], [3.5, [-0.03, -0.66, -6.0]], [5.0, [0.0, -0.55, -9.5]], [6.0, [0.0, -0.25, -13.2], 'in']], t);
    const look = track([[0, [0.0, -0.75, -8]], [3.5, [0.05, -0.6, -16]], [5.0, [0.0, -0.3, -18]], [6.0, [0.0, -0.1, -20]]], t);
    return { sh: { scene: w.scene, clear: w.cfg.clear, pos, look, hfov: 70, focus: 6, aper: 0.06, gradeA: 'neutral', vig: 0.4 },
      zoom: 0.035 + 0.25 * ramp(t, 4.8, 6.0), fade: ramp(t, 0, 0.25), cur };
  }
  if (t < 12.4) {  // skim the lily pond surface, looking down at the water like Monet's own view
    const lt = t - 6.0;
    pond.U.uHS.value = 0.004; pond.U.uKN.value = 0.02;
    const pos = track([[0, [0.02, 0.10, 0.55]], [3, [-0.04, 0.085, -0.25]], [5.5, [0.05, 0.08, -0.95]], [6.4, [0.06, 0.07, -1.2]]], lt);
    pos[1] = Math.max(pos[1], pond.ground(pos[0], pos[2], 0.004) + 0.03);
    const sway = Math.sin(lt * 0.9) * 0.03;
    const look = [pos[0] + 0.02 + sway, pos[1] - 0.10, pos[2] - 0.09];
    return { sh: { scene: pond.scene, pos, look, hfov: 70, near: 0.003, far: 12, focus: 0.13, aper: 0.02, gradeA: 'micro', fogStart: 0.6, fogMul: 0.3, vig: 0.38, clear: 0xc9c4dc, roll: Math.sin(lt * 0.7) * 0.05 },
      zoom: 0.06 * (1 - ramp(t, 6.0, 7.0)) + 0.03 + 0.12 * ramp(t, 11.6, 12.4), fade: 1, cur };
  }
  const B = worlds.bridge; galBridge.visible = false;
  if (t < 20.6) {  // inside Water Lily Pond: toward the bridge, up into the willows
    B.set({ uFlat: 1, uOpen: 1, uSmooth: 1, uFly: 0, uStrokeA: 1, uGal: 0, uTime: t });
    const pos = track([[12.4, [-0.05, -0.5, -1.6]], [15, [0.08, -0.5, -2.7]], [17.5, [-0.04, -0.46, -3.7]], [19.2, [0.0, -0.15, -4.5]], [20.6, [0.0, 0.45, -5.0], 'in']], t);
    const look = track([[12.4, [0.3, -0.4, -10]], [15, [-0.3, 0.2, -10]], [17.5, [0.0, 1.0, -10]], [19.2, [0.0, 1.8, -10]], [20.6, [0.0, 2.6, -9]]], t);
    return { sh: { scene: B.scene, clear: B.cfg.clear, pos, look, hfov: 64, focus: 4, aper: 0.08, gradeA: 'neutral', vig: 0.38 },
      zoom: 0.02 + 0.12 * ramp(t, 19.6, 20.6), fade: 1, cur };
  }
  // reveal: pull back to Monet's viewpoint, flatten, settle on the full-screen painting
  const yOff = 0.06 * 2 * B.tanY * (B.cfg.D + 0.012);
  B.set({ uOpen: 1, uSmooth: 1, uFlat: 1 - ramp(t, 21.6, 25.3), uFly: 0, uStrokeA: 1 - ramp(t, 22.5, 24.6), uGal: 0, uTime: t });
  const pos = t >= 25.6 ? [0.0, yOff, 0.0] : track([[20.6, [0.0, 0.25, -3.4]], [22.5, [0.0, 0.12, -1.5]], [25.6, [0.0, yOff, 0.0], 'out']], t);
  const look = t >= 25.6 ? [0.0, yOff, -10] : track([[20.6, [0.0, 1.2, -10]], [22.5, [0.0, 0.4, -10]], [25.6, [0.0, yOff, -10]]], t);
  const hf = 61 - 2.2 * ramp(t, 25.6, 30);
  return { sh: { scene: B.scene, clear: B.cfg.clear, pos, look, hfov: hf, focus: Math.max(1.8 - pos[2], 1.8), aper: 0.07 * (1 - ramp(t, 23, 25.5)), gradeA: 'neutral', vig: 0.3 - 0.12 * ramp(t, 24, 26) },
    zoom: 0.08 * (1 - ramp(t, 20.6, 22.4)), fade: 1 - ramp(t, 29.4, 30), cur };
}

// ---------------------------------------------------------------- fusion2: gallery frame entry (Garden Path) + fusion
let galAllee = null;
const F2_SHIFT = 8.5;
function fusion2Shot(t) {
  if (t >= 14.5) return fusionShot(t - F2_SHIFT);
  const w = worlds.allee;
  const diss = lin(t, 7.0, 10.2);
  galAllee.visible = diss < 0.999;
  galAllee.userData.U.uDiss.value = diss;
  galAllee.userData.U.uGalA.value = 1 - 0.35 * ramp(t, 6.5, 10);
  w.set({ uOpen: 1, uSmooth: 1, uFlat: ramp(t, 2.3, 7.8), uFly: ramp(t, 3.0, 8.5), uStrokeA: ramp(t, 3.0, 6.5), uGal: 1 - ramp(t, 7.5, 10.0), uTime: t });
  const pos = track([[0, [0.25, 0.05, 4.6]], [3.0, [0.05, 0.02, 2.7], 'out'], [5.0, [-0.3, 0.02, 2.1]], [7.0, [0.2, -0.02, 1.5]], [10.0, [0.0, -0.32, 0.2], 'io'], [11.5, [0.0, -0.48, -1.6]], [13.0, [0.02, -0.62, -5.0]], [14.5, [0.0, -0.3, -13.2], 'in']], t);
  const look = track([[0, [0.0, 0.0, -1.4]], [5.0, [0.0, 0.0, -2.4]], [7.0, [0.0, -0.1, -3.0]], [10.0, [0.0, -0.5, -9]], [11.5, [0.0, -0.6, -12]], [13.0, [0.0, -0.4, -17]], [14.5, [0.0, -0.1, -20]]], t);
  const gal = 1 - ramp(t, 7.0, 10.0);
  let cur = null; if (t >= 13.75) cur = { u: (t - 14.5) / 0.75, ty: 2 };
  return { sh: { scene: w.scene, clear: 0x5e5550, pos, look, hfov: 58 + 8 * ramp(t, 8.0, 11.5), focus: gal * Math.max(pos[2] + 1.8, 1.0) + (1 - gal) * 6, aper: 0.1 * gal + 0.05 * (1 - gal), gradeA: 'neutral', vig: 0.4 + 0.3 * gal },
    zoom: 0.03 * ramp(t, 10.5, 12.5) + 0.25 * ramp(t, 13.6, 14.5), fade: ramp(t, 0, 0.6), cur };
}

// ---------------------------------------------------------------- Starry Night
function starryShot(t) {
  const w = worlds.starry;
  const flat = ramp(t, 4.0, 7.5) * (1 - ramp(t, 24.6, 27.0));
  const vol = ramp(t, 5.0, 8.5) * (1 - ramp(t, 24.0, 26.5));
  w.set({ uOpen: 1, uSmooth: 1, uFlat: flat, uVol: vol, uFlowAmt: ramp(t, 1.0, 2.6) * (1 - ramp(t, 26.5, 28.6)), uGlow: ramp(t, 1.2, 3.0) * (1 - ramp(t, 27.0, 29.0)),
    uStrokeA: ramp(t, 4.5, 6.5) * (1 - ramp(t, 24.5, 26.5)), uStrokeScale: 0.8, uFly: 0, uGal: 0, uTime: t });
  const Y0 = (0.5 - 0.43) * 2 * w.tanY * (w.cfg.D + 0.012);
  const HOME = [0, Y0, 0], HLOOK = [0, Y0, -10];
  let pos, look, roll = 0;
  if (t < 4.0) { pos = [0, Y0, -0.04 * ramp(t, 0, 4)]; look = [0, Y0, -10]; }
  else if (t < 21.0) {
    pos = track([[4.0, [0, Y0, -0.04]], [6.0, [0.1, -0.2, -2.0]], [8.0, [0.0, -0.85, -6.0]], [10.0, [0.1, -1.3, -11.0]], [12.5, [-0.2, -1.0, -17.5]],
      [13.8, [-0.4, 1.2, -21.0]], [15.4, [-1.0, 4.4, -25.0]], [17.0, [-1.6, 6.6, -30.0]], [19.0, [3.5, 9.5, -32.0]], [21.0, [8.5, 11.5, -33.0]]], t);
    look = track([[4.0, HLOOK], [6.0, [0.1, -0.4, -12]], [8.0, [0.1, -1.6, -20]], [10.0, [0.3, -1.8, -25]], [12.5, [0.3, -0.2, -32]],
      [13.8, [-0.8, 7.0, -42]], [15.4, [-1.87, 7.0, -52]], [17.0, [-1.87, 7.0, -52]], [19.0, [12.0, 13.0, -52]], [21.0, [20.0, 15.0, -54]]], t);
    roll = -0.42 * ramp(t, 13.2, 16.8) * (1 - ramp(t, 17.0, 19.5)) + 0.12 * ramp(t, 17.5, 19.5) * (1 - ramp(t, 20.0, 21.5));
  } else if (t < 24.8) {
    pos = track([[21.0, [8.5, 11.5, -33.0]], [22.5, [2.5, 4.5, -17.0]], [23.5, [-1.6, 0.7, -4.3]], [24.8, HOME, 'out']], t);
    look = track([[21.0, [20.0, 15.0, -54]], [22.5, [0, 2.0, -40]], [23.5, [0, 0.5, -20]], [24.8, HLOOK]], t);
    roll = 0.12 * (1 - ramp(t, 21.0, 22.0));
  } else { pos = HOME; look = HLOOK; }
  const zoom = 0.02 * ramp(t, 6, 8) * (1 - ramp(t, 20.5, 21.2)) + 0.06 * ramp(t, 21.2, 22.0) * (1 - ramp(t, 24.0, 24.8));
  const fdist = Math.hypot(look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]);
  return { sh: { scene: w.scene, clear: w.cfg.clear, pos, look, roll, hfov: 60.5 + 4 * ramp(t, 6, 9) * (1 - ramp(t, 22.5, 24.6)), near: 0.03, far: 300,
      focus: t < 4 || t > 24.6 ? 1.8 : Math.min(fdist, 25), aper: 0.035 * ramp(t, 5, 7) * (1 - ramp(t, 23.5, 24.8)), gradeA: 'starry', vig: 0.34, bloom: 0.35 * ramp(t, 1.2, 3.0) * (1 - ramp(t, 27, 29)), bloomTh: 0.62 },
    zoom, fade: ramp(t, 0, 0.3) * (1 - ramp(t, 31.0, 31.5)), cur: null };
}

window.renderAt = (t, q = 0.94) => {
  const DB = window.DBG || {};
  for (const w of Object.values(worlds)) if (w.fgMesh) { w.fgMesh.visible = !DB.noFg; w.bgMesh.visible = !DB.noBg; w.strokes.visible = !DB.noSt; if (w.glow) w.glow.visible = !DB.noGl; }
  const shotFn = SHOTS[CUT];
  if (shotFn) {
    const r = shotFn(t);
    { const C = compMat.uniforms; C.uCurOn.value = r.cur ? 1 : 0; if (r.cur) { C.uCurU.value = r.cur.u; C.uCurType.value = r.cur.ty; const ct = CURTEX[r.cur.ty]; C.tCur.value = ct.tex; C.uCurRect.value.set(...ct.rect); } } renderShot(r.sh, rtA);
    const C = compMat.uniforms; C.tA.value = rtA.texture; C.uMix.value = 0; C.uTime.value = t; C.uZoom.value = r.zoom; C.uFade.value = r.fade;
    pass(compMat, null); C.uZoom.value = 0;
    return renderer.domElement.toDataURL('image/jpeg', q);
  }
  const f = frameAt(t);
  renderShot(f.a, rtA);
  if (f.b && f.mix > 0) renderShot(f.b, rtB);
  const C = compMat.uniforms;
  C.tA.value = rtA.texture; C.tB.value = rtB.texture; C.uMix.value = f.b ? f.mix : 0; C.uTime.value = t;
  C.uFade.value = ramp(t, 0, 1.6) * (1 - ramp(t, 118.2, 120));
  pass(compMat, null);
  return renderer.domElement.toDataURL('image/jpeg', q);
};

// ---------------------------------------------------------------- loading: only what the selected cut needs
// cut = URL ?cut=...  (empty = the original 2-minute Monet film)
const CUT = Q.get('cut') || 'monet';
// cut name -> shot function (cuts not listed here use the original Monet sequence in frameAt)
const SHOTS = { starry: starryShot, fusion2: fusion2Shot, fusion: fusionShot, open: openShot, short: shortShot };
const NEEDS = {
  monet:   { worlds: ['bridge', 'irises', 'poppy', 'allee', 'magpie'], micro: true, gal: ['bridge', 'magpie'] },
  short:   { worlds: ['bridge'], gal: ['bridge'] },
  open:    { worlds: ['bridge', 'poppy', 'irises', 'allee', 'magpie'], gal: ['bridge'], ow: true },
  fusion:  { worlds: ['bridge', 'allee'], pond: true, gal: ['bridge'], curtex: true },
  fusion2: { worlds: ['bridge', 'allee'], pond: true, gal: ['bridge', 'allee'], curtex: true },
  starry:  { worlds: ['starry'] },
};
(async () => {
  const need = NEEDS[CUT] || NEEDS.monet;
  const CFG = await loadJSON('data/worlds.json');
  for (const k of need.worlds) { if (!CFG[k]) throw new Error(`worlds.json has no entry "${k}"`); CFG[k].clear = parseInt(CFG[k].clear); worlds[k] = new PaintWorld(k, CFG[k]); }
  await Promise.all([...Object.values(worlds).map(w => w.load()), ...(need.micro ? [micro.load()] : []), ...(need.pond ? [pond.load()] : [])]);
  const gals = need.gal || [];
  if (gals.includes('bridge')) { galBridge = makeGallery(worlds.bridge); worlds.bridge.scene.add(galBridge); }
  if (gals.includes('allee')) { galAllee = makeGallery(worlds.allee); worlds.allee.scene.add(galAllee); }
  if (gals.includes('magpie')) { galMagpie = makeGallery(worlds.magpie); worlds.magpie.scene.add(galMagpie); }
  if (need.curtex) {
    const [ti, tb, ta] = await Promise.all([loadTex('data/irises.jpg'), loadTex('data/bridge.jpg'), loadTex('data/allee.jpg')]);
    CURTEX = { 0: { tex: ti, rect: [0.50, 0.05, 0.45, 0.50] }, 1: { tex: tb, rect: [0.37, 0.79, 0.19, 0.21] }, 2: { tex: ta, rect: [0.35, 0.45, 0.30, 0.30] } };
  }
  if (need.ow) {
    const keys = ['bridge', 'poppy', 'lilies', 'irises', 'allee', 'magpie'];
    const [sky, detail, trees, ...pts] = await Promise.all([loadTex('data/ow_sky.jpg', true), loadTex('data/ow_detail.png', true), loadTex('data/ow_trees.png'), ...keys.map(k => loadTex(k === 'lilies' ? '../img/lilies.jpg' : `data/${k}.jpg`))]);
    const paint = {}, aspect = {}; keys.forEach((k, i) => { paint[k] = pts[i]; aspect[k] = k === 'lilies' ? 2887 / 3000 : worlds[k].meta.aspect; });
    OW = buildOpenWorld(THREE, { sky, detail, trees, paint, aspect });
  }
  window.DURATION = { monet: 120, short: 28, open: 34, fusion: 30, fusion2: 38.5, starry: 32 }[CUT] || 120;
  window.ready = true;
})().catch(e => { console.log('LOADERR ' + e.stack); window.loadError = String(e); });
