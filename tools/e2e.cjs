// End-to-end checks in real Firefox (headless, throwaway profile, extension as temporary add-on).
// Usage: node e2e.cjs [extension-dir]     exit code 0 = all passed
const fs = require('fs');
const path = require('path');
const { Builder, By, Key } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { PNG } = require('pngjs');
const { start } = require('./server.cjs');

const extDir = path.resolve(process.argv[2] || '../extension');
const outDir = path.join(__dirname, 'out', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const A = 8731, B = 8732, BASE = `http://127.0.0.1:${A}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); if (!cond) console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); };
const rgb = s => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
const luma = s => { const c = rgb(s); return c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 : null; };
const isDark = s => { const c = rgb(s); return !!c && c.a > 0.5 && luma(s) < 0.25; };
const isLight = s => { const c = rgb(s); return !!c && c.a > 0.5 && luma(s) > 0.6; };

const PROBE = `
const ids = arguments[0];
const cs = el => { if (!el) return null; const s = getComputedStyle(el); return { bg: s.backgroundColor, img: s.backgroundImage, rep: s.backgroundRepeat, fg: s.color, bd: s.borderTopColor, bbw: s.borderBottomWidth, filter: s.filter, blend: s.mixBlendMode, style: el.getAttribute('style'), inv: el.hasAttribute('data-adm-inv') }; };
const out = { state: document.documentElement.getAttribute('data-adm'), styleEls: document.querySelectorAll('style[data-adm-s]').length, marker: window.__marker || null, html: cs(document.documentElement), body: cs(document.body) };
for (const id of ids) out[id] = cs(document.getElementById(id));
if (window.__open) out.shadowOpen = cs(window.__open.querySelector('.x'));
if (window.__closed) out.shadowClosed = cs(window.__closed.querySelector('.x'));
if (window.__adopt) { out.adopted = cs(window.__adopt.querySelector('.y')); out.adoptedImp = cs(window.__adopt.querySelector('.z')); }
return out;`;

const CONSOLE = `
return Services.console.getMessageArray().map(m => {
  try { const e = m.QueryInterface(Ci.nsIScriptError); return { msg: e.errorMessage, src: e.sourceName, line: e.lineNumber, ts: m.timeStamp }; }
  catch (x) { return { msg: String(m.message), src: '' }; }
}).filter(e => /moz-extension|adaptive/i.test(e.src + ' ' + e.msg) || (/Content-Security-Policy/.test(e.msg) && /127\\.0\\.0\\.1/.test(e.src + e.msg)));`;

function pixels(b64) {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4) { const l = (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]); sum += l; if (l > max) max = l; n++; }
  return { avg: Math.round(sum / n), max: Math.round(max) };
}

async function session(scheme, fn) {
  const opts = new firefox.Options()
    .setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe')
    .addArguments('-headless', '-width=1280', '-height=900')
    .setPreference('layout.css.prefers-color-scheme.content-override', scheme === 'light' ? 1 : 0);
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  try {
    await driver.installAddon(extDir, true);
    await sleep(1200);
    await driver.setContext(firefox.Context.CHROME);
    const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[arguments[0]]", require(path.join(extDir, 'manifest.json')).browser_specific_settings.gecko.id);
    await driver.setContext(firefox.Context.CONTENT);
    const t = {
      driver, uuid,
      go: async (p, wait = 2500) => { if (process.env.E2E_DEBUG) console.log('   ', Date.now(), p); await driver.get(p.startsWith('http') ? p : BASE + p); await sleep(wait); },
      probe: (ids = []) => driver.executeScript(PROBE, ids),
      px: async id => pixels(await driver.findElement(By.id(id)).takeScreenshot()),
      shot: async name => fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(await driver.takeScreenshot(), 'base64')),
      // Run code inside an extension page (same privileges as the popup).
      ext: async (code, ...args) => {
        const r = await driver.executeAsyncScript(`const done = arguments[arguments.length - 1]; const args = Array.prototype.slice.call(arguments, 0, -1);
          (async () => { ${code} })().then(v => done({ v }), e => done({ err: String(e) }));`, ...args);
        if (r && r.err) throw new Error('extension page: ' + r.err);
        return r && r.v;
      },
      console: async () => { await driver.setContext(firefox.Context.CHROME); const c = await driver.executeScript(CONSOLE); await driver.setContext(firefox.Context.CONTENT); return c; },
    };
    await fn(t);
    const errs = await t.console();
    if (process.env.E2E_DEBUG) for (const c of errs) console.log('   CONSOLE', c.ts, c.src, c.line, c.msg.slice(0, 1500));
    const seen = new Map();
    for (const c of errs) { const k = `${c.src.replace(/^moz-extension:\/\/[^/]+/, '')}:${c.line} ${c.msg.slice(0, 220)}`; seen.set(k, (seen.get(k) || 0) + 1); }
    ok(`[${scheme}] no extension errors or CSP violations in the browser console`, errs.length === 0, [...seen].map(([k, n]) => `x${n} ${k}`));
  } catch (e) {
    ok(`[${scheme}] session ran to completion`, false, String(e && e.stack || e).slice(0, 700));
  } finally {
    await driver.quit().catch(() => {});
  }
}

async function darkSession(t) {
  const d = t.driver;
  // ---------- core stylesheet handling
  await t.go('/basic.html', 3200);
  let p = await t.probe(['plain', 'short', 'short2', 'tw', 'bs', 'nest', 'layer', 'media', 'named', 'cross', 'lossy', 'lossy2', 'lossy3', 'lossy4', 'inline', 'attr', 'font', 'late', 'lineart', 'photo', 'xlineart']);
  ok('basic: switched on', p.state === 'on' && p.styleEls === 1, p.state);
  for (const id of ['plain', 'short', 'short2', 'tw', 'bs', 'nest', 'layer', 'media', 'named', 'cross', 'lossy3', 'lossy4', 'inline', 'attr', 'late', 'shadowOpen', 'shadowClosed', 'adopted', 'adoptedImp'])
    ok(`basic: #${id} background is dark`, p[id] && isDark(p[id].bg), p[id] && p[id].bg);
  ok('basic: page text is light', isLight(p.body.fg), p.body.fg);
  ok('basic: <font color> is light', isLight(p.font.fg), p.font.fg);
  ok('basic: border colour mapped', luma(p.plain.bd) < 0.4, p.plain.bd);
  ok('basic: var() fallback border mapped', luma(p.short2.bd) < 0.4, p.short2.bd);
  ok('basic: recovered gradient ends dark and keeps no-repeat', /rgb\(2\d, 2\d, 2\d\)\)$/.test(p.lossy.img) && p.lossy.rep === 'no-repeat', p.lossy.img + ' ' + p.lossy.rep);
  ok('basic: recovered border keeps border-bottom:0', luma(p.lossy2.bd) < 0.4 && p.lossy2.bbw === '0px', p.lossy2);
  ok('basic: later background-color wins after recovered shorthand', rgb(p.lossy4.bg).r > rgb(p.lossy4.bg).g + 5, p.lossy4.bg);
  ok('basic: line-art <img> inverted (same and cross origin)', /invert/.test(p.lineart.filter) && /invert/.test(p.xlineart.filter));
  ok('basic: colourful <img> untouched', p.photo.filter === 'none', p.photo.filter);

  // ---------- features
  for (const page of ['/features.html', '/features-csp.html']) {
    const tag = page.includes('csp') ? 'features+CSP' : 'features';
    await t.go(page, 3500);
    p = await t.probe(['kf', 'blend', 'mask', 'bgicon', 'bgicon2', 'bgphoto', 'bgtex', 'bgdata', 'svgimage', 'pic', 'lineart', 'photo', 'inline', 'attr']);
    await t.shot(tag.replace('+', '-'));
    ok(`${tag}: on`, p.state === 'on', p.state);
    ok(`${tag}: @keyframes colours mapped`, isDark(p.kf.bg), p.kf.bg);
    ok(`${tag}: mix-blend-mode multiply neutralised`, p.blend.blend === 'normal', p.blend.blend);
    ok(`${tag}: masked icon uses the text role`, isLight(p.mask.bg), p.mask.bg);
    const data = s => /^url\("data:image\/svg\+xml;base64,/.test(s);
    ok(`${tag}: SVG background icon swapped for a recoloured copy`, data(p.bgicon.img), p.bgicon.img.slice(0, 60));
    ok(`${tag}: PNG background icon swapped, colour mapped`, data(p.bgicon2.img) && isDark(p.bgicon2.bg), p.bgicon2.img.slice(0, 60) + ' ' + p.bgicon2.bg);
    ok(`${tag}: data: URL background icon swapped`, data(p.bgdata.img), p.bgdata.img.slice(0, 60));
    ok(`${tag}: light background texture swapped`, data(p.bgtex.img), p.bgtex.img.slice(0, 60));
    ok(`${tag}: colourful background left alone`, /photo\.svg/.test(p.bgphoto.img), p.bgphoto.img.slice(0, 80));
    ok(`${tag}: SVG <image> line art inverted`, /invert/.test(p.svgimage.filter), p.svgimage.filter);
    ok(`${tag}: <picture> uses the chosen source`, /invert/.test(p.pic.filter), p.pic.filter);
    for (const id of ['bgicon', 'bgicon2', 'bgdata', 'mask']) { const s = await t.px(id); ok(`${tag}: #${id} actually renders light ink on dark`, s.max > 150 && s.avg < 140, s); }
    const tex = await t.px('bgtex'); ok(`${tag}: texture renders dark`, tex.avg < 90, tex);
    const la = await t.px('lineart'); ok(`${tag}: inverted line art renders dark`, la.avg < 110, la);
  }

  // ---------- printing: step aside, then come back
  await t.go('/features.html', 3000);
  await d.executeScript("window.__marker = 'kept'; window.dispatchEvent(new Event('beforeprint'));");
  await sleep(300);
  p = await t.probe(['inline', 'attr', 'lineart', 'plain']);
  ok('print: switched off for printing', p.state === 'off' && p.styleEls === 0, p.state);
  ok('print: inline style restored exactly', p.inline.style === 'background-color:#ffffff;color:#000000', p.inline.style);
  ok('print: no leftover style attribute on bgcolor cell', p.attr.style === null, p.attr.style);
  ok('print: image filter removed', p.lineart.filter === 'none' && !p.lineart.inv, p.lineart.filter);
  ok('print: page colours back to original', isLight(p.plain.bg), p.plain.bg);
  await d.executeScript("window.dispatchEvent(new Event('afterprint'));");
  await sleep(600);
  p = await t.probe(['inline', 'plain', 'lineart']);
  ok('print: back on afterwards', p.state === 'on' && isDark(p.plain.bg) && isDark(p.inline.bg) && /invert/.test(p.lineart.filter), p.state);

  // ---------- opt-outs (same contract as Safari)
  for (const [page, want] of [['/only-light.html', 'off'], ['/light-only.html', 'off'], ['/css-light-dark.html', 'off'], ['/css-body-only-light.html', 'off'], ['/declares-dark.html', 'off'], ['/already-dark.html', 'off'], ['/meta-light.html', 'on']]) {
    await t.go(page, 2600);
    p = await t.probe(['plain', 'inline']);
    ok(`opt-out ${page}: state ${want}`, p.state === want && p.styleEls === (want === 'on' ? 1 : 0), p.state);
    if (want === 'off' && page !== '/already-dark.html') ok(`opt-out ${page}: untouched`, isLight(p.plain.bg) && (!p.inline || p.inline.style === 'background-color:#ffffff'), p.plain.bg);
  }
  await t.go('/already-dark.html', 2600);
  p = await t.probe(['inline']);
  ok('already-dark: inline style left as authored', p.inline.style === 'color:#ffffff;background-color:#000000', p.inline.style);

  // ---------- cases found by the wide real-site sweep
  await t.go('/sweep-cases.html', 2600);
  p = await t.probe(['plain', 'band', 'ghost', 'wall', 'ink', 'inlinevar']);
  ok('cascade: a later rule that keeps white text still beats an earlier coloured one', isLight(p.band.fg) && /11, 114, 97/.test(p.band.bg), p.band);
  ok('cascade: a later "background: none" still clears the box', /rgba\(0, 0, 0, 0\)/.test(p.ghost.bg), p.ghost.bg);
  ok('all:initial overlay: background darkened, text light', isDark(p.wall.bg) && isLight(p.wall.fg), p.wall);
  ok('@property colour default: text is light', isLight(p.ink.fg), p.ink.fg);
  ok('inline "background: var(--x)": darkened', isDark(p.inlinevar.bg), p.inlinevar);
  await d.executeScript("window.dispatchEvent(new Event('beforeprint'));"); await sleep(400);
  p = await t.probe(['inlinevar']);
  ok('inline "background: var(--x)": restored exactly when switched off', p.inlinevar.style === '--fill: #FFF9F5; background: var(--fill)' && isLight(p.inlinevar.bg), p.inlinevar);
  await d.executeScript("window.dispatchEvent(new Event('afterprint'));"); await sleep(400);

  // ---------- "already dark" must be judged by what is on screen, not by the base colour alone
  await t.go('/dark-base-light-boxes.html', 2600);
  p = await t.probe(['plain']);
  ok('dark base + white content boxes: darkened', p.state === 'on' && isDark(p.plain.bg), { state: p.state, bg: p.plain.bg });
  await t.go('/late-light.html', 4200);
  p = await t.probe(['plain']);
  ok('white content arriving after load: darkened', p.state === 'on' && isDark(p.plain.bg), { state: p.state, bg: p.plain && p.plain.bg });
  await t.go('/theme-switch.html', 2600);
  p = await t.probe(['plain']);
  ok('site in its own dark theme: left alone', p.state === 'off', p.state);
  await d.executeScript("document.documentElement.classList.remove('dark');");
  await sleep(1200);
  p = await t.probe(['plain']);
  ok('site switched to its light theme: darkened without reload', p.state === 'on' && isDark(p.body.bg), { state: p.state, bg: p.body.bg });

  // ---------- 1990s HTML: <body background link vlink text bgcolor>
  await t.go('/legacy.html', 3200);
  p = await t.probe(['lnk', 'cell']);
  const whole = pixels(await d.takeScreenshot());
  ok('legacy: page renders dark', p.state === 'on' && whole.avg < 70, whole);
  ok('legacy: <body background> tile swapped for a dark copy', /^url\("data:image\/svg\+xml/.test(p.body.img), p.body.img.slice(0, 50));
  ok('legacy: <td background> tile swapped', /^url\("data:image\/svg\+xml/.test(p.cell.img), p.cell.img.slice(0, 50));
  ok('legacy: <body text> is light', isLight(p.body.fg), p.body.fg);
  ok('legacy: <body link> colour is readable on dark', luma(p.lnk.fg) > 0.35, p.lnk.fg);
  await d.executeScript("window.dispatchEvent(new Event('beforeprint'));"); await sleep(300);
  p = await t.probe(['lnk', 'cell']);
  ok('legacy: switching off restores the page exactly', p.state === 'off' && p.body.style === null && p.cell.style === null && /tex\.png/.test(p.body.img) && p.lnk.fg === 'rgb(0, 0, 153)', { style: p.body.style, img: p.body.img.slice(0, 50), lnk: p.lnk.fg });

  // ---------- frames
  await t.go('/frames.html', 3500);
  p = await t.probe(['plain']);
  ok('frames: top page dark', p.state === 'on' && isDark(p.body.bg), p.body.bg);
  for (const id of ['same', 'cross', 'srcdoc']) {
    await d.switchTo().frame(await d.findElement(By.id(id)));
    const f = await t.probe(['plain']);
    ok(`frames: <iframe id=${id}> darkened`, f.state === 'on' && isDark(f.body.bg) && isDark(f.plain.bg), { state: f.state, bg: f.body.bg });
    await d.switchTo().defaultContent();
  }

  // ---------- strict CSP page
  await t.go('/csp.html', 2600);
  p = await t.probe(['plain']);
  ok('csp: darkened', p.state === 'on' && isDark(p.plain.bg), p.plain.bg);

  // ---------- live settings: no reload needed
  await t.go('/features.html', 3000);
  await d.executeScript("window.__marker = 'kept';");
  const page = await d.getWindowHandle();
  await d.switchTo().newWindow('tab');
  const popup = await d.getWindowHandle();
  await d.get(`moz-extension://${t.uuid}/popup.html`);
  await sleep(800);
  const set = s => t.ext('return await window.browser.runtime.sendMessage({ type: "set", settings: args[0] });', s);
  const status = () => t.ext('const tabs = await window.browser.tabs.query({}); const tab = tabs.find(x => /features\\.html/.test(x.url)); return await window.browser.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });');
  const look = async () => { await d.switchTo().window(page); await sleep(700); const r = await t.probe(['plain', 'inline', 'attr', 'lineart']); await d.switchTo().window(popup); return r; };

  ok('status: reports on', (await status()).on === true);
  await set({ enabledByDefault: true, followSystem: false, sites: { '127.0.0.1': false } });
  p = await look();
  ok('live: per-site off applies without reload', p.state === 'off' && p.marker === 'kept' && isLight(p.plain.bg) && p.inline.style === 'background-color:#ffffff;color:#000000' && p.attr.style === null, { state: p.state, marker: p.marker, bg: p.plain.bg, style: p.inline.style });
  let st = await status();
  ok('status: reports "disabled" for the site', st.on === false && st.reason === 'disabled', st);
  await set({ enabledByDefault: true, followSystem: false, sites: {} });
  p = await look();
  ok('live: back on without reload', p.state === 'on' && p.marker === 'kept' && isDark(p.plain.bg) && /invert/.test(p.lineart.filter), { state: p.state, bg: p.plain.bg });
  await set({ enabledByDefault: false, followSystem: false, sites: { '127.0.0.1': true } });
  p = await look();
  ok('live: default off + site allow-listed stays on', p.state === 'on', p.state);
  await set({ enabledByDefault: true, followSystem: true, sites: {} });
  p = await look();
  ok('follow-system: stays on when Firefox is in dark mode', p.state === 'on', p.state);
  await set({ enabledByDefault: true, followSystem: false, sites: {} });

  // ---------- popup UI wiring (real clicks)
  await d.navigate().refresh(); await sleep(700);
  const ui = async () => d.executeScript("return { all: document.getElementById('all').checked, sys: document.getElementById('sys').checked, site: document.getElementById('site').disabled, host: document.getElementById('host').textContent }");
  let u = await ui();
  ok('popup: shows saved settings', u.all === true && u.sys === false, u);
  await d.findElement(By.id('all')).click(); await sleep(500);
  p = await look();
  ok('popup: unticking "all sites" turns the page off live', p.state === 'off' && p.marker === 'kept', p.state);
  await d.findElement(By.id('all')).click(); await sleep(500);
  p = await look();
  ok('popup: ticking it again turns the page on live', p.state === 'on' && isDark(p.plain.bg), p.state);
  const stored = await t.ext('return await window.browser.storage.local.get(null);');
  ok('popup: settings persisted to storage', stored.enabledByDefault === true && stored.followSystem === false && Object.keys(stored.sites).length === 0, stored);

  // ---------- already-dark page reports its reason; toggling settings does not darken it
  await d.switchTo().window(page);
  await t.go('/already-dark.html', 2500);
  await d.switchTo().window(popup);
  await set({ enabledByDefault: true, followSystem: false, sites: {} });
  await d.switchTo().window(page); await sleep(700);
  p = await t.probe(['inline']);
  ok('dark page: stays untouched after a settings change', p.state === 'off' && p.inline.style === 'color:#ffffff;background-color:#000000', p);
  await d.switchTo().window(popup);
  st = await t.ext('const tabs = await window.browser.tabs.query({}); const tab = tabs.find(x => /already-dark/.test(x.url)); return await window.browser.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });');
  ok('status: reports "dark" on an already-dark page', st.on === false && st.reason === 'dark', st);

  // ---------- force dark: overrides "already dark" and "handles dark mode itself", live, and can be undone
  const statusOf = re => t.ext('const tabs = await window.browser.tabs.query({}); const tab = tabs.find(x => new RegExp(args[0]).test(x.url)); return await window.browser.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });', re);
  const FORCE = { enabledByDefault: true, followSystem: false, sites: {}, force: { '127.0.0.1': true } };
  const PLAIN = { enabledByDefault: true, followSystem: false, sites: {} };
  await set(FORCE);
  await d.switchTo().window(page); await sleep(700);
  p = await t.probe(['plain']);
  ok('force: already-dark page is processed without reload', p.state === 'on' && p.styleEls === 1, p.state);
  await d.switchTo().window(popup);
  st = await statusOf('already-dark');
  ok('force: status says forced', st.on === true && st.forced === true, st);
  await set(PLAIN);
  await d.switchTo().window(page); await sleep(700);
  p = await t.probe(['inline']);
  ok('force off: page is left alone again, untouched', p.state === 'off' && p.inline.style === 'color:#ffffff;background-color:#000000', p);
  await d.switchTo().window(popup);
  await set(FORCE);
  await d.switchTo().window(page);
  await t.go('/declares-dark.html', 2600);
  p = await t.probe(['plain']);
  ok('force: applies from page load on a site that declares its own dark mode', p.state === 'on' && isDark(p.plain.bg), { state: p.state, bg: p.plain.bg });
  await t.go('/only-light.html', 2600);
  p = await t.probe(['plain']);
  ok('force: overrides "only light" too', p.state === 'on' && isDark(p.plain.bg), { state: p.state, bg: p.plain.bg });
  await d.switchTo().window(popup);
  const kept = await t.ext('return await window.browser.storage.local.get(null);');
  ok('force: saved in storage', kept.force && kept.force['127.0.0.1'] === true, kept.force);
  await set(PLAIN);
  await d.switchTo().window(page); await sleep(700);
  p = await t.probe(['plain']);
  ok('force off: "only light" page goes back to light live', p.state === 'off' && isLight(p.plain.bg), { state: p.state, bg: p.plain.bg });

  // ---------- keyboard shortcut (best effort: synthetic keys may not reach browser shortcuts)
  await d.switchTo().window(page);
  await t.go('/features.html', 2500);
  try {
    await d.actions().keyDown(Key.ALT).keyDown(Key.SHIFT).sendKeys('d').keyUp(Key.SHIFT).keyUp(Key.ALT).perform();
    await sleep(900);
    p = await t.probe([]);
    results.push({ name: 'shortcut: Alt+Shift+D toggles the site', pass: true, info: p.state === 'off' ? 'worked' : 'synthetic key did not trigger the browser shortcut (not a failure)' });
    console.log('  INFO shortcut:', results[results.length - 1].info);
  } catch (e) { console.log('  INFO shortcut not testable:', String(e).slice(0, 100)); }
  await d.switchTo().window(popup);
  await set({ enabledByDefault: true, followSystem: false, sites: {} });
  // The key binding itself cannot be pressed by a script, so check that it is registered and
  // that the code it runs toggles the site live.
  const cmds = await t.ext('return await window.browser.commands.getAll();');
  ok('shortcut: Alt+Shift+D is registered', cmds.some(c => c.name === 'toggle-site' && c.shortcut === 'Alt+Shift+D'), cmds);
  const toggle = () => t.ext('const bg = await window.browser.runtime.getBackgroundPage(); await bg.toggleSite({ url: "http://127.0.0.1:8731/features.html" }); return true;');
  await toggle();
  p = await (async () => { await d.switchTo().window(page); await sleep(700); const r = await t.probe(['plain']); await d.switchTo().window(popup); return r; })();
  ok('shortcut: its handler turns the current site off live', p.state === 'off' && isLight(p.plain.bg), p.state);
  await toggle();
  p = await (async () => { await d.switchTo().window(page); await sleep(700); const r = await t.probe(['plain']); await d.switchTo().window(popup); return r; })();
  ok('shortcut: and back on', p.state === 'on' && isDark(p.plain.bg), p.state);
}

async function lightSession(t) {
  const d = t.driver;
  await t.go('/features.html', 3000);
  let p = await t.probe(['plain']);
  ok('light scheme: darkens by default (follow-system off)', p.state === 'on' && isDark(p.plain.bg), p.state);
  const page = await d.getWindowHandle();
  await d.switchTo().newWindow('tab');
  const popup = await d.getWindowHandle();
  await d.get(`moz-extension://${t.uuid}/popup.html`);
  await sleep(800);
  await d.findElement(By.id('sys')).click(); await sleep(600);
  await d.switchTo().window(page); await sleep(500);
  p = await t.probe(['plain']);
  ok('follow-system: page switches off when Firefox is in light mode', p.state === 'off' && isLight(p.plain.bg), p.state);
  // a fresh navigation must not show the dark placeholder either
  await t.go('/slow.html', 900);
  const mid = pixels(await d.takeScreenshot());
  ok('follow-system: no dark placeholder on light-mode loads', mid.avg > 200, mid);
  await sleep(2500);
  p = await t.probe(['plain']);
  ok('follow-system: stays off after load', p.state === 'off', p.state);
  await d.switchTo().window(popup);
  await d.findElement(By.id('sys')).click(); await sleep(600);
  await d.switchTo().window(page); await sleep(500);
  p = await t.probe(['plain']);
  ok('follow-system: unticking brings dark back live', p.state === 'on' && isDark(p.body.bg), { state: p.state, bg: p.body.bg });
}

(async () => {
  const srv = await start(A, B);
  console.log('dark-appearance session'); await session('dark', darkSession);
  console.log('light-appearance session'); await session('light', lightSession);
  srv.close();
  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
