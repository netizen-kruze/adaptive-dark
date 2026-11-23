// Wide real-site sweep: loads many public pages in headless Firefox and looks for the things a
// person would notice. Nothing is clicked and nothing is typed; a throwaway profile is used.
//
//   node sweep.cjs <extension-dir|none> <out-dir> [sites.json] [dark|light]
//
// INNER=2 also follows two links per site (one article/product page, one section page) and writes
// the full page list to <out-dir>/pages.json, which a second run can take as its sites file so
// that both runs see the same pages. QUIET=1 prints nothing (the log file has every line).
// A page that stops answering is recorded as FROZEN and the browser is restarted.
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
const out = { title: document.title.slice(0, 70), state: document.documentElement.getAttribute('data-adm'), why: document.documentElement.getAttribute('data-adm-why'), perf: document.documentElement.getAttribute('data-adm-perf'),
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
  if (img.getAttribute('data-adm-inv') === 'dim') out.dimmed = (out.dimmed || 0) + 1;
  else if (img.hasAttribute('data-adm-inv')) out.inverted.push({ src: (img.currentSrc || img.src || (img.href && img.href.baseVal) || '').slice(0, 300), w: Math.round(r.width), h: Math.round(r.height) });
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

// Same-site links worth following: one deep page (article / product) and one section page.
const LINKS = `
const here = location.hostname.replace(/^www\\./, '');
const seen = new Set(), out = [];
for (const a of document.querySelectorAll('a[href]')) {
  let u; try { u = new URL(a.href); } catch (e) { continue; }
  if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\\./, '') !== here) continue;
  const p = u.pathname;
  if (p === location.pathname || p.length < 2) continue;
  if (/(log|sign)[-_]?(in|out|up|on)|account|cart|basket|checkout|register|subscri|auth|password|download|donate|\\.(pdf|zip|jpe?g|png|gif|mp4|exe|dmg|xml|rss)$/i.test(p + u.search)) continue;
  const key = p.replace(/\\d+/g, '0'); if (seen.has(key)) continue; seen.add(key);
  const r = a.getBoundingClientRect(); if (!r.width || !r.height) continue;
  out.push({ href: u.origin + p + (u.search.length < 80 ? u.search : ''), segs: p.split('/').filter(Boolean).length, len: p.length, digit: /\\d{3,}/.test(p),
    dashes: (p.match(/-/g) || []).length, main: !!a.closest('main, article, [role=main], #content, .content, #main') });
  if (out.length > 400) break;
}
return out;`;
function pickInner(links, n) {
  if (!links.length || n < 1) return [];
  const score = l => Math.min(l.len, 80) + (l.digit ? 15 : 0) + 4 * Math.min(l.dashes, 5) + (l.main ? 10 : 0);
  const deep = links.slice().sort((a, b) => score(b) - score(a))[0];
  const picks = [deep.href];
  const section = links.find(l => l.segs === 1 && l.href !== deep.href) || links.find(l => l.href !== deep.href);
  if (n > 1 && section) picks.push(section.href);
  return picks;
}

const INNER = +process.env.INNER || 0;     // how many inner pages to follow per site (0, 1 or 2)
const guard = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('FROZEN at ' + what)), ms))]);

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
  const tag = `${withAddon ? 'addon' : 'none'}-${scheme}`;
  const results = [], pages = [];
  const save = () => {
    fs.writeFileSync(path.join(outDir, `sweep-${tag}.json`), JSON.stringify(results, null, 1));
    if (INNER) fs.writeFileSync(path.join(outDir, 'pages.json'), JSON.stringify(pages));   // the same pages, for the comparison run
  };
  const logFile = path.join(outDir, `sweep-${tag}.log`);
  fs.writeFileSync(logFile, '');
  const say = s => { fs.appendFileSync(logFile, s + '\n'); if (!process.env.QUIET) console.log(s); };

  let driver = null, pid = 0;
  const open = async () => {
    const opts = new firefox.Options()
      .setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe')
      .addArguments('-headless', '-width=1280', '-height=900')
      .setPreference('layout.css.prefers-color-scheme.content-override', scheme === 'light' ? 1 : 0)
      .setPreference('media.autoplay.default', 5)
      .setPreference('permissions.default.desktop-notification', 2)
      .setPreference('permissions.default.geo', 2);
    const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
    pid = (await driver.getCapabilities()).get('moz:processID') || 0;
    await driver.manage().setTimeouts({ pageLoad: 30000, script: 20000 });
    if (withAddon) await driver.installAddon(tmp, true);
    await sleep(1200);
  };
  const readConsole = async () => {
    try {
      await guard(driver.setContext(firefox.Context.CHROME), 5000, 'console');
      const cons = await guard(driver.executeScript(CONSOLE), 8000, 'console');
      for (const c of cons) {
        const site = results.find(r => c.ts >= r.t0 && c.ts <= r.t1 + 500);
        const line = `${c.src.replace(/^moz-extension:\/\/[^/]+/, '')}:${c.line} ${c.msg.replace(/\s+/g, ' ').slice(0, 200)}`;
        if (site) (site.console = site.console || []).push(line);
        say(`CONSOLE [${site ? site.name : '?'}] ${line.slice(0, 180)}`);
      }
      await guard(driver.setContext(firefox.Context.CONTENT), 5000, 'console');
    } catch (e) { say('CONSOLE unreadable: ' + String(e.message || e).slice(0, 80)); }
  };
  const close = async () => {
    await guard(driver.quit(), 8000, 'quit').catch(() => {});
    if (pid) { try { process.kill(pid); } catch (e) {} }   // only the browser this run started
  };

  // One page: load, look at the top, scroll down in steps (wakes lazy widgets), look again.
  const visit = async (name, url, wantLinks) => {
    const r = { name, url, t0: Date.now() };
    let links = [];
    try {
      try { await guard(driver.get(url), 45000, 'load'); } catch (e) { if (!/timeout/i.test(String(e)) || /FROZEN/.test(String(e))) throw e; r.slow = true; }
      await sleep(wantLinks ? 4000 : 3200);
      const top = await guard(driver.executeScript(PROBE), 25000, 'first look');
      const b = await guard(driver.takeScreenshot(), 20000, 'screenshot');
      fs.writeFileSync(path.join(outDir, 'shots', `${name}-${withAddon ? 'a' : 'n'}.png`), Buffer.from(b, 'base64'));
      r.shot = shotStats(b);
      if (wantLinks) links = await guard(driver.executeScript(LINKS), 20000, 'links');
      for (const y of [900, 1800, 2700, 3600]) { await guard(driver.executeScript(`window.scrollTo(0, ${y})`), 20000, 'scroll ' + y); await sleep(450); }
      await guard(driver.executeScript('window.scrollTo(0, 1300)'), 20000, 'scroll back');
      await sleep(1500);
      const low = await guard(driver.executeScript(PROBE), 25000, 'second look');
      const b2 = await guard(driver.takeScreenshot(), 20000, 'screenshot');
      fs.writeFileSync(path.join(outDir, 'shots', `${name}-${withAddon ? 'a' : 'n'}2.png`), Buffer.from(b2, 'base64'));
      r.shot2 = shotStats(b2);
      Object.assign(r, { title: top.title, state: low.state, why: low.why, perf: low.perf, textLen: top.textLen, imgs: top.imgs + low.imgs,
        lightBoxes: [...top.lightBoxes, ...low.lightBoxes].sort((a, b) => b.area - a.area).slice(0, 5),
        textChecked: top.textChecked + low.textChecked, badCount: top.badCount + low.badCount, badText: [...top.badText, ...low.badText].slice(0, 8),
        inverted: [...top.inverted, ...low.inverted], dimmed: (top.dimmed || 0) + (low.dimmed || 0) });
      r.blocked = /just a moment|verif|access denied|captcha|are you a robot|attention required|pardon our interruption|unusual traffic|blocked|forbidden|error 4\d\d/i.test(top.title) || top.textLen < 200;
    } catch (e) {
      r.error = String(e.message || e).slice(0, 200);
      // No answer from the tab: the page (or the extension on it) has hung. Start a fresh browser.
      if (/FROZEN|script timeout|ScriptTimeout/i.test(String(e))) { r.frozen = true; await readConsole(); await close(); await open(); }
    }
    r.t1 = Date.now();
    results.push(r); pages.push([name, url]); save();
    const perf = r.perf ? r.perf.split('/') : null;
    say(`${name.padEnd(18)} ${r.error ? (r.frozen ? 'FROZEN ' : 'ERROR ') + r.error.slice(0, 80) : `${r.blocked ? 'BLOCKED ' : ''}state=${r.state}${r.why ? '(' + r.why + ')' : ''} light=${r.shot.light}/${r.shot2.light}% boxes=${r.lightBoxes.length} badText=${r.badCount}/${r.textChecked} inv=${r.inverted.length}/${r.imgs}${perf ? ` work=${perf[4] || perf[1]}ms max=${perf[2]}ms` : ''}`}`);
    return r.blocked || r.error ? [] : links;
  };

  try {
    await open();
    for (const [name, url] of sites) {
      const links = await visit(name, url, INNER > 0);
      let k = 0;
      for (const href of pickInner(links, INNER)) await visit(`${name}~${++k}`, href, false);
    }
    await readConsole();
    save();
  } catch (e) {
    say('FATAL ' + String(e && e.stack || e).slice(0, 1000));
  } finally {
    await close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
})();

