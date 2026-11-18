// Wide real-site sweep: loads many public pages in headless Firefox and looks for the things a
// person would notice. Nothing is clicked and nothing is typed; a throwaway profile is used.
//
//   node sweep.cjs <extension-dir|none> <out-dir> [sites.json] [dark|light]
//
// Per page it records:
//   - whether the extension is on, and how much work it did (rebuild count, longest pause)
//   - how much of the screenshot is still light
//   - large light boxes that were not darkened
//   - text whose contrast against its background is poor (compare with a `none` run: sites have
//     some of their own)
//   - which images were inverted (to be eyeballed with sheet.cjs)
//   - extension errors in the Browser Console, attributed to the page by time
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { PNG } = require('pngjs');

const [extArg, outDir, sitesFile = 'sites-wide.json', scheme = 'dark'] = process.argv.slice(2);
const withAddon = extArg !== 'none';
fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROBE = `
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 && !isNaN(p[3]) ? p[3] : 1]; };
const vw = innerWidth, vh = innerHeight;
const name = el => el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
// nearest solid background behind an element; null when a picture or gradient is in the way
const backdrop = el => {
  for (let e = el; e; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.backgroundImage !== 'none') return null;
    const c = parse(s.backgroundColor);
    if (c && c[3] > 0.6) return c;
    if (/^(img|video|canvas|iframe|svg)$/.test(e.localName)) return null;
  }
  // nothing painted: the page canvas, which is dark when the root's colour scheme is dark
  return /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? [28, 27, 34, 1] : [255, 255, 255, 1];
};
const out = { title: document.title.slice(0, 70), state: document.documentElement.getAttribute('data-adm'), perf: document.documentElement.getAttribute('data-adm-perf'),
  textLen: (document.body && document.body.innerText || '').length, lightBoxes: [], badText: [], textChecked: 0, inverted: [], imgs: 0 };

// 1. large light boxes
const seenBox = new Set();
for (const el of document.querySelectorAll('body, body *')) {
  if (seenBox.size > 4000) break; seenBox.add(el);
  if (/^(img|video|canvas|iframe|svg|picture|input|textarea|select|button)$/.test(el.localName)) continue;
  const r = el.getBoundingClientRect();
  const w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
  if (w < 80 || h < 40 || w * h < vw * vh * 0.03) continue;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || +s.opacity < 0.5) continue;
  const c = parse(s.backgroundColor);
  if (c && c[3] > 0.6 && lum(c) > 0.6) out.lightBoxes.push({ el: name(el), bg: s.backgroundColor, area: Math.round(100 * w * h / (vw * vh)) });
  else if (/gradient/.test(s.backgroundImage)) {
    const cols = (s.backgroundImage.match(/rgba?\\([^)]+\\)/g) || []).map(parse).filter(x => x && x[3] > 0.6);
    if (cols.length && cols.every(x => lum(x) > 0.6)) out.lightBoxes.push({ el: name(el), bg: 'gradient ' + s.backgroundImage.slice(0, 60), area: Math.round(100 * w * h / (vw * vh)) });
  }
}
out.lightBoxes.sort((a, b) => b.area - a.area); out.lightBoxes = out.lightBoxes.slice(0, 5);

// 2. text contrast
const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const doneEl = new Set();
for (let n = tw.nextNode(), i = 0; n && i < 6000; n = tw.nextNode(), i++) {
  const el = n.parentElement;
  if (!el || doneEl.has(el) || n.nodeValue.trim().length < 3) continue;
  doneEl.add(el);
  if (/^(script|style|noscript|option|title)$/.test(el.localName)) continue;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || +s.opacity < 0.6 || parseFloat(s.fontSize) < 6) continue;
  let hid = false; for (let e = el.parentElement; e; e = e.parentElement) { const ps = getComputedStyle(e); if (+ps.opacity < 0.6 || ps.visibility === 'hidden') { hid = true; break; } }
  if (hid) continue;
  if (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') continue;
  const fg = parse(s.color), bg = backdrop(el);
  if (!fg || fg[3] < 0.6 || !bg) continue;
  out.textChecked++;
  const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (ratio < 2.5) out.badText.push({ el: name(el), text: n.nodeValue.trim().slice(0, 30), fg: s.color, bg: 'rgb(' + bg.slice(0, 3).join(', ') + ')', ratio: +ratio.toFixed(2) });
}
out.badCount = out.badText.length; out.badText = out.badText.slice(0, 6);

// 3. images
for (const img of document.querySelectorAll('img, svg image')) {
  const r = img.getBoundingClientRect();
  if (r.width < 24 || r.height < 24) continue;
  out.imgs++;
  if (img.hasAttribute('data-adm-inv')) out.inverted.push({ src: (img.currentSrc || img.src || (img.href && img.href.baseVal) || '').slice(0, 300), w: Math.round(r.width), h: Math.round(r.height) });
}
return out;`;

const CONSOLE = `
return Services.console.getMessageArray().map(m => {
  try { const e = m.QueryInterface(Ci.nsIScriptError); return { msg: e.errorMessage, src: e.sourceName, line: e.lineNumber, ts: m.timeStamp }; }
  catch (x) { return { msg: String(m.message), src: '', ts: m.timeStamp }; }
}).filter(e => /moz-extension|AdaptiveDark/i.test(e.src + ' ' + e.msg));`;

function shotStats(b64) {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  let light = 0, dark = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4 * 7) {
    const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    if (l > 200) light++; else if (l < 70) dark++;
    n++;
  }
  return { light: Math.round(100 * light / n), dark: Math.round(100 * dark / n) };
}

(async () => {
  const sites = JSON.parse(fs.readFileSync(path.resolve(__dirname, sitesFile), 'utf8').replace(/^\uFEFF/, ''));
  let tmp = null;
  if (withAddon) {   // temp copy with the work counters switched on
    const src = path.resolve(extArg);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-sweep-'));
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
    const cj = path.join(tmp, 'content.js'), code = fs.readFileSync(cj, 'utf8');
    if (!code.includes('const PERF_ATTR = false;')) throw new Error('PERF_ATTR flag not found');
    fs.writeFileSync(cj, code.replace('const PERF_ATTR = false;', 'const PERF_ATTR = true;'));
  }
  const opts = new firefox.Options()
    .setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe')
    .addArguments('-headless', '-width=1280', '-height=900')
    .setPreference('layout.css.prefers-color-scheme.content-override', scheme === 'light' ? 1 : 0)
    .setPreference('media.autoplay.default', 5)
    .setPreference('permissions.default.desktop-notification', 2)
    .setPreference('permissions.default.geo', 2);
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 20000 });
  const results = [];
  const save = () => fs.writeFileSync(path.join(outDir, `sweep-${withAddon ? 'addon' : 'none'}-${scheme}.json`), JSON.stringify(results, null, 1));
  try {
    if (withAddon) await driver.installAddon(tmp, true);
    await sleep(1200);
    for (const [name, url] of sites) {
      const r = { name, url, t0: Date.now() };
      try {
        try { await driver.get(url); } catch (e) { if (!/timeout/i.test(String(e))) throw e; r.slow = true; }
        await sleep(4000);
        const top = await driver.executeScript(PROBE);
        const b = await driver.takeScreenshot();
        fs.writeFileSync(path.join(outDir, 'shots', `${name}-${withAddon ? 'a' : 'n'}.png`), Buffer.from(b, 'base64'));
        r.shot = shotStats(b);
        await driver.executeScript('window.scrollTo(0, 1300)');
        await sleep(1800);
        const low = await driver.executeScript(PROBE);
        r.shot2 = shotStats(await driver.takeScreenshot());
        Object.assign(r, { title: top.title, state: low.state, perf: low.perf, textLen: top.textLen, imgs: top.imgs + low.imgs,
          lightBoxes: [...top.lightBoxes, ...low.lightBoxes].sort((a, b) => b.area - a.area).slice(0, 5),
          textChecked: top.textChecked + low.textChecked, badCount: top.badCount + low.badCount, badText: [...top.badText, ...low.badText].slice(0, 8),
          inverted: [...top.inverted, ...low.inverted] });
        r.blocked = /just a moment|verif|access denied|captcha|are you a robot|attention required|pardon our interruption|unusual traffic|blocked/i.test(top.title) || top.textLen < 200;
      } catch (e) { r.error = String(e).slice(0, 200); }
      r.t1 = Date.now();
      results.push(r); save();
      const perf = r.perf ? r.perf.split('/') : null;
      console.log(`${name.padEnd(16)} ${r.error ? 'ERROR ' + r.error.slice(0, 80) : `${r.blocked ? 'BLOCKED ' : ''}state=${r.state} light=${r.shot.light}/${r.shot2.light}% boxes=${r.lightBoxes.length} badText=${r.badCount}/${r.textChecked} inv=${r.inverted.length}/${r.imgs}${perf ? ` work=${perf[1]}ms max=${perf[2]}ms` : ''}`}`);
    }
    await driver.setContext(firefox.Context.CHROME);
    const cons = await driver.executeScript(CONSOLE);
    for (const c of cons) {
      const site = results.find(r => c.ts >= r.t0 && c.ts <= r.t1 + 500);
      const where = site ? site.name : '?';
      if (site) (site.console = site.console || []).push(`${c.src.replace(/^moz-extension:\/\/[^/]+/, '')}:${c.line} ${c.msg.replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(`CONSOLE [${where}] ${c.src.replace(/^moz-extension:\/\/[^/]+/, '')}:${c.line} ${c.msg.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    save();
  } catch (e) {
    console.log('FATAL', String(e && e.stack || e).slice(0, 1000));
  } finally {
    await driver.quit().catch(() => {});
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
