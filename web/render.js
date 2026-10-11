#!/usr/bin/env node
// Headless frame renderer for web/film.js
//
//   node web/render.js --cut starry --out frames/starry --range 0 32 --fps 30
//   node web/render.js --cut starry --out frames/check --times 1,5,10.5 --w 960 --h 540
//
// Options
//   --cut NAME          which timeline in film.js (starry | fusion2 | fusion | open | short | monet)
//   --out DIR           output folder for JPG frames (created if missing)
//   --range S E         render every frame between S and E seconds (resumable: existing frames are skipped)
//   --fps N             frames per second for --range (default 30)
//   --times a,b,c       render single stills at these seconds instead (named t<sec>.jpg)
//   --w / --h           output size (default 1920x1080)
//   --quality Q         JPEG quality 0-1 (default 0.94)
//   --gpu               use the real GPU instead of SwiftShader (faster on a desktop with a GPU)
//   --port N            port of the built-in static server (default: random free port)
//   --debug a,b         hide layers to locate artefacts: noFg (depth mesh) noBg (background layer) noSt (strokes) noGl (glows)
// Env
//   CHROME_PATH         Chromium/Chrome executable (auto-detected otherwise)
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path'), http = require('http');

function args() {
  const a = process.argv.slice(2), o = { w: 1920, h: 1080, fps: 30, quality: 0.94, cut: 'starry', gpu: false, port: 0 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--range') { o.range = [+a[++i], +a[++i]]; }
    else if (k === '--times') { o.times = a[++i].split(',').map(Number); }
    else if (k === '--gpu') { o.gpu = true; }
    else if (k.startsWith('--')) { const v = a[++i]; o[k.slice(2)] = isNaN(+v) ? v : +v; }
  }
  if (!o.out || (!o.range && !o.times)) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n')); process.exit(1); }
  return o;
}

function findChrome() {
  const c = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  try { return require('playwright').chromium.executablePath(); } catch (e) { }
  throw new Error('No Chromium found. Set CHROME_PATH=/path/to/chrome');
}

function serve(root, port) {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.bin': 'application/octet-stream', '.json': 'application/json' };
  return new Promise(res => {
    const srv = http.createServer((q, s) => {
      const p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
      if (!p.startsWith(root)) { s.writeHead(403); s.end(); return; }
      fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); s.end(d); });
    }).listen(port, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const o = args();
  fs.mkdirSync(o.out, { recursive: true });
  const root = path.resolve(__dirname, '..');
  const srv = await serve(root, o.port);
  const port = srv.address().port;
  const flags = o.gpu ? ['--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const b = await chromium.launch({ executablePath: findChrome(), args: [...flags, '--no-proxy-server', '--disable-background-networking'] });
  const p = await b.newPage({ viewport: { width: o.w, height: o.h } });
  p.on('console', m => { const t = m.text(); if (!t.includes('Failed to load resource')) console.log('PAGE', t); });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(`http://127.0.0.1:${port}/web/film.html?w=${o.w}&h=${o.h}&cut=${o.cut}`);
  await p.waitForFunction(() => window.ready || window.loadError, null, { timeout: 300000 });
  const le = await p.evaluate(() => window.loadError);
  if (le) { console.log('load error:', le, '\n(did you run the prep step for this cut? see docs/WORKFLOW.md)'); await b.close(); srv.close(); process.exit(1); }

  if (o.debug) await p.evaluate(d => { window.DBG = Object.fromEntries(d.split(',').map(k => [k, 1])); }, String(o.debug));
  let list = [];
  if (o.times) list = o.times.map(t => [t, `t${String(t).replace('.', '_')}`]);
  else for (let f = Math.round(o.range[0] * o.fps); f < Math.round(o.range[1] * o.fps); f++) list.push([f / o.fps, String(f).padStart(5, '0')]);
  const t0 = Date.now(); let n = 0;
  for (const [t, name] of list) {
    const fn = `${o.out}/${name}.jpg`;
    if (!o.times && fs.existsSync(fn)) continue;
    const d = await p.evaluate(([t, q]) => window.renderAt(t, q), [t, o.quality]);
    fs.writeFileSync(fn, Buffer.from(d.split(',')[1], 'base64')); n++;
    if (n % 30 === 0) console.log(`frame ${name}  t=${t.toFixed(2)}s  avg ${((Date.now() - t0) / n / 1000).toFixed(2)} s/frame`);
  }
  console.log(`done: ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${o.out}`);
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
