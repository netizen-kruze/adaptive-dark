'use strict';
/*
 * Adaptive Dark - content script (runs at document_start in every frame).
 *
 * Strategy
 *  1. Stylesheets: walk the CSSOM of every sheet and emit an override rule with the
 *     same selector (inside the same @media/@supports/@layer wrappers) for each colour
 *     declaration. Hover/focus/class-toggle states keep working because nothing is
 *     frozen onto elements. @keyframes with colours are re-emitted with mapped colours.
 *  2. Custom properties: every colour variable gets per-role twins
 *     (--adm-bg--x, --adm-fg--x, ...), and usages are redirected to the right twin.
 *  3. Inline styles + legacy attributes (bgcolor, fill, ...): rewritten per element.
 *  4. Images: classified in the background page; line art gets inverted, photos stay.
 *     CSS background icons/textures are swapped for recoloured copies.
 *  5. Pages that are already dark, or declare their own colour-scheme handling
 *     (`light dark`, `dark`, `only light`), are left alone.
 *  6. Everything can be switched on and off live (popup, shortcut, system theme, printing).
 */
(() => {
  if (typeof ADM === 'undefined' || !document.documentElement) return;
  const A = ADM;
  const ATTR = 'data-adm';
  const send = msg => browser.runtime.sendMessage(msg);
  const setState = s => { const h = document.documentElement; if (h && h.getAttribute(ATTR) !== s) h.setAttribute(ATTR, s); };

  let reason = '';                      // why we are off: disabled | system | print | declares | dark | unsupported
  if (!/html/i.test(document.contentType || 'text/html')) { reason = 'unsupported'; setState('off'); return; }
  // A brand-new tab starts as an empty about:blank page that Firefox replaces a few milliseconds
  // later. There is nothing on it to darken, and work started there is killed halfway (Firefox
  // logs that as "Script terminated by timeout"). Blank pages a site opened itself (window.open)
  // and blank frames are real pages and are handled as usual.
  try {
    if (window.top === window && location.href === 'about:blank' && !window.opener) { reason = 'unsupported'; return; }
  } catch (e) {}

  // ---- canvas-backed parser for colours the fast parser cannot handle
  let cx = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    cx = cv.getContext('2d', { willReadFrequently: true });
  } catch (e) {}
  A.setResolver(s => {
    if (!cx) return null;
    try {
      cx.fillStyle = '#000'; cx.fillStyle = s; const a = cx.fillStyle;
      cx.fillStyle = '#fff'; cx.fillStyle = s;
      if (cx.fillStyle !== a || typeof a !== 'string') return null;   // invalid colours leave fillStyle untouched
      const p = A.parseFast(a);
      if (p) return p;
      cx.clearRect(0, 0, 1, 1); cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return d[3] ? [d[0], d[1], d[2], +(d[3] / 255).toFixed(3)] : [0, 0, 0, 0];
    } catch (e) { return null; }
  });

  // ---- state
  let active = false;
  let cfg = null;                       // { enabled, followSystem, force } from the background page
  const scopes = new Map();             // document / shadow root -> Scope
  const sheetCache = new WeakMap();     // CSSStyleSheet -> extracted data
  const corsCache = new Map();          // url|media -> extracted data
  const customs = new Map();            // "name\nvalue" -> { name, info }
  const colorVars = new Set(), composite = new Set();
  let customsDirty = false, varsVer = 0;
  const inlineRecs = new WeakMap();     // element -> Map(prop -> { val, mapped, orig, prio })
  const imgCache = new Map();
  let rebuildTimer = 0, pollTimer = 0, observer = null;

  const BASE_CSS = ':root{color-scheme:dark !important}\n';
  const PERF_ATTR = false;              // test builds flip this to expose the work counters on <html>

  const isOurs = n => !!n && n.nodeType === 1 && n.hasAttribute(ATTR + '-s');

  function addCustom(name, value, info) {
    if (!(info.color || info.refs.length) || customs.size > 20000) return;
    const key = name + '\n' + value;
    if (!customs.has(key)) { customs.set(key, { name, info }); customsDirty = true; }
  }

  // ---- CSS background images: ask the background page for a recoloured copy
  const bgMap = new Map();              // absolute url -> '' (leave alone) | BLANK (asking) | replacement url
  let bgDirty = false;
  // While the answer is on its way the image is held back (a 1x1 transparent GIF), so a light
  // tile cannot flash behind the page. It appears, original or recoloured, a moment later.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function bgLookup(url) {
    const v = bgMap.get(url);
    if (v !== undefined) return v || null;
    if (bgMap.size > 1500 || url.length > 150000) { bgMap.set(url, ''); return null; }
    bgMap.set(url, BLANK);
    const apply = r => { bgMap.set(url, r || ''); bgDirty = true; if (active) scheduleRebuild(); };
    const timer = setTimeout(() => apply(''), 1200);          // never hold an image back for long
    send({ type: 'bgimg', url }).then(r => { clearTimeout(timer); apply(r); }, () => { clearTimeout(timer); apply(''); });
    return BLANK;
  }

  // ------------------------------------------------------------------ stylesheet extraction
  let lostFlag = false;
  const BLEND = /^(multiply|darken|color-burn)$/;

  function readStyle(st) {
    const items = [];
    let seen = null, masked = null;
    // An element with a mask is an icon: its "background" is really the ink colour.
    const roleFor = p => {
      if (p !== 'background-color' && p !== 'background') return undefined;
      if (masked === null) masked = /mask/.test(st.cssText);
      return masked ? 'fg' : undefined;
    };
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      if (p.startsWith('--')) {
        if (p.startsWith('--adm-')) continue;
        const v = st.getPropertyValue(p).trim();
        if (!v) continue;
        const info = A.analyzeCustom(v);
        addCustom(p, v, info);
        if (info.color || info.refs.length) items.push({ p, v, i: st.getPropertyPriority(p) === 'important', info });
        continue;
      }
      if (p === 'mix-blend-mode') {
        if (BLEND.test(st.getPropertyValue(p))) items.push({ p, v: 'normal', blend: true, i: st.getPropertyPriority(p) === 'important' });
        continue;
      }
      if (!A.PROPS[p]) continue;
      const v = st.getPropertyValue(p);
      if (v) { items.push({ p, v, i: st.getPropertyPriority(p) === 'important', role: roleFor(p) }); continue; }
      // Empty longhand: it came from a shorthand that contains var().
      const cands = A.LONG2SHORT[p];
      if (!cands) continue;
      let got = false;
      for (const sh of cands) {
        const sv = st.getPropertyValue(sh);
        if (!sv) continue;
        got = true;
        if (!seen) seen = new Set();
        if (!seen.has(sh)) { seen.add(sh); items.push({ p: sh, v: sv, i: st.getPropertyPriority(sh) === 'important', role: roleFor(sh) }); }
        break;
      }
      // Firefox also blanks the shorthand when a related property follows it in the rule
      // (background: var(--x); background-repeat: no-repeat). Flag the rule; the value is
      // recovered from the stylesheet's source text in recoverLost().
      if (!got) lostFlag = true;
    }
    return items;
  }

  // ---- recovery of shorthand values the CSSOM cannot return (see A.lossyDecls)
  const srcCache = new Map();           // stylesheet url -> Promise<source text>
  const normSel = s => s.toLowerCase().replace(/\s+/g, '').replace(/'/g, '"').replace(/::?(before|after|first-line|first-letter)/g, '::$1');
  function applySource(d, text) {
    const lost = d.entries.filter(e => e.lost);
    if (!lost.length || !text) return false;
    const found = A.lossyDecls(text);
    let k = 0, hit = false;
    for (const e of lost) {             // both lists are in document order: match forward by selector
      const want = normSel(e.sel);
      for (let j = k; j < found.length; j++) {
        if (normSel(found[j].sel) !== want) continue;
        e.items = e.items.concat(found[j].items); e.lost = false;
        k = j + 1; hit = true;
        break;
      }
    }
    if (hit) d.ver = -1;
    return hit;
  }
  function recoverLost(sheet, d) {
    const node = sheet.ownerNode;
    if (node && node.localName === 'style') { applySource(d, node.textContent); return; }
    if (!sheet.href) return;
    let p = srcCache.get(sheet.href);
    if (!p) { p = send({ type: 'fetch-css', url: sheet.href }).catch(() => ''); srcCache.set(sheet.href, p); }
    p.then(text => { if (applySource(d, text) && active) scheduleRebuild(); });
  }

  function extract(rules, open, depth, base, out) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i], type = r.type;
      try {
        if (type === 1) {                                    // style rule
          lostFlag = false;
          const items = readStyle(r.style);
          const lost = lostFlag;
          if (items.length || lost) out.push({ open, close: '}'.repeat(depth), sel: r.selectorText, items, base, lost });
          if (r.cssRules && r.cssRules.length) extract(r.cssRules, open + r.selectorText + '{', depth + 1, base, out);
        } else if (type === 3) {                             // @import
          const ss = r.styleSheet;
          if (ss) {
            const mt = r.media && r.media.mediaText;
            if (mt && mt !== 'all') extract(ss.cssRules, open + '@media ' + mt + '{', depth + 1, ss.href || base, out);
            else extract(ss.cssRules, open, depth, ss.href || base, out);
          }
        } else if (type === 4 || type === 12) {              // @media / @supports
          extract(r.cssRules, open + (type === 4 ? '@media ' : '@supports ') + (r.conditionText || (r.media && r.media.mediaText) || 'all') + '{', depth + 1, base, out);
        } else if (type === 7) {                             // @keyframes: re-emitted whole, with mapped colours
          lostFlag = false;
          const frames = [];
          for (const k of r.cssRules) frames.push({ key: k.keyText, text: k.style.cssText, items: readStyle(k.style) });
          if (!lostFlag && frames.some(f => f.items.length)) out.push({ kf: CSS.escape(r.name), frames, open, close: '}'.repeat(depth), base });
        } else if (type === 0 && r.cssRules) {               // @layer / @container / @scope / ...
          let pre;
          if (typeof r.conditionText === 'string') pre = '@container ' + r.conditionText;
          else if (typeof r.name === 'string') pre = '@layer ' + r.name;
          else { const t = r.cssText; pre = t.slice(0, t.indexOf('{')).trim(); }
          extract(r.cssRules, open + pre + '{', depth + 1, base, out);
        }
      } catch (e) { /* unreadable rule: skip */ }
    }
  }

  function buildData(rules, mediaText, base, sig) {
    const out = [];
    const wrap = mediaText && mediaText !== 'all';
    try { extract(rules, wrap ? '@media ' + mediaText + '{' : '', wrap ? 1 : 0, base, out); } catch (e) {}
    return { sig, entries: out, css: '', ver: -1, force: false };
  }

  function corsData(href, mediaText) {
    const key = href + '|' + mediaText;
    let d = corsCache.get(key);
    if (!d) {
      d = { sig: '', entries: [], css: '', ver: -1, force: false };
      corsCache.set(key, d);
      send({ type: 'fetch-css', url: href }).then(text => {
        if (!text) return;
        const ss = new CSSStyleSheet();
        ss.replaceSync(text);
        const nd = buildData(ss.cssRules, mediaText, href, '');
        d.entries = nd.entries; d.ver = -1;
        applySource(d, text);
        if (active) scheduleRebuild();
      }).catch(() => {});
    }
    return d;
  }

  function sheetData(sheet) {
    let mt = '';
    try { mt = sheet.media ? sheet.media.mediaText : ''; } catch (e) {}
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) {}
    if (!rules) return sheet.href ? corsData(sheet.href, mt) : null;   // cross-origin sheet
    const sig = rules.length + '|' + mt;
    let d = sheetCache.get(sheet);
    if (!d || d.sig !== sig) {
      d = buildData(rules, mt, sheet.href || null, sig);
      sheetCache.set(sheet, d);
      if (d.entries.some(e => e.lost)) recoverLost(sheet, d);
    }
    return d;
  }

  function genSheet(d, force) {
    if (d.ver === varsVer && d.force === force) return d.css;
    let css = '';
    for (const e of d.entries) {
      const env = { colorVars, composite, base: e.base, docBase: document.baseURI, bg: bgLookup };
      if (e.kf) {
        let any = false, inner = '';
        for (const f of e.frames) {
          const b = A.genBody(f.items, env, false);
          if (b) any = true;
          inner += f.key + '{' + f.text + b + '}';
        }
        if (any) css += e.open + '@keyframes ' + e.kf + '{' + inner + '}' + e.close + '\n';
        continue;
      }
      const body = A.genBody(e.items, env, force);
      if (body) css += e.open + e.sel + '{' + body + '}' + e.close + '\n';
    }
    d.css = css; d.ver = varsVer; d.force = force;
    return css;
  }

  // ------------------------------------------------------------------ scopes (document + shadow roots)
  class Scope {
    constructor(root) { this.root = root; this.isDoc = root === document; this.el = null; this.css = null; this.viaApi = false; }

    collect() {
      const list = [];
      let sheets = [], adopted = [];
      try { sheets = Array.from(this.root.styleSheets); } catch (e) {}
      try { adopted = Array.from(this.root.adoptedStyleSheets || []); } catch (e) {}
      for (const s of sheets) {
        if (s.disabled || isOurs(s.ownerNode)) continue;
        const d = sheetData(s);
        if (d) list.push([d, false]);
      }
      // Adopted sheets sort after ours in the cascade, so their overrides need !important.
      for (const s of adopted) {
        if (s.disabled) continue;
        const d = sheetData(s);
        if (d) list.push([d, true]);
      }
      return list;
    }

    render(list) {
      let css = this.isDoc ? BASE_CSS + linkCss() : '';
      for (const [d, force] of list) css += genSheet(d, force);
      const parent = this.isDoc ? document.documentElement : this.root;
      if (!this.viaApi && this.el && (this.el.parentNode !== parent || this.el.nextElementSibling)) this.css = null; // must stay last
      if (css === this.css) return;
      this.css = css;
      if (this.isDoc) stats.css = css.length;
      if (this.viaApi) { send({ type: 'css', code: css }).catch(() => {}); return; }
      if (!this.el) {
        if (!css) return;               // nothing to say yet: do not insert an empty <style>
        this.el = document.createElement('style'); this.el.setAttribute(ATTR + '-s', '');
      }
      // Fill the element BEFORE inserting it. Firefox lets a content script's own <style>
      // through the page's CSP only when the script supplied the text; an empty element
      // inserted first is checked against the page's policy and logs a CSP violation.
      this.el.textContent = css;
      if (this.el.parentNode !== parent || this.el.nextElementSibling) parent.appendChild(this.el);
      if (this.isDoc && css && !this.el.sheet) {
        // The page's CSP blocked our <style>: hand the CSS to the background page instead.
        this.viaApi = true;
        this.el.remove(); this.el = null;
        send({ type: 'css', code: css }).catch(() => {});
      }
    }

    destroy() {
      if (this.el) this.el.remove();
      if (this.viaApi) send({ type: 'css', code: '' }).catch(() => {});
    }
  }

  // Work counters, reported through the popup's status request (and used by the perf test).
  const stats = { rebuilds: 0, ms: 0, maxMs: 0, css: 0 };
  function rebuildAll() {
    if (!active) return;
    const t0 = performance.now();
    try { rebuildInner(); } finally {
      const dt = performance.now() - t0;
      stats.rebuilds++; stats.ms += dt; if (dt > stats.maxMs) stats.maxMs = dt;
      if (PERF_ATTR) document.documentElement.setAttribute('data-adm-perf', `${stats.rebuilds}/${Math.round(stats.ms)}/${Math.round(stats.maxMs)}/${stats.css}`);
    }
  }
  function rebuildInner() {
    const plans = [];
    for (const sc of scopes.values()) {
      if (!sc.isDoc && !sc.root.isConnected) { scopes.delete(sc.root); continue; }
      plans.push([sc, sc.collect()]);
    }
    let grew = false;
    if (customsDirty) {
      customsDirty = false;
      grew = A.growVars(customs.values(), colorVars, composite);
    }
    const bgNew = bgDirty;
    if (grew || bgDirty) { bgDirty = false; varsVer++; }
    for (const [sc, list] of plans) sc.render(list);
    // Inline styles that use a variable we have only now learned is a colour, or an image
    // whose recoloured copy has just arrived.
    const again = [grew && '[style*="var("],[style*="--"]', bgNew && '[background],[style*="url("]'].filter(Boolean).join(',');
    if (again) {
      for (const sc of scopes.values()) {
        try { for (const el of sc.root.querySelectorAll(again)) processInline(el); } catch (e) {}
      }
    }
  }
  function rebuildNow() {
    clearTimeout(rebuildTimer); rebuildTimer = 0;
    rebuildAll();
  }
  function scheduleRebuild() {
    if (!rebuildTimer) rebuildTimer = setTimeout(() => { rebuildTimer = 0; rebuildAll(); }, 20);
  }

  // ------------------------------------------------------------------ inline styles + legacy attributes
  const INLINE_SEL = '[style],[bgcolor],[text],font[color],[fill],[stroke],[stop-color],[background]';
  const BG_ATTR_ON = /^(body|table|thead|tbody|tfoot|tr|td|th)$/;

  // <body link vlink alink>: legacy link colours. They are "presentational hints" with no
  // specificity, so the overrides use :where() to stay just as easy for the page to beat.
  function linkCss() {
    const b = document.body;
    if (!b) return '';
    let css = '';
    for (const [attr, sel] of [['link', ':link'], ['vlink', ':visited'], ['alink', ':link:active,:visited:active']]) {
      const v = b.getAttribute(attr);
      if (!v) continue;
      const e = { colorVars, found: false };
      const t = A.transform(fixLegacy(v), 'fg', e);
      if (e.found) css += `:where(${sel}){color:${t}}\n`;
    }
    return css;
  }
  const ATTR_MAP = { bgcolor: 'background-color', text: 'color', color: 'color', fill: 'fill', stroke: 'stroke', 'stop-color': 'stop-color' };
  const fixLegacy = v => (/^[0-9a-f]{6}$/i.test(v.trim()) ? '#' + v.trim() : v.trim());

  function processInline(el) {
    const st = el.style;
    if (!st || typeof st.getPropertyValue !== 'function') return;
    const rec = inlineRecs.get(el) || new Map();
    const src = new Map(); // prop -> [value, priority, fromAttribute]

    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      if (p.startsWith('--adm-')) continue;
      if (!p.startsWith('--') && !A.PROPS[p]) continue;
      const cur = st.getPropertyValue(p).trim();
      if (!cur) continue;
      const r = rec.get(p);
      if (r && cur === r.mapped) { if (r.orig !== null) src.set(p, [r.orig, r.prio, false]); }  // still our value
      else src.set(p, [cur, st.getPropertyPriority(p), false]);                                  // page's value
    }
    for (const a in ATTR_MAP) {
      const p = ATTR_MAP[a];
      if (src.has(p)) continue;
      if ((a === 'text' && el.localName !== 'body') || (a === 'color' && el.localName !== 'font')) continue;
      const v = el.getAttribute(a);
      if (v) src.set(p, [fixLegacy(v), '', true]);
    }
    // <body background="tile.gif"> and the same on tables/cells (1990s HTML, still around)
    if (!src.has('background-image') && BG_ATTR_ON.test(el.localName)) {
      const v = el.getAttribute('background');
      if (v) src.set('background-image', ['url("' + v.trim().replace(/["\\]/g, '\\$&') + '")', '', true]);
    }

    const want = new Map(); // prop -> [value, priority, original | null]
    for (const [p, [v, prio, fromAttr]] of src) {
      if (p.startsWith('--')) {
        const info = A.analyzeCustom(v);
        if (!colorVars.has(p) || (!info.pure && !composite.has(p))) {
          const before = customsDirty;
          addCustom(p, v, info);
          if (customsDirty && !before) scheduleRebuild();
        }
        if (info.color || info.refs.length) {
          for (const [k, t] of A.customDecls(p, v, info, { colorVars })) want.set(k, [t, prio, null]);
        }
        continue;
      }
      let role = A.PROPS[p];
      if (p === 'fill' && el.localName === 'rect') role = 'bg';   // chart/diagram backdrops
      const e = { colorVars, found: false, bg: bgLookup, docBase: document.baseURI };
      const t = A.transform(v, role, e);
      if (e.found && t !== v) want.set(p, [t, prio, fromAttr ? null : v]);
    }

    // Remember the attribute exactly as the page wrote it, so switching off leaves no trace.
    if (want.size && !rec.size && !inlineAttr.has(el)) inlineAttr.set(el, el.getAttribute('style'));
    for (const [p, [val, prio, orig]] of want) {
      const r = rec.get(p);
      if (r && r.val === val && st.getPropertyValue(p).trim() === r.mapped) { r.orig = orig; r.prio = prio; continue; }
      st.setProperty(p, val, prio);
      rec.set(p, { val, mapped: st.getPropertyValue(p).trim(), orig, prio });
    }
    for (const [p, r] of rec) {
      if (want.has(p)) continue;
      if (st.getPropertyValue(p).trim() === r.mapped) {
        if (r.orig !== null) st.setProperty(p, r.orig, r.prio); else st.removeProperty(p);
      }
      rec.delete(p);
    }
    if (rec.size) inlineRecs.set(el, rec); else { inlineRecs.delete(el); tidyAttr(el); }
  }

  // After our values are gone: if the style is what the page originally wrote (apart from
  // how the browser re-prints it), put the page's exact text back.
  const inlineAttr = new WeakMap();     // element -> style attribute before we first touched it (null = none)
  let scratch = null;
  function tidyAttr(el) {
    if (!inlineAttr.has(el)) return;
    const orig = inlineAttr.get(el);
    inlineAttr.delete(el);
    const now = el.getAttribute('style');
    if (now === orig) return;
    if (orig === null) { if (!now || !now.trim()) el.removeAttribute('style'); return; }
    if (!scratch) scratch = document.createElement('span');
    scratch.setAttribute('style', orig);
    if (scratch.style.cssText === el.style.cssText) el.setAttribute('style', orig);
  }

  function restoreInline(el) {
    const rec = inlineRecs.get(el);
    if (!rec || !el.style) return;
    for (const [p, r] of rec) {
      if (el.style.getPropertyValue(p).trim() !== r.mapped) continue;
      if (r.orig !== null) el.style.setProperty(p, r.orig, r.prio); else el.style.removeProperty(p);
    }
    inlineRecs.delete(el);
    tidyAttr(el);
  }

  // ------------------------------------------------------------------ images (<img> and SVG <image>)
  const INV = ATTR + '-inv';
  function setInv(img, inv) {
    const has = img.hasAttribute(INV);
    if (inv && !has) {
      if (img.style.filter) return;
      img.setAttribute(INV, '');
      img.style.setProperty('filter', 'invert(1) hue-rotate(180deg)');
    } else if (!inv && has) {
      img.removeAttribute(INV);
      img.style.removeProperty('filter');
      if (!(img.getAttribute('style') || '').trim()) img.removeAttribute('style');
    }
  }
  function imgUrl(img) {
    if (img.localName === 'img') return img.currentSrc || img.src || '';
    let u = (img.href && img.href.baseVal) || '';
    if (u) { try { u = new URL(u, document.baseURI).href; } catch (e) {} }
    return u;
  }
  function checkImg(img) {
    const url = imgUrl(img);
    if (!url) return;
    if (img.localName === 'img') {
      if (!img.naturalWidth) return;                         // not loaded yet: the load listener calls us again
      if (img.naturalWidth < 8 || img.naturalWidth * img.naturalHeight > 4e6) return setInv(img, false);
    }
    if (url.startsWith('blob:')) return setInv(img, false);
    let p = imgCache.get(url);
    if (!p) {
      p = send({ type: 'img', url }).catch(() => false);
      if (imgCache.size > 3000) imgCache.clear();
      imgCache.set(url, p);
    }
    p.then(inv => { if (active && imgUrl(img) === url) setInv(img, !!inv); });
  }
  const isImg = el => el.localName === 'img' || el.localName === 'image';

  // ------------------------------------------------------------------ DOM scanning
  function scan(node) {
    if (node.nodeType === 1) {
      if (isImg(node)) checkImg(node);
      if (node.matches(INLINE_SEL)) processInline(node);
    }
    if (!node.querySelectorAll) return;
    for (const el of node.querySelectorAll(INLINE_SEL + ',img,image')) {
      if (isImg(el)) checkImg(el);
      processInline(el);
    }
  }

  const shadowOf = el => el.openOrClosedShadowRoot || el.shadowRoot || null;   // Firefox exposes closed roots to extensions
  function findShadows(node) {
    if (node.nodeType === 1) { const sr = shadowOf(node); if (sr) attachScope(sr); }
    if (!node.firstElementChild) return;
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let el = tw.nextNode(); el; el = tw.nextNode()) { const sr = shadowOf(el); if (sr) attachScope(sr); }
  }

  function onLoad(ev) {
    const t = ev.target;
    if (!active || !t || t.nodeType !== 1) return;
    // A stylesheet just became active: override it now, not 20 ms later, or the page's
    // own light colours can be painted for a frame.
    if (t.localName === 'link') rebuildNow();
    else if (isImg(t)) checkImg(t);
  }

  const OBS = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['style', 'bgcolor', 'text', 'color', 'fill', 'stroke', 'stop-color', 'background', 'link', 'vlink', 'alink'],
  };

  function attachScope(root) {
    if (scopes.has(root)) return;
    scopes.set(root, new Scope(root));
    observer.observe(root, OBS);
    root.addEventListener('load', onLoad, true);
    if (root !== document) { scan(root); findShadows(root); }
    scheduleRebuild();
  }

  let metaChecked = false;
  function onMutations(records) {
    if (!active) return;
    let dirty = false;
    for (const m of records) {
      const t = m.target;
      if (m.type === 'attributes') {
        if (!isOurs(t)) processInline(t);
        if (m.attributeName.endsWith('link')) dirty = true;
      } else if (m.type === 'characterData') {
        const p = t.parentNode;
        if (p && p.localName === 'style' && !isOurs(p)) dirty = true;
      } else {
        if (t.localName === 'style' && !isOurs(t)) dirty = true;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || isOurs(n)) continue;
          if (n.localName === 'style' || n.localName === 'link') dirty = true;
          else if (n.firstElementChild && n.querySelector('style,link')) dirty = true;
          scan(n);
          findShadows(n);
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && (n.localName === 'style' || n.localName === 'link') && !isOurs(n)) dirty = true;
        }
      }
    }
    if (!metaChecked && document.body) {      // <head> is complete once <body> exists
      metaChecked = true;
      if (!(cfg && cfg.force) && declaresOwn()) return teardown('declares');
    }
    // While the page is still loading, new <style>/<link> elements are handled immediately
    // (same reason as in onLoad); afterwards changes are batched to keep CSS-in-JS pages cheap.
    if (dirty) { if (document.readyState === 'loading') rebuildNow(); else scheduleRebuild(); }
  }

  // ------------------------------------------------------------------ "does this page look after itself?"
  // Same contract as Safari: `light dark` / `dark` means the site has its own dark styling,
  // `only light` (either order) means "leave me light". Plain `light` is not an opt-out.
  const ownsScheme = s => { s = String(s || '').toLowerCase(); return /\bdark\b/.test(s) || (/\bonly\b/.test(s) && /\blight\b/.test(s)); };
  function declaresOwn() {
    const m = document.querySelector('meta[name="color-scheme" i]');
    return !!m && ownsScheme(m.getAttribute('content'));
  }

  // Returns '' (go ahead and darken) or the reason to leave the page alone.
  function leaveAlone() {
    if (cfg && cfg.force) return '';                              // the user said: darken this site regardless
    if (declaresOwn()) return 'declares';
    const h = document.documentElement, b = document.body;
    if (!b) return '';
    for (const sc of scopes.values()) if (sc.viaApi) return '';   // cannot switch our CSS off to look underneath
    const off = [], prev = h.getAttribute(ATTR);
    if (active) h.setAttribute(ATTR, 'probe');
    for (const sc of scopes.values()) if (sc.el && sc.el.sheet) { sc.el.sheet.disabled = true; off.push(sc.el); }
    try {
      if (ownsScheme(getComputedStyle(h).colorScheme) || ownsScheme(getComputedStyle(b).colorScheme)) return 'declares';
      const read = (el, prop, attr, key) => {
        const r = inlineRecs.get(el) && inlineRecs.get(el).get(prop);
        if (r) return r.orig !== null ? r.orig : fixLegacy(el.getAttribute(attr) || '');
        return getComputedStyle(el)[key];
      };
      const bgOf = el => A.parseColor(read(el, 'background-color', 'bgcolor', 'backgroundColor'));
      let verdict = '', decided = false;
      for (const el of [b, h]) {
        const c = bgOf(el);
        if (c && c[3] > 0.5) { verdict = A.lightness(c) < 0.45 ? 'dark' : ''; decided = true; break; }
      }
      if (!decided) {
        const fg = A.parseColor(read(b, 'color', 'text', 'color'));
        verdict = fg && fg[3] > 0.5 && A.lightness(fg) > 0.65 ? 'dark' : '';
      }
      // The page's base colour is only a hint: plenty of sites give <body> a dark colour (it shows
      // in the footer or the margins) and put all their content in white boxes. Before leaving a
      // page alone as "already dark", look at what is really painted on screen.
      if (verdict === 'dark' && lightShare(bgOf) >= 0.5) verdict = '';
      return verdict;
    } catch (e) {
      return '';
    } finally {
      if (active) h.setAttribute(ATTR, prev || 'on');
      for (const el of off) if (el.sheet) el.sheet.disabled = false;
    }
  }

  // Share of the visible window that sits on a light surface (0..1), or -1 if it cannot be told.
  // 36 sample points; for each, the nearest ancestor with a solid background (or gradient) decides.
  const OPAQUE_MEDIA = /^(img|picture|video|canvas|iframe|embed|object|svg)$/;
  function lightShare(bgOf) {
    const w = window.innerWidth, ht = window.innerHeight, N = 6;
    if (!(w > 60 && ht > 60)) return -1;
    let light = 0, dark = 0;
    const vote = c => { if (A.lightness(c) < 0.45) dark++; else light++; };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      let el = document.elementFromPoint(w * (i + 0.5) / N, ht * (j + 0.5) / N), hops = 0;
      for (; el && hops < 60; hops++, el = el.parentElement) {
        if (OPAQUE_MEDIA.test(el.localName)) break;                 // a picture says nothing about the design
        const c = bgOf(el);
        if (c && c[3] > 0.5) { vote(c); break; }
        const img = getComputedStyle(el).backgroundImage;
        if (img && img !== 'none') {
          const m = /rgba?\([^)]*\)/.exec(img), g = m && A.parseColor(m[0]);   // first colour of a gradient
          if (g && g[3] > 0.5) vote(g);
          break;
        }
      }
      // Nothing in the way: the page canvas shows. It takes <html>'s colour, else <body>'s (even
      // where <body> itself is shorter than the window), else the browser's white. In a frame
      // with no colour of its own the parent page shows through, which we cannot see from here.
      if (!el && hops) {
        const hc = bgOf(document.documentElement), bc = document.body && bgOf(document.body);
        const canvas = hc && hc[3] > 0.5 ? hc : bc && bc[3] > 0.5 ? bc : null;
        if (canvas) vote(canvas); else if (window.top === window) light++;
      }
    }
    return light + dark >= N * N * 0.3 ? light / (light + dark) : -1;
  }

  // Undo everything. Safe to call start() again afterwards.
  function teardown(why) {
    if (!active) return;
    active = false;
    reason = why;
    if (observer) observer.disconnect();
    clearInterval(pollTimer);
    clearTimeout(rebuildTimer); rebuildTimer = 0;
    for (const sc of scopes.values()) {
      sc.destroy();
      try {
        sc.root.removeEventListener('load', onLoad, true);
        for (const img of sc.root.querySelectorAll('[' + INV + ']')) setInv(img, false);
        for (const el of sc.root.querySelectorAll(INLINE_SEL)) restoreInline(el);
      } catch (e) {}
    }
    scopes.clear();
    setState('off');
    if (why === 'dark' || why === 'declares') watchForChange();
  }

  // A page that was left alone can still turn light: its content may arrive after the first look,
  // or the visitor may use the site's own theme switch. Look again a few times, and whenever the
  // page's theme attributes change. Cheap while we are off (nothing of ours to step around).
  let lookTimers = [], restarts = 0, themeObs = null, themeTimer = 0;
  const THEME_ATTRS = ['class', 'data-theme', 'data-bs-theme', 'data-color-mode', 'data-mode', 'content'];
  function lookAgain() {
    if (active || !wanted() || (reason !== 'dark' && reason !== 'declares')) return;
    if (restarts >= 4 || leaveAlone()) return;
    restarts++;
    start();
  }
  function watchForChange() {
    for (const t of lookTimers) clearTimeout(t);
    lookTimers = [600, 1500, 4000, 10000].map(ms => setTimeout(lookAgain, ms));
    if (themeObs) return;
    themeObs = new MutationObserver(() => { clearTimeout(themeTimer); themeTimer = setTimeout(lookAgain, 400); });
    const o = { attributes: true, attributeFilter: THEME_ATTRS };
    themeObs.observe(document.documentElement, o);
    if (document.body) themeObs.observe(document.body, o);
    const m = document.querySelector('meta[name="color-scheme" i]');
    if (m) themeObs.observe(m, o);
  }
  function unwatch() {
    for (const t of lookTimers) clearTimeout(t);
    lookTimers = [];
    clearTimeout(themeTimer);
    if (themeObs) { themeObs.disconnect(); themeObs = null; }
  }

  function checkpoint() {
    if (!active) return;
    const why = leaveAlone();
    if (why) return teardown(why);
    rebuildAll();
    findShadows(document.documentElement);
  }

  // ------------------------------------------------------------------ start / stop
  let loadHooks = false;
  function start() {
    if (active) return;
    active = true;
    reason = '';
    metaChecked = false;
    unwatch();
    setState('on');
    observer = new MutationObserver(onMutations);
    attachScope(document);
    scan(document.documentElement);
    findShadows(document.documentElement);
    rebuildAll();
    // CSS-in-JS libraries add rules through the CSSOM without touching the DOM, so poll cheaply.
    pollTimer = setInterval(() => { if (!document.hidden) rebuildAll(); }, 700);

    if (document.readyState === 'complete') { checkpoint(); return; }
    if (document.readyState === 'interactive') checkpoint();
    if (loadHooks) return;
    loadHooks = true;
    document.addEventListener('DOMContentLoaded', checkpoint, { once: true });
    window.addEventListener('load', () => { checkpoint(); setTimeout(checkpoint, 1500); }, { once: true });
  }

  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  let printing = false;
  const wanted = () => !!cfg && cfg.enabled && (!cfg.followSystem || darkMq.matches) && !printing;
  function evaluate() {
    const why = printing ? 'print' : cfg && cfg.enabled ? 'system' : 'disabled';
    if (wanted()) {
      // Already running: settings may have changed (force switched off), so look at the page again.
      if (!active) start(); else if (document.readyState !== 'loading') checkpoint();
    } else if (active) teardown(why);
    else { unwatch(); reason = why; setState('off'); }
  }
  const refresh = () => send({ type: 'state' }).then(st => { cfg = st || null; evaluate(); }, () => { cfg = null; evaluate(); });

  darkMq.addEventListener('change', () => { if (cfg && cfg.followSystem) evaluate(); });
  // Never print light-on-dark: step aside while the print layout is taken.
  window.addEventListener('beforeprint', () => { printing = true; evaluate(); });
  window.addEventListener('afterprint', () => { printing = false; evaluate(); });

  browser.runtime.onMessage.addListener(msg => {
    if (!msg) return;
    if (msg.type === 'settings-changed') { refresh(); return; }
    if (msg.type === 'status' && window.top === window) {
      return Promise.resolve({ on: active, reason, host: location.hostname, forced: active && !!(cfg && cfg.force) });
    }
  });

  // Fast path: the background page registers a one-line script for enabled sites that carries
  // the answer (see doRefresh in background.js). The message below stays authoritative.
  A.boot = c => {
    if (cfg || !c) return;
    cfg = { enabled: c.enabled, followSystem: c.followSystem, force: window.top === window && (c.forceHosts || []).includes(location.hostname) };
    evaluate();
  };
  if (typeof ADM_PRE !== 'undefined') A.boot(ADM_PRE);
  refresh();
})();
