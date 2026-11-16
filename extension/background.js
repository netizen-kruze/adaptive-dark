'use strict';
/*
 * Adaptive Dark - background page.
 *  - settings + per-site enable state, pushed live to every tab when they change
 *  - registers the "no white flash" placeholder CSS at document_start
 *  - classifies images (invert line art / dark glyphs, keep photos)
 *  - builds recoloured copies of CSS background icons and light textures
 *  - fetches stylesheet text for the content script
 *  - CSP fallback: injects the override CSS via tabs.insertCSS
 *  - keyboard shortcut (toggle the current site)
 */

const DEFAULTS = { enabledByDefault: true, followSystem: false, sites: {}, force: {} };
let settings = { enabledByDefault: true, followSystem: false, sites: {}, force: {} };

// Shown until the content script takes over (it sets data-adm on <html>).
const PRE_RULE = 'html:not([data-adm]),html:not([data-adm]) body{background-color:#1c1b22 !important}';

const hostOf = u => {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname : ''; } catch (e) { return ''; }
};
const enabledFor = host =>
  (host && Object.prototype.hasOwnProperty.call(settings.sites, host) ? settings.sites[host] : settings.enabledByDefault);

// ------------------------------------------------------------------ placeholder CSS
let registration = null;
let chain = Promise.resolve();

async function doRefresh() {
  if (registration) { try { await registration.unregister(); } catch (e) {} registration = null; }
  const pat = h => `*://${h}/*`;
  const on = Object.keys(settings.sites).filter(h => settings.sites[h] === true).map(pat);
  const off = Object.keys(settings.sites).filter(h => settings.sites[h] === false).map(pat);
  // With "only when Firefox is dark" the placeholder must not darken pages for light-theme users.
  const code = settings.followSystem ? `@media (prefers-color-scheme: dark){${PRE_RULE}}` : PRE_RULE;
  // The same registration hands the content script its answer synchronously, so it can start
  // before the first paint instead of waiting for a message round trip (a cached page can
  // paint within that gap). Whichever of the two scripts runs first, the other picks it up.
  // forceHosts: sites the user wants darkened even if they look dark or say they handle it themselves.
  const cfg = JSON.stringify({ enabled: true, followSystem: settings.followSystem, forceHosts: Object.keys(settings.force) });
  const boot = `if (typeof ADM !== 'undefined' && ADM.boot) ADM.boot(${cfg}); else var ADM_PRE = ${cfg};`;
  const opts = { css: [{ code }], js: [{ code: boot }], runAt: 'document_start', allFrames: true };
  if (settings.enabledByDefault) {
    opts.matches = ['<all_urls>'];
    if (off.length) opts.excludeMatches = off;
  } else {
    if (!on.length) return;
    opts.matches = on;
  }
  try {
    registration = await browser.contentScripts.register(opts);
  } catch (e) {
    console.warn('[AdaptiveDark] placeholder CSS registration failed', e);
  }
}
const refresh = () => (chain = chain.then(doRefresh, doRefresh));

const clean = s => ({
  enabledByDefault: s.enabledByDefault !== false,
  followSystem: s.followSystem === true,
  sites: s.sites && typeof s.sites === 'object' ? s.sites : {},
  force: Object.fromEntries(Object.entries(s.force && typeof s.force === 'object' ? s.force : {}).filter(e => e[1] === true)),
});
const ready = browser.storage.local.get(DEFAULTS).then(s => { settings = clean(s); return refresh(); });

async function saveSettings(next) {
  settings = clean(next);
  await browser.storage.local.set(settings);
  await refresh();
  // Tell every open page so it switches on or off without a reload.
  const tabs = await browser.tabs.query({});
  for (const t of tabs) browser.tabs.sendMessage(t.id, { type: 'settings-changed' }).catch(() => {});
}

async function toggleSite(tab) {
  await ready;
  const host = tab && hostOf(tab.url || '');
  if (!host) return;
  const sites = Object.assign({}, settings.sites);
  const next = !enabledFor(host);
  if (next === settings.enabledByDefault) delete sites[host]; else sites[host] = next;
  await saveSettings(Object.assign({}, settings, { sites }));
}
if (browser.commands) {
  browser.commands.onCommand.addListener(async cmd => {
    if (cmd !== 'toggle-site') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    toggleSite(tab);
  });
}

// ------------------------------------------------------------------ image analysis
const imgCache = new Map(), bgCache = new Map();
let running = 0;
const waiting = [];
const slot = () => new Promise(res => { if (running < 4) { running++; res(); } else waiting.push(res); });
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

const S = 48;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = S;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const decide = ADM.decideImage;   // pure pixel-statistics decision, lives in color.js so Node can test it

// Download at most maxBytes; bigger files (photos) are abandoned instead of fetched twice.
async function fetchLimited(url, maxBytes) {
  const ctl = new AbortController();
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal: ctl.signal });
  if (!res.ok) return null;
  if ((+res.headers.get('content-length') || 0) > maxBytes) { ctl.abort(); return null; }
  const reader = res.body.getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { ctl.abort(); return null; }
    chunks.push(value);
  }
  return new Blob(chunks, { type: (res.headers.get('content-type') || '').split(';')[0].trim() });
}

async function load(url, maxBytes) {
  const blob = await fetchLimited(url, maxBytes);
  if (!blob) return null;
  const obj = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = obj; });
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, 0, 0, S, S);
    return { blob, w: img.naturalWidth, h: img.naturalHeight, data: ctx.getImageData(0, 0, S, S).data };
  } finally {
    URL.revokeObjectURL(obj);
  }
}

async function analyze(url) {
  const r = await load(url, 3e6);
  return !!r && decide(r.data, 'img');
}

const FILTER = 'filter:invert(1) hue-rotate(180deg)';
const toDataUrl = blob => new Promise(res => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result)); fr.onerror = () => res('');
  fr.readAsDataURL(blob);
});
const b64 = s => btoa(unescape(encodeURIComponent(s)));

// A recoloured copy of a background image as a data: URL, or '' to leave the image alone.
async function recolour(url) {
  const r = await load(url, 60000);
  if (!r || !decide(r.data, 'bg')) return '';
  if (/svg/i.test(r.blob.type)) {
    // Vector: wrap the drawing in a filtered group, keeping the root's own sizing attributes.
    const doc = new DOMParser().parseFromString(await r.blob.text(), 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) return '';
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('style', FILTER);
    while (root.firstChild) g.appendChild(root.firstChild);
    root.appendChild(g);
    return 'data:image/svg+xml;base64,' + b64(new XMLSerializer().serializeToString(root));
  }
  if (!r.w || !r.h) return '';
  const data = await toDataUrl(r.blob);
  if (!data) return '';
  // Bitmap: same intrinsic size (sprites keep working), filtered inside an SVG wrapper.
  return 'data:image/svg+xml;base64,' + b64(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r.w}" height="${r.h}" viewBox="0 0 ${r.w} ${r.h}">` +
    `<image width="${r.w}" height="${r.h}" preserveAspectRatio="none" href="${data}" style="${FILTER}"/></svg>`);
}

function cached(cache, url, work, fallback) {
  let p = cache.get(url);
  if (!p) {
    p = slot().then(() => work(url)).catch(() => fallback).finally(release);
    if (cache.size > 3000) cache.clear();
    cache.set(url, p);
  }
  return p;
}

// ------------------------------------------------------------------ CSP fallback
const injected = new Map(); // "tab:frame" -> css
async function applyCss(sender, code) {
  if (!sender.tab) return;
  const tabId = sender.tab.id, frameId = sender.frameId || 0, key = tabId + ':' + frameId;
  const prev = injected.get(key);
  if (code) await browser.tabs.insertCSS(tabId, { code, frameId, cssOrigin: 'author', runAt: 'document_start' });
  if (prev) await browser.tabs.removeCSS(tabId, { code: prev, frameId, cssOrigin: 'author' }).catch(() => {});
  if (code) injected.set(key, code); else injected.delete(key);
}
browser.tabs.onRemoved.addListener(tabId => {
  for (const k of injected.keys()) if (k.startsWith(tabId + ':')) injected.delete(k);
});

// ------------------------------------------------------------------ messages
browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case 'state':
      return ready.then(() => {
        const host = hostOf((sender.tab && sender.tab.url) || sender.url || '');
        return { enabled: enabledFor(host), followSystem: settings.followSystem, force: settings.force[host] === true };
      });
    case 'img':
      return cached(imgCache, msg.url, analyze, false);
    case 'bgimg':
      return cached(bgCache, msg.url, recolour, '');
    case 'fetch-css':
      return fetch(msg.url).then(r => (r.ok ? r.text() : '')).catch(() => '');
    case 'css':
      return applyCss(sender, msg.code).catch(() => {});
    case 'get':
      return ready.then(() => settings);
    case 'set':
      return ready.then(() => saveSettings(msg.settings || {})).then(() => settings);
  }
});

