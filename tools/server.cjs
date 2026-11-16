// Local fixture server for Adaptive Dark checks. Port A serves pages, port B plays "another origin".
const http = require('http');

const SVG_LINEART = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#fff"/><path d="M8 8h80v80H8z" fill="none" stroke="#000" stroke-width="6"/><path d="M8 8l80 80M88 8L8 88" stroke="#111" stroke-width="5"/></svg>';
const SVG_PHOTO = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e33"/><stop offset="0.5" stop-color="#3c3"/><stop offset="1" stop-color="#33e"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/></svg>';

const BASIC = (B) => `<!doctype html><html><head><meta charset="utf-8"><title>basic</title>
<link rel="stylesheet" href="/main.css">
<link rel="stylesheet" href="http://127.0.0.1:${B}/cross.css">
<style>
:root{--bg:#ffffff;--tw-bg-opacity:1;--bs-body-bg-rgb:255,255,255;--panel:var(--bg)}
#short{background:var(--bg)}
#short2{border:1px solid var(--line, #dddddd);background:#fff}
#tw{background-color:rgb(255 255 255 / var(--tw-bg-opacity))}
#bs{background-color:rgba(var(--bs-body-bg-rgb),1)}
#nest{background:var(--panel)}
@layer base{#layer{background:#fff;color:#000}}
@media (min-width:1px){#media{background:#fafafa}}
#named{background:white;color:black}
#lossy{height:20px;background:linear-gradient(rgba(255,255,255,0),var(--bg,#fff));background-repeat:no-repeat}
#lossy2{border:1px solid var(--line2,#dddddd);border-bottom:0}
#lossy4{background:var(--bg);background-color:#ffeeee}
</style></head>
<body>
<div id="plain">plain</div><div id="short">short</div><div id="short2">short2</div><div id="tw">tw</div>
<div id="bs">bs</div><div id="nest">nest</div><div id="layer">layer</div><div id="media">media</div>
<div id="named">named</div><div id="cross">cross</div>
<div id="lossy">lossy</div><div id="lossy2">lossy2</div><div id="lossy3">lossy3</div><div id="lossy4">lossy4</div>
<div id="inline" style="background-color:#ffffff;color:#000000">inline</div>
<table><tr><td id="attr" bgcolor="#f6f6ef"><font id="font" color="#000000">attr</font></td></tr></table>
<div id="openhost"></div><div id="closedhost"></div><div id="adopthost"></div>
<img id="lineart" src="/lineart.svg" width="96" height="96"><img id="photo" src="/photo.svg" width="96" height="96">
<img id="xlineart" src="http://127.0.0.1:${B}/lineart.svg" width="96" height="96">
<script>
const mk=(id,mode)=>{const h=document.getElementById(id);const r=h.attachShadow({mode});r.innerHTML='<style>.x{background:#fff;color:#000}</style><div class="x">shadow '+mode+'</div>';return r;};
window.__open=mk('openhost','open');window.__closed=mk('closedhost','closed');
const ar=document.getElementById('adopthost').attachShadow({mode:'open'});ar.innerHTML='<div class="y">adopted</div>';
const ss=new CSSStyleSheet();ss.replaceSync('.y{background:#fff;color:#000}');ar.adoptedStyleSheets=[ss];window.__adopt=ar;
setTimeout(()=>{const d=document.createElement('div');d.id='late';d.style.backgroundColor='#ffffff';d.textContent='late';document.body.appendChild(d);
const s=document.createElement('style');document.head.appendChild(s);s.sheet.insertRule('#plain{outline-color:#000}',0);},300);
</script></body></html>`;

const MAIN_CSS = 'html,body{background:#fff;color:#111}a{color:#00e}#plain{background-color:#f0f0f0;border:1px solid #ccc}:root{--bg2:#ffffff}#lossy3{background:var(--bg2) /* note */;background-size:cover}';
const CROSS_CSS = '#cross{background-color:#ffffff;color:#000000}';

const { PNG } = require('pngjs');
const SVG_GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 4h20v4H2zM2 10h20v4H2zM2 16h20v4H2z" fill="#202122"/></svg>';
function png(w, h, fn) { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), i = (y * w + x) * 4; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = c[3]; } return PNG.sync.write(p); }
const PNG_GLYPH = png(32, 32, (x, y) => (x > 6 && x < 26 && y > 6 && y < 26 ? [16, 16, 16, 255] : [0, 0, 0, 0]));
const PNG_TEX = png(16, 16, (x, y) => { const v = 238 + ((x + y) % 2) * 8; return [v, v, v, 255]; });

const FEATURES = `<!doctype html><html><head><meta charset="utf-8"><title>features</title>
<link rel="stylesheet" href="/main.css">
<style>
.box{width:48px;height:48px;margin:2px;display:inline-block}
@keyframes pulse{from{background-color:#ffffff}to{background-color:#eeeeee}}
#kf{animation:pulse 1000s linear infinite}
#blend{mix-blend-mode:multiply;background:#fff}
#mask{mask-image:url(/glyph.svg);mask-size:contain;background-color:#202122}
#bgicon{background-image:url(/glyph.svg);background-size:contain}
#bgicon2{background:url("/glyph.png") no-repeat center #ffffff}
#bgphoto{background-image:url(/photo.svg)}
#bgtex{width:200px;height:20px;background:url(/tex.png) repeat-x}
#bgdata{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect x='4' y='4' width='16' height='16' fill='%23111'/%3E%3C/svg%3E");background-size:contain}
</style></head><body>
<div id="plain">features</div>
<div class="box" id="kf"></div><div class="box" id="blend"></div><div class="box" id="mask"></div>
<div class="box" id="bgicon"></div><div class="box" id="bgicon2"></div><div class="box" id="bgphoto"></div><div class="box" id="bgdata"></div>
<div id="bgtex"></div>
<div id="inline" style="background-color:#ffffff;color:#000000">inline</div>
<table><tr><td id="attr" bgcolor="#f6f6ef">attr</td></tr></table>
<svg width="48" height="48" id="svg"><image id="svgimage" href="/lineart.svg" width="48" height="48"/></svg>
<picture><source srcset="/lineart.svg" type="image/svg+xml"><img id="pic" src="/photo.svg" width="48" height="48"></picture>
<img id="lineart" src="/lineart.svg" width="48" height="48"><img id="photo" src="/photo.svg" width="48" height="48">
</body></html>`;

const FRAMES = (B) => `<!doctype html><html><head><title>frames</title><style>body{background:#fff;color:#111}</style></head><body>
<div id="plain">frames</div>
<iframe id="same" src="/inner.html" width="200" height="60"></iframe>
<iframe id="cross" src="http://127.0.0.1:${B}/inner.html" width="200" height="60"></iframe>
<iframe id="srcdoc" srcdoc="<style>body{background:#fff;color:#000}</style><div id='plain' style='background:#fafafa'>srcdoc</div>" width="200" height="60"></iframe>
</body></html>`;
const INNER = '<!doctype html><html><head><style>body{background:#ffffff;color:#000000}#plain{background:#f0f0f0}</style></head><body><div id="plain">inner</div></body></html>';
const simple = (title, head) => `<!doctype html><html><head><title>${title}</title>${head}<link rel="stylesheet" href="/main.css"></head><body><div id="plain">${title}</div><div id="inline" style="background-color:#ffffff">inline</div></body></html>`;

function start(A, B) {
  const a = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (type, body, extra) => { res.writeHead(200, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {})); res.end(body); };
    if (u.pathname === '/features.html') return send('text/html', FEATURES);
    if (u.pathname === '/features-csp.html') return send('text/html', FEATURES, { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'" });
    if (u.pathname === '/legacy.html') return send('text/html', '<html><head><title>legacy</title></head><body bgcolor="#ffffff" background="/tex.png" text="#000000" link="#000099" vlink="#464646" alink="#ff0000"><font size="2" face="verdana">old school <a id="lnk" href="/never-visited-' + Date.now() + '">a link</a></font><table><tr><td id="cell" background="/tex.png" width="100" height="30">cell</td></tr></table></body></html>');
    if (u.pathname === '/frames.html') return send('text/html', FRAMES(B));
    if (u.pathname === '/inner.html') return send('text/html', INNER);
    if (u.pathname === '/glyph.svg') return send('image/svg+xml', SVG_GLYPH);
    if (u.pathname === '/glyph.png') return send('image/png', PNG_GLYPH);
    if (u.pathname === '/tex.png') return send('image/png', PNG_TEX);
    if (u.pathname === '/only-light.html') return send('text/html', simple('only-light', '<meta name="color-scheme" content="only light">'));
    if (u.pathname === '/light-only.html') return send('text/html', simple('light-only', '<meta name="color-scheme" content="light only">'));
    if (u.pathname === '/css-light-dark.html') return send('text/html', simple('css-light-dark', '<style>:root{color-scheme:light dark}</style>'));
    if (u.pathname === '/css-body-only-light.html') return send('text/html', simple('css-body', '<style>body{color-scheme:only light}</style>'));
    if (u.pathname === '/meta-light.html') return send('text/html', simple('meta-light', '<meta name="color-scheme" content="light">'));
    if (u.pathname === '/basic.html') return send('text/html', BASIC(B));
    if (u.pathname === '/main.css') return send('text/css', MAIN_CSS);
    if (u.pathname === '/lineart.svg') return send('image/svg+xml', SVG_LINEART);
    if (u.pathname === '/photo.svg') return send('image/svg+xml', SVG_PHOTO);
    if (u.pathname === '/csp.html') return send('text/html',
      '<!doctype html><html><head><title>csp</title><link rel="stylesheet" href="/main.css"></head><body><div id="plain">csp page</div></body></html>',
      { 'Content-Security-Policy': "default-src 'self'; style-src 'self'" });
    if (u.pathname === '/declares-dark.html') return send('text/html',
      '<!doctype html><html><head><title>dd</title><meta name="color-scheme" content="light dark"><link rel="stylesheet" href="/main.css"></head><body><div id="plain">declares dark</div></body></html>');
    if (u.pathname === '/already-dark.html') return send('text/html',
      '<!doctype html><html><head><title>ad</title><style>body{background:#111;color:#eee}#plain{background:#222;color:#ddd}</style></head><body><div id="plain">already dark</div><div id="inline" style="color:#ffffff;background-color:#000000">inline</div></body></html>');
    // Dark base colour, but everything the visitor sees is in white boxes (crowdsupply.com does this).
    const BOXES = '<section id="plain" class="box">white content</section><section class="box">more</section><footer style="height:80px;color:#ccc">footer on the dark base</footer>';
    const BOX_CSS = 'body{margin:0;background:#222;color:#212529}.box{background:#fff;min-height:700px;padding:20px}';
    if (u.pathname === '/dark-base-light-boxes.html') return send('text/html',
      `<!doctype html><html><head><title>dblb</title><style>${BOX_CSS}</style></head><body>${BOXES}</body></html>`);
    // Same, but the white content only arrives 1.2 s after load (script-rendered sites).
    if (u.pathname === '/late-light.html') return send('text/html',
      `<!doctype html><html><head><title>late</title><style>${BOX_CSS}</style></head><body><script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(BOXES)}; }, 1200);</script></body></html>`);
    // A site with its own theme switch: starts dark, script switches it to light on request.
    if (u.pathname === '/theme-switch.html') return send('text/html',
      '<!doctype html><html class="dark"><head><title>ts</title><style>body{margin:0;background:#fff;color:#111}.dark body{background:#111;color:#eee}#plain{min-height:300px}</style></head><body><div id="plain">switchable</div></body></html>');
    if (u.pathname === '/slow.html') {
      // Head arrives immediately, body 2.5 s later: the window should be dark for the whole wait.
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.write('<!doctype html><html><head><title>slow</title><style>body{background:#fff;color:#111}</style></head>' + ' '.repeat(2048));
      setTimeout(() => res.end('<body><div id="plain">slow body</div></body></html>'), 2500);
      return;
    }
    if (u.pathname === '/slowcss.html') return send('text/html',
      '<!doctype html><html><head><title>slowcss</title><link rel="stylesheet" href="/slow.css"></head><body><div id="plain">slow css</div></body></html>');
    if (u.pathname === '/slow.css') { setTimeout(() => send('text/css', MAIN_CSS), 2000); return; }
    res.writeHead(404); res.end('nope');
  });
  const b = http.createServer((req, res) => {
    if (req.url.startsWith('/cross.css')) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(CROSS_CSS); }
    if (req.url.startsWith('/lineart.svg')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(SVG_LINEART); }
    if (req.url.startsWith('/inner.html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(INNER); }
    res.writeHead(404); res.end();
  });
  return Promise.all([new Promise(r => a.listen(A, '127.0.0.1', r)), new Promise(r => b.listen(B, '127.0.0.1', r))]).then(() => ({ close: () => { a.close(); b.close(); } }));
}
module.exports = { start };
