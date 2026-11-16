// Drives real Firefox (headless, throwaway profile) with the extension loaded as a temporary add-on.
// Usage: node harness.cjs <extension-dir> <out-dir> local|sites|flash [dark|light]
const fs = require('fs');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { PNG } = require('pngjs');
const { start } = require('./server.cjs');

const [extDir, outDir, mode, scheme] = process.argv.slice(2);
const A = 8731, B = 8732;
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROBE = `
const ids = arguments[0];
const cs = (el) => { if (!el) return null; const s = getComputedStyle(el); return { bg: s.backgroundColor + (s.backgroundImage !== 'none' ? ' img=' + s.backgroundImage + ' rep=' + s.backgroundRepeat : ''), fg: s.color, bd: s.borderTopColor + ' bottom=' + s.borderBottomWidth, filter: s.filter }; };
const out = { url: location.href, state: document.documentElement.getAttribute('data-adm'),
  styleEls: document.querySelectorAll('style[data-adm-s]').length,
  styleLen: (document.querySelector('style[data-adm-s]') || {textContent:''}).textContent.length,
  sheetOk: !!(document.querySelector('style[data-adm-s]') || {}).sheet,
  html: cs(document.documentElement), body: cs(document.body), els: {} };
for (const id of ids) out.els[id] = cs(document.getElementById(id));
if (window.__open) out.els.shadowOpen = cs(window.__open.querySelector('.x'));
if (window.__closed) out.els.shadowClosed = cs(window.__closed.querySelector('.x'));
if (window.__adopt) out.els.adopted = cs(window.__adopt.querySelector('.y'));
return out;`;

const CONSOLE = `
return Services.console.getMessageArray().map(m => {
  try { const e = m.QueryInterface(Ci.nsIScriptError); return { msg: e.errorMessage, src: e.sourceName, line: e.lineNumber, warn: !!(e.flags & 1) }; }
  catch (x) { return { msg: String(m.message), src: '' }; }
}).filter(e => /moz-extension|adaptive|content\\.js|color\\.js|background\\.js/i.test(e.src + ' ' + e.msg));`;

function avgColor(b64) {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4 * 97) { r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

(async () => {
  const srv = await start(A, B);
  const opts = new firefox.Options()
    .setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe')
    .addArguments('-headless', '-width=1280', '-height=900')
    .setPreference('layout.css.prefers-color-scheme.content-override', scheme === 'light' ? 1 : 0)
    .setPreference('devtools.console.stdout.content', true);
  if (process.env.DARK_UI) opts.setPreference('ui.systemUsesDarkTheme', 1).setPreference('browser.theme.content-theme', 0).setPreference('browser.theme.toolbar-theme', 0);
  if (mode === 'flash') opts.setPageLoadStrategy('none');
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  const results = { mode, scheme: scheme || 'dark', pages: [] };
  try {
    results.firefox = (await driver.getCapabilities()).get('browserVersion');
    if (!process.env.NO_ADDON) results.addonId = await driver.installAddon(path.resolve(extDir), true);
    await sleep(1500);
    const shot = async name => { const b = await driver.takeScreenshot(); fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(b, 'base64')); return avgColor(b); };

    if (mode === 'local') {
      const ids = ['plain', 'short', 'short2', 'tw', 'bs', 'nest', 'layer', 'media', 'named', 'cross', 'lossy', 'lossy2', 'lossy3', 'lossy4', 'inline', 'attr', 'font', 'late', 'lineart', 'photo', 'xlineart'];
      for (const p of ['basic', 'csp', 'declares-dark', 'already-dark']) {
        await driver.get(`http://127.0.0.1:${A}/${p}.html`);
        await sleep(3500);
        const r = await driver.executeScript(PROBE, ids);
        r.avg = await shot('local-' + p);
        results.pages.push(r);
      }
    } else if (mode === 'probe') {   // node harness.cjs ext out probe scheme <url> <js-file>
      await driver.get(process.argv[6]);
      await sleep(5000);
      results.probe = await driver.executeScript(fs.readFileSync(process.argv[7], 'utf8'));
      await shot('probe');
      console.log(JSON.stringify(results.probe, null, 1));
    } else if (mode === 'flash') {
      const targets = process.env.FLASH_URLS ? process.env.FLASH_URLS.split(',') : ['slow', 'slowcss', 'basic'].map(p => `http://127.0.0.1:${A}/${p}.html`);
      for (const p of targets) {
        await driver.get('about:blank'); await sleep(800);
        const t0 = Date.now(); const frames = [];
        driver.get(p).catch(() => {});
        while (Date.now() - t0 < (process.env.FLASH_URLS ? 7000 : 4500)) {
          try {
            const b = await driver.takeScreenshot();
            let st = null; try { st = await driver.executeScript("return [location.href, document.documentElement.getAttribute('data-adm'), document.readyState]"); } catch (e) {}
            frames.push({ t: Date.now() - t0, avg: avgColor(b), st });
          } catch (e) { frames.push({ t: Date.now() - t0, err: String(e).slice(0, 80) }); }
        }
        results.pages.push({ page: p, frames });
      }
    } else {
      const sites = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.SITES || 'sites.json'), 'utf8').replace(/^﻿/, ''));
      for (const [name, url] of sites) {
        const r = { name };
        try {
          await driver.get(url);
          await sleep(5000);
          Object.assign(r, await driver.executeScript(PROBE, []));
          r.avg = await shot('site-' + name);
        } catch (e) { r.error = String(e).slice(0, 300); }
        results.pages.push(r);
      }
    }
    await driver.setContext(firefox.Context.CHROME);
    results.console = await driver.executeScript(CONSOLE);
  } catch (e) {
    results.fatal = String(e && e.stack || e).slice(0, 2000);
  } finally {
    await driver.quit().catch(() => {});
    srv.close();
  }
  fs.writeFileSync(path.join(outDir, `result-${mode}-${scheme || 'dark'}.json`), JSON.stringify(results, null, 1));
  // Compact summary on stdout; the full detail is in the JSON file.
  if (results.fatal) console.log('FATAL', results.fatal);
  for (const p of results.pages) {
    if (p.frames) {   // print a frame only when its colour or state differs from the previous one
      let last = ''; const parts = [];
      for (const f of p.frames) { const k = f.err ? 'ERR' : `${f.avg.join(',')} ${f.st ? f.st[1] + '/' + f.st[2] : '-'}`; if (k !== last) { parts.push(`${f.t}ms ${k}`); last = k; } }
      console.log(`${p.page} (${p.frames.length} frames): ` + parts.join(' | ')); continue;
    }
    console.log(`${p.name || p.url} state=${p.state} styleEls=${p.styleEls} styleLen=${p.styleLen} sheetOk=${p.sheetOk} html=${p.html && p.html.bg} body=${p.body && p.body.bg}/${p.body && p.body.fg} avg=${p.avg} ${p.error || ''}`);
    for (const k in p.els || {}) if (p.els[k]) console.log(`   ${k}: bg=${p.els[k].bg} fg=${p.els[k].fg} bd=${p.els[k].bd} ${p.els[k].filter !== 'none' ? p.els[k].filter : ''}`);
  }
  const seen = new Map();
  for (const c of results.console || []) { const k = `${c.src.replace(/^(blob:)?moz-extension:\/\/[^/]+\/[0-9a-f-]{36}/, 'blob').replace(/^moz-extension:\/\/[^/]+/, '')}:${c.line} ${c.msg.replace(/\s+/g, ' ').slice(0, 110)}`; seen.set(k, (seen.get(k) || 0) + 1); }
  console.log('CONSOLE (' + (results.console || []).length + '):'); for (const [k, n] of seen) console.log(`  x${n} ${k}`);
})();
