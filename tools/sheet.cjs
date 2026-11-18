// Contact sheets of every image the extension inverted during a sweep, shown as the site made
// them (no extension), so a person can spot photos that should have been left alone.
//   node sheet.cjs <sweep-addon-json> <out-dir>
const fs = require('fs');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

const [jsonFile, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const seen = new Set(), items = [];
for (const r of JSON.parse(fs.readFileSync(jsonFile, 'utf8'))) {
  for (const i of r.inverted || []) {
    if (!i.src || seen.has(i.src) || i.w < 40 || i.h < 40) continue;   // small icons are not where photos hide
    seen.add(i.src); items.push({ site: r.name, ...i });
  }
}
const PER = 48, pages = [];
for (let p = 0; p * PER < items.length; p++) {
  const cells = items.slice(p * PER, (p + 1) * PER).map((i, k) =>
    `<div class="c"><img src="${esc(i.src)}" referrerpolicy="no-referrer"><span>${p * PER + k} ${esc(i.site)}</span></div>`).join('');
  const file = path.join(outDir, `sheet-${p}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>body{margin:6px;background:#888;font:10px sans-serif;display:grid;grid-template-columns:repeat(8,1fr);gap:4px}
.c{background:#fff;height:128px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;overflow:hidden}
img{max-width:100%;max-height:112px;object-fit:contain}span{background:#000;color:#fff;width:100%;text-align:center}</style>${cells}`);
  pages.push(file);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(items, null, 1));
(async () => {
  // Served over http (not file://) and with the "eager" strategy, so one image that never
  // arrives cannot hold the sheet up.
  const srv = require('http').createServer((q, s) => { let body = null; try { body = fs.readFileSync(path.join(outDir, path.basename(q.url))); } catch (e) {} s.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' }); s.end(body || ''); });
  await new Promise(r => srv.listen(8741, '127.0.0.1', r));
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe').addArguments('-headless', '-width=1280', '-height=840').setPageLoadStrategy('eager');
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
  try {
    for (const [n, f] of pages.entries()) {
      await d.get('http://127.0.0.1:8741/' + path.basename(f));
      await new Promise(r => setTimeout(r, 9000));
      fs.writeFileSync(path.join(outDir, `sheet-${n}.png`), Buffer.from(await d.takeScreenshot(), 'base64'));
    }
  } finally { await d.quit(); srv.close(); }
  console.log(`${items.length} inverted images (40px and up) on ${pages.length} sheet(s) in ${outDir}`);
})();