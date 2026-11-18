'use strict';
/*
 * Adaptive Dark - colour engine (no DOM access, so it can be unit-tested in Node).
 *
 * - sRGB <-> OKLCH conversion
 * - role-based lightness mapping (bg / fg / bd / sh), hue preserved
 * - CSS value rewriting: literal colours are mapped, colour custom properties are
 *   redirected to per-role twins (--adm-bg--x, --adm-fg--x, ...)
 */
var ADM = (() => {
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // ---------------------------------------------------------------- OKLCH
  const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const toGam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  function rgbToOklch(r, g, b) {
    r = toLin(r); g = toLin(g); b = toLin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return [L, Math.hypot(A, B), Math.atan2(B, A)];
  }

  function oklchRaw(L, C, h) {
    const A = C * Math.cos(h), B = C * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
      toGam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      toGam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      toGam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  // Back to sRGB; if out of gamut, reduce chroma (keeps lightness and hue).
  function oklchToRgb(L, C, h) {
    L = clamp(L, 0, 1);
    const ok = c => {
      const v = oklchRaw(L, c, h);
      return v.every(x => x >= -0.001 && x <= 1.001) ? v : null;
    };
    let v = ok(C);
    if (!v) {
      let lo = 0, hi = C;
      for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
      v = oklchRaw(L, lo, h);
    }
    return v.map(x => Math.round(clamp(x, 0, 1) * 255));
  }

  const lightness = c => rgbToOklch(c[0], c[1], c[2])[0];

  // ---------------------------------------------------------------- mapping
  // Tunables. L is OKLCH lightness, 0 (black) .. 1 (white).
  const TUNE = {
    bgFloor: 0.2,   // what pure white backgrounds become (~#181818)
    fgCeil: 0.9,    // what pure black text becomes (~#dedede)
  };
  const ROLES = ['bg', 'fg', 'bd', 'sh'];

  function mapL(role, L) {
    switch (role) {
      case 'bg': return L > 0.5 ? TUNE.bgFloor + (1 - L) * 0.5 : L;      // light surfaces -> dark, dark stay
      case 'fg': return Math.max(L, TUNE.fgCeil - 0.35 * L);             // dark text -> light, light stays
      case 'bd': return L > 0.5 ? 0.3 + (1 - L) * 0.5 : 0.6 - 0.3 * L;   // borders: pull to mid/dark greys
      case 'sh': return L > 0.5 ? 0.3 + (1 - L) * 0.5 : L;               // shadows: only light "rings" change
    }
    return L;
  }

  const mapCache = new Map();
  function mapRgb(role, r, g, b) {
    const key = role + r + ',' + g + ',' + b;
    let v = mapCache.get(key);
    if (!v) {
      const [L, C, h] = rgbToOklch(r, g, b);
      const nL = mapL(role, L);
      v = Math.abs(nL - L) < 0.004 ? [r, g, b] : oklchToRgb(nL, C, h);
      if (mapCache.size > 20000) mapCache.clear();
      mapCache.set(key, v);
    }
    return v;
  }

  const hex2 = n => (n < 16 ? '0' : '') + n.toString(16);
  // Mapped CSS text for an [r,g,b,a] colour, or null when it should be left alone.
  function fmt(role, c) {
    if (c[3] === 0) return null;
    const m = mapRgb(role, c[0], c[1], c[2]);
    if (m[0] === c[0] && m[1] === c[1] && m[2] === c[2]) return null;
    return c[3] < 1
      ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${c[3]})`
      : '#' + hex2(m[0]) + hex2(m[1]) + hex2(m[2]);
  }

  // ---------------------------------------------------------------- colour parsing
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    const r1 = x => Math.round(x * 10) / 10;
    return [r1(h), r1(s * 100), r1(l * 100)];
  }

  const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(%|deg|turn|rad|grad)?$/;
  function parseFast(k) {
    let m = /^#([0-9a-f]{3,8})$/.exec(k);
    if (m) {
      const h = m[1], n = h.length;
      if (n === 3 || n === 4) {
        const v = [...h].map(c => parseInt(c + c, 16));
        return [v[0], v[1], v[2], n === 4 ? +(v[3] / 255).toFixed(3) : 1];
      }
      if (n === 6 || n === 8) {
        const v = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16));
        return [v[0], v[1], v[2], n === 8 ? +(v[3] / 255).toFixed(3) : 1];
      }
      return null;
    }
    m = /^(rgb|hsl)a?\(([^()]*)\)$/.exec(k);
    if (!m) return null;
    let body = m[2], alpha = '1';
    if (body.includes('/')) { const p = body.split('/'); if (p.length !== 2) return null; body = p[0]; alpha = p[1].trim(); }
    let parts = body.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 4 && alpha === '1') alpha = parts.pop();
    if (parts.length !== 3 || !parts.every(p => NUM.test(p)) || !NUM.test(alpha)) return null;
    let a = parseFloat(alpha); if (alpha.endsWith('%')) a /= 100;
    a = +clamp(a, 0, 1).toFixed(3);
    if (m[1] === 'rgb') {
      const v = parts.map(p => Math.round(clamp(p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p), 0, 255)));
      return [v[0], v[1], v[2], a];
    }
    let h = parseFloat(parts[0]);
    if (parts[0].endsWith('turn')) h *= 360;
    else if (parts[0].endsWith('grad')) h *= 0.9;
    else if (parts[0].endsWith('rad')) h *= 180 / Math.PI;
    const c = hslToRgb(h, parseFloat(parts[1]), parseFloat(parts[2]));
    return [c[0], c[1], c[2], a];
  }

  // The content script plugs in a canvas-based resolver for everything parseFast
  // does not understand (named colours, lab(), oklch(), color-mix(), ...).
  let resolver = null;
  const parseCache = new Map();
  function parseColor(str) {
    const k = String(str).trim().toLowerCase();
    let v = parseCache.get(k);
    if (v === undefined) {
      v = parseFast(k) || (resolver ? resolver(k) : null) || null;
      if (parseCache.size > 8000) parseCache.clear();
      parseCache.set(k, v);
    }
    return v;
  }

  // ---------------------------------------------------------------- value rewriting
  const COLOR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
  const SKIP_IDENTS = new Set([
    'currentcolor', 'transparent', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto', 'solid', 'inset',
    'canvas', 'canvastext', 'linktext', 'visitedtext', 'activetext', 'buttonface', 'buttontext', 'buttonborder',
    'field', 'fieldtext', 'highlight', 'highlighttext', 'selecteditem', 'selecteditemtext', 'mark', 'marktext',
    'graytext', 'accentcolor', 'accentcolortext',
  ]);

  function skipStr(s, i) {
    const q = s[i];
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === q) return j;
    }
    return s.length - 1;
  }
  function matchParen(s, i) {
    let d = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '"' || c === "'") { j = skipStr(s, j); continue; }
      if (c === '(') d++;
      else if (c === ')' && --d === 0) return j;
    }
    return s.length - 1;
  }
  function splitTop(s, isSep) {
    // Slices rather than building strings a character at a time: values can carry inline
    // images that are hundreds of kilobytes long.
    const out = []; let d = 0, st = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'") { i = skipStr(s, i); continue; }
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (!d && isSep(c)) { out.push(s.slice(st, i)); st = i + 1; }
    }
    out.push(s.slice(st));
    return out;
  }
  function splitAlpha(inner) {
    const sl = splitTop(inner, c => c === '/');
    if (sl.length === 2) return { color: sl[0].trim(), alpha: sl[1].trim() };
    const cm = splitTop(inner, c => c === ',');
    if (cm.length === 4) return { color: cm.slice(0, 3).join(','), alpha: cm[3].trim() };
    return null;
  }
  const quoteUrl = u => '"' + u.replace(/["\\]/g, '\\$&') + '"';
  /*
   * url(...) handling. Relative URLs are made absolute when the value came from a linked
   * stylesheet (env.base), because our override lives in the document, not in that sheet.
   * For backgrounds, env.bg(absoluteUrl) may return a replacement image (a recoloured copy
   * of a dark icon or light texture, built by the background page).
   */
  function urlFn(inner, role, env) {
    let u = inner.trim();
    if (u[0] === '"' || u[0] === "'") u = u.slice(1, -1);
    // undo CSS escapes (\" \' \27 ...): the browser prints url("...") with its quotes escaped
    if (u.includes('\\')) u = u.replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (m, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : ch));
    let abs = u;
    const b = env.base || env.docBase;
    if (u && b && !/^(#|[a-z][a-z0-9+.-]*:)/i.test(u)) { try { abs = new URL(u, b).href; } catch (e) {} }
    if (env.bg && role === 'bg' && /^(https?:|data:image\/)/i.test(abs)) {
      const r = env.bg(abs);
      if (r) { env.found = true; return 'url(' + quoteUrl(r) + ')'; }
    }
    return env.base ? 'url(' + quoteUrl(abs) + ')' : 'url(' + inner + ')';
  }

  /*
   * Rewrite one CSS value for a role.
   * env: { colorVars?: Set, base?: string, found: bool (out), refs?: string[] (out) }
   * env.found becomes true when the value contains a colour or a colour variable.
   */
  function transform(s, role, env) {
    let out = '', i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '"' || c === "'") { const j = skipStr(s, i); out += s.slice(i, j + 1); i = j + 1; continue; }
      if (c === '#') {
        let j = i + 1;
        while (j < n && /[0-9a-fA-F]/.test(s[j])) j++;
        const len = j - i - 1;
        if ((len === 3 || len === 4 || len === 6 || len === 8) && !(j < n && /[\w-]/.test(s[j]))) {
          out += mapToken(s.slice(i, j), role, env); i = j; continue;
        }
        out += c; i++; continue;
      }
      const nx = s[i + 1] || '';
      if (/[0-9]/.test(c) || ((c === '.' || c === '-' || c === '+') && /[0-9.]/.test(nx))) {
        let j = i + 1;
        while (j < n && /[\w.%]/.test(s[j])) j++;
        out += s.slice(i, j); i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c) || (c === '-' && /[a-zA-Z_-]/.test(nx))) {
        let j = i + 1;
        while (j < n && /[\w-]/.test(s[j])) j++;
        const word = s.slice(i, j), lw = word.toLowerCase();
        if (s[j] === '(') {
          const k = matchParen(s, j);
          out += func(lw, word, s.slice(j + 1, k), role, env);
          i = k + 1; continue;
        }
        if (/^[a-z]{3,20}$/.test(lw) && !SKIP_IDENTS.has(lw)) out += mapToken(word, role, env);
        else out += word;
        i = j; continue;
      }
      out += c; i++;
    }
    return out;
  }

  function mapToken(tok, role, env) {
    const c = parseColor(tok);
    if (!c) return tok;
    env.found = true;
    return fmt(role, c) || tok;
  }

  function func(lw, word, inner, role, env) {
    if (lw === 'url') return urlFn(inner, role, env);
    if (lw === 'var') {
      const m = /^\s*(--[^\s,)]+)\s*(?:,([\s\S]*))?$/.exec(inner);
      if (!m) return word + '(' + inner + ')';
      const name = m[1];
      const fb = m[2] !== undefined ? ',' + transform(m[2], role, env) : '';
      if (env.refs) env.refs.push(name);
      if (env.colorVars && env.colorVars.has(name)) {
        env.found = true;
        // Falls back to the page's own variable if the twin is not defined in this scope.
        return `var(--adm-${role}${name}, var(${name}${fb}))`;
      }
      return `var(${name}${fb})`;
    }
    if (COLOR_FNS.has(lw)) {
      const dynamic = inner.includes('var(') || /currentcolor/i.test(inner);
      if (!dynamic) {
        const c = parseColor(word + '(' + inner + ')');
        if (c) { env.found = true; return fmt(role, c) || word + '(' + inner + ')'; }
        return word + '(' + transform(inner, role, env) + ')';
      }
      env.found = true;
      if (/^(rgb|hsl)a?$/.test(lw)) {
        // Very common (Tailwind): literal colour with a variable alpha.
        const sp = splitAlpha(inner);
        if (sp && !sp.color.includes('var(')) {
          const c = parseColor(lw.replace(/a$/, '') + '(' + sp.color + ')');
          if (c) { const m = mapRgb(role, c[0], c[1], c[2]); return `rgb(${m[0]} ${m[1]} ${m[2]} / ${sp.alpha})`; }
        }
      }
    }
    return word + '(' + transform(inner, role, env) + ')';
  }

  // ---------------------------------------------------------------- custom properties
  const RGB3 = /^(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})$/;
  const HSL3 = /^([\d.]+)(deg)?(\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%$/;

  function isSingleToken(v) {
    v = v.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^[a-z]+$/i.test(v)) return true;
    const m = /^([\w-]+)\(/.exec(v);
    if (!m) return false;
    const name = m[1].toLowerCase();
    return matchParen(v, m[0].length - 1) === v.length - 1 && (name === 'var' || COLOR_FNS.has(name));
  }

  // Classify the value of a custom property.
  function analyzeCustom(value) {
    const v = value.trim();
    let m = RGB3.exec(v);
    if (m && +m[1] <= 255 && +m[3] <= 255 && +m[4] <= 255) {
      return { kind: 'rgb3', c: [+m[1], +m[3], +m[4]], sep: m[2].includes(',') ? ', ' : ' ', color: true, pure: true, refs: [] };
    }
    m = HSL3.exec(v);
    if (m) {
      return { kind: 'hsl3', c: hslToRgb(+m[1], +m[4], +m[5]), deg: m[2] || '', sep: m[3].includes(',') ? ', ' : ' ', color: true, pure: true, refs: [] };
    }
    const env = { refs: [], found: false };
    transform(v, 'bg', env);
    return { kind: 'val', color: env.found, pure: isSingleToken(v), refs: env.refs };
  }

  // Per-role twins for one custom property declaration: [[prop, value], ...]
  function customDecls(name, value, info, env) {
    const out = [];
    for (const role of ROLES) {
      let t;
      if (info.kind === 'rgb3') t = mapRgb(role, info.c[0], info.c[1], info.c[2]).join(info.sep);
      else if (info.kind === 'hsl3') {
        const m = mapRgb(role, info.c[0], info.c[1], info.c[2]);
        const h = rgbToHsl(m[0], m[1], m[2]);
        t = `${h[0]}${info.deg}${info.sep}${h[1]}%${info.sep}${h[2]}%`;
      } else {
        const e = { colorVars: env.colorVars, base: env.base, found: false };
        t = transform(value, role, e);
        if (!e.found) continue;   // emit even when unchanged so nested scopes do not inherit a stale twin
      }
      out.push(['--adm-' + role + name, t]);
    }
    return out;
  }

  // Grow the set of colour-carrying variable names to a fixpoint. Returns true if it changed.
  function growVars(customs, colorVars, composite) {
    const list = Array.from(customs);
    let grew = false, again = true;
    while (again) {
      again = false;
      for (const c of list) {
        const info = c.info;
        if (!(info.color || info.refs.some(r => colorVars.has(r)))) continue;
        if (!colorVars.has(c.name)) { colorVars.add(c.name); grew = again = true; }
        if (!composite.has(c.name) && (!info.pure || info.refs.some(r => composite.has(r)))) {
          composite.add(c.name); grew = again = true;
        }
      }
    }
    return grew;
  }

  // ---------------------------------------------------------------- declarations
  const PROPS = {
    'color': 'fg', 'background-color': 'bg', 'background-image': 'bg',
    'border-top-color': 'bd', 'border-right-color': 'bd', 'border-bottom-color': 'bd', 'border-left-color': 'bd',
    'border-block-start-color': 'bd', 'border-block-end-color': 'bd',
    'border-inline-start-color': 'bd', 'border-inline-end-color': 'bd',
    'outline-color': 'bd', 'column-rule-color': 'bd',
    'text-decoration-color': 'fg', 'caret-color': 'fg',
    '-webkit-text-fill-color': 'fg', '-webkit-text-stroke-color': 'fg',
    'fill': 'fg', 'stroke': 'fg', 'stop-color': 'fg',
    'box-shadow': 'sh', 'text-shadow': 'bg',
  };
  // Shorthands only matter when they contain var(): then the longhands read back empty.
  const SHORTHANDS = { // name -> [role, colour longhand | null = re-emit whole]
    'background': ['bg', 'background-color'],
    'border': ['bd', 'border-color'], 'border-color': ['bd', null],
    'border-top': ['bd', 'border-top-color'], 'border-right': ['bd', 'border-right-color'],
    'border-bottom': ['bd', 'border-bottom-color'], 'border-left': ['bd', 'border-left-color'],
    'outline': ['bd', 'outline-color'], 'column-rule': ['bd', 'column-rule-color'],
    'text-decoration': ['fg', 'text-decoration-color'],
  };
  const LONG2SHORT = {
    'background-color': ['background'], 'background-image': ['background'],
    'border-top-color': ['border-top', 'border-color', 'border'],
    'border-right-color': ['border-right', 'border-color', 'border'],
    'border-bottom-color': ['border-bottom', 'border-color', 'border'],
    'border-left-color': ['border-left', 'border-color', 'border'],
    'outline-color': ['outline'], 'column-rule-color': ['column-rule'],
    'text-decoration-color': ['text-decoration'],
  };

  function shorthandDecl(p, v, env, roleOverride) {
    const longhand = SHORTHANDS[p][1];
    const role = roleOverride || SHORTHANDS[p][0];
    const sub = () => ({ colorVars: env.colorVars, base: env.base, docBase: env.docBase, bg: env.bg, found: false });
    let whole = !longhand, cand = null;
    for (const t of splitTop(v, c => c === ',' || c === '/' || /\s/.test(c))) {
      if (!t) continue;
      const m = /^var\(\s*(--[^\s,)]+)/.exec(t);
      if (m && env.colorVars.has(m[1])) {
        if (env.composite.has(m[1])) whole = true; else cand = t;
        continue;
      }
      // Not a colour variable (or not a var at all): a var() fallback such as
      // var(--line, #ddd) can still carry a colour, so let transform() look inside.
      const e = sub();
      transform(t, role, e);
      if (e.found) { if (isSingleToken(t)) cand = t; else whole = true; }
    }
    const e = sub();
    if (whole) { const t = transform(v, role, e); return e.found ? [p, t] : null; }
    if (cand) { const t = transform(cand, role, e); return e.found ? [longhand, t] : null; }
    // background: none / url(...) also clears the colour; say so, for the same cascade reason as in genBody
    if (p === 'background' && !v.includes('var(')) return ['background-color', 'transparent'];
    return null;
  }

  /*
   * items: [{ p, v, i (important), info? (custom property analysis) }]
   * env:   { colorVars, composite, base }
   * Returns the body of the override rule ('' when nothing needs to change).
   */
  const RESTATE = /^(inherit|initial|unset|revert|revert-layer|currentcolor|none)$/i;
  function genBody(items, env, forceImportant) {
    let body = '';
    for (const it of items) {
      if (it.v.length > 400000) continue;      // absurdly large value (embedded file): not worth the time
      const imp = it.i || forceImportant ? ' !important' : '';
      if (it.blend) {
        // multiply/darken assume a white page underneath; on a dark page they black the element out
        body += `mix-blend-mode:normal${imp};`;
      } else if (it.info) {
        if (!env.colorVars.has(it.p)) continue;
        for (const [k, t] of customDecls(it.p, it.v, it.info, env)) body += `${k}:${t}${imp};`;
      } else if (SHORTHANDS[it.p]) {
        const d = shorthandDecl(it.p, it.v, env, it.role);
        if (d) {
          body += `${d[0]}:${d[1]}${imp};`;
          // Recovered from source text (see lossyDecls): the page set related properties after
          // the shorthand, so restate them in order or our override would undo them.
          const whole = d[0] === it.p;
          for (const a of it.after || []) {
            const role = SHORTHANDS[a.p] ? SHORTHANDS[a.p][0] : PROPS[a.p];
            if (!role && !whole) continue;
            const v = role ? transform(a.v, role, { colorVars: env.colorVars, base: env.base, docBase: env.docBase, bg: env.bg, found: false }) : a.v;
            body += `${a.p}:${v}${a.i || forceImportant ? ' !important' : ''};`;
          }
        }
      } else {
        const e = { colorVars: env.colorVars, base: env.base, docBase: env.docBase, bg: env.bg, found: false };
        const t = transform(it.v, it.role || PROPS[it.p], e);
        // Restate the declaration even when the colour comes out unchanged (white text on a
        // coloured band) or is a keyword (inherit, transparent): our sheet sits after the page's,
        // so an override of an EARLIER rule would otherwise beat this later one.
        if (e.found) body += `${it.p}:${t}${imp};`;
        else if (RESTATE.test(it.v.trim())) body += `${it.p}:${it.v.trim()}${imp};`;
      }
    }
    return body;
  }

  // ---------------------------------------------------------------- source-text recovery
  /*
   * Firefox cannot give back a shorthand that contains var() once a related property is
   * declared after it in the same rule, e.g.
   *     background: linear-gradient(transparent, var(--bg)); background-repeat: no-repeat;
   * Every background-* longhand then reads '' and so does `background`. The only place the
   * value still exists is the stylesheet's source text, so this scans the text for exactly
   * that pattern. Returns, in document order: [{ sel, items: [{ p, v, i, after: [{p,v,i}] }] }]
   */
  const GROUP_AT = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;
  const sameFamily = (sh, p) =>
    p !== sh && (p.startsWith(sh + '-') ||
      (sh === 'border' && /^border-(top|right|bottom|left|block|inline|color|style|width)/.test(p)) ||
      (sh === 'border-color' && /^border-.+-color$/.test(p)));

  function lossyDecls(text) {
    const s = String(text).replace(/\/\*[\s\S]*?\*\//g, ' ');
    const n = s.length, out = [];
    let i = 0, order = 0;
    const chunk = () => {            // text up to the next top-level '{', ';' or '}'
      const st = i; let d = 0;
      for (; i < n; i++) {
        const c = s[i];
        if (c === '"' || c === "'") { i = skipStr(s, i); continue; }
        if (c === '(' || c === '[') d++;
        else if (c === ')' || c === ']') d--;
        else if (d <= 0 && (c === '{' || c === ';' || c === '}')) break;
      }
      return s.slice(st, i).trim();
    };
    const skipBlock = () => {        // i is just past '{'
      for (let d = 1; i < n && d; i++) {
        const c = s[i];
        if (c === '"' || c === "'") i = skipStr(s, i);
        else if (c === '{') d++; else if (c === '}') d--;
      }
    };
    const block = sel => {           // sel: selector of the style rule we are inside, or null
      const decls = [], my = order++;
      while (i < n) {
        const pre = chunk(), end = s[i];
        i++;
        if (end === '{') {
          if (/^--[\w-]*\s*:/.test(pre)) skipBlock();                 // custom property holding a {} block
          else if (pre[0] === '@') { if (GROUP_AT.test(pre)) block(null); else skipBlock(); }
          else block(pre);
          continue;
        }
        if (sel !== null && pre) {
          const k = pre.indexOf(':');
          const p = k > 0 ? pre.slice(0, k).trim().toLowerCase() : '';
          if (/^[a-z][a-z-]*$/.test(p)) {
            let v = pre.slice(k + 1).trim();
            const imp = /!\s*important$/i.test(v);
            if (imp) v = v.replace(/!\s*important$/i, '').trim();
            decls.push({ p, v, i: imp });
          }
        }
        if (end !== ';') break;      // '}' or end of text closes this block
      }
      const items = [];
      for (let a = 0; a < decls.length; a++) {
        const d = decls[a];
        if (!SHORTHANDS[d.p] || !/var\(/i.test(d.v)) continue;
        const after = decls.slice(a + 1).filter(x => sameFamily(d.p, x.p));
        if (after.length) items.push({ p: d.p, v: d.v, i: d.i, after });
      }
      if (items.length) out.push({ sel, items, order: my });
    };
    while (i < n) block(null);
    return out.sort((a, b) => a.order - b.order);
  }

  // ---------------------------------------------------------------- image statistics
  /*
   * Pure decision on a 48x48 RGBA sample. Pixels are weighted by their opacity so thin
   * anti-aliased strokes (wordmarks, hairline icons) still count as ink.
   *   kind 'img': an <img>: invert line art, diagrams and dark glyphs; keep photos.
   *   kind 'bg' : a CSS background: additionally invert light, colourless textures and
   *               gradients (they would otherwise sit bright behind text that is now light).
   */
  function decideImage(d, kind, jpeg) {
    const hist = new Array(8).fill(0);
    let ink = 0, clear = 0, sumC = 0, light = 0, dark = 0, sumL = 0, darkInk = 0, low = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const w = d[i + 3] / 255;
      clear += 1 - w;
      if (w < 0.03) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const ch = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      ink += w; sumL += l * w; sumC += w * ch; if (l < 0.7) low += w;
      if (l > 0.85) light += w; else if (l < 0.3) { dark += w; if (ch < 0.15) darkInk += w; }
      hist[Math.min(7, (l * 8) | 0)] += w;
    }
    if (ink < 6) return false;                                  // practically empty
    // Photographs of white, grey or black things (product shots on a white backdrop, cut-outs)
    // are as colourless as drawings. What gives them away is shading: whole areas of in-between
    // tones that vary. A drawing has in-between tones only along its edges (anti-aliasing) or as
    // flat fills of a single tone.
    // JPEG is the photo format. A dark object shot on white (cables, keyboards, furniture) has too
    // little shading at this size to be told from a drawing, so for <img> the format decides.
    // One exception: a pale, colourless, featureless picture. If the page shows it very large it is
    // a backdrop with text on top (the content script checks the size), not something to look at.
    const backdrop = kind !== 'bg' && clear / n < 0.1 && sumL / ink > 0.85 && sumC / ink < 0.08 && low / ink < 0.01 ? 'backdrop' : false;
    if (kind !== 'bg' && (jpeg || shaded(d, ink))) return backdrop;
    // On transparency (logos, icons): invert when most of the ink is black/grey, even if a
    // coloured emblem sits beside it (invert + hue-rotate keeps the emblem's hue).
    if (clear / n > 0.1) return darkInk / ink > 0.5;
    if (sumC / ink > 0.12) return false;                        // colourful: photo or brand art, keep
    const top = hist.slice().sort((a, b) => b - a);
    // flat, mostly white with some dark ink: diagrams, scans, black-on-white logos
    if ((top[0] + top[1]) / ink >= 0.8 && light / ink > 0.55 && dark / ink > 0.02) return true;
    // colourless and bright all over: a light texture or gradient strip behind text (backgrounds),
    // or a near-white banner / pale wordmark (<img>, stricter so greyscale photos are kept)
    // An <img> must be pale throughout: a white object photographed on white has darker details.
    return kind === 'bg' ? sumL / ink > 0.8 : (sumL / ink > 0.92 && low / ink < 0.01) || backdrop;
  }

  // True when a square RGBA sample contains shading. Looks only at smooth spots (a pixel whose
  // four neighbours are nearly the same tone, so not an edge) and counts how many different
  // tones those spots have. A drawing's smooth spots are its paper and its ink: two or three
  // tones, a few more with flat grey fills or JPEG noise. A photo has many, even when the thing
  // photographed is white on white (soft shadows) or black (highlights).
  function shaded(d, ink) {
    const side = Math.round(Math.sqrt(d.length / 4));
    const lum = new Float32Array(side * side);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
      lum[p] = d[i + 3] > 127 ? (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 : -9;   // -9: see-through
    }
    const tones = new Array(64).fill(0), near = (a, b) => Math.abs(a - b) < 0.08;
    let smooth = 0;
    for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
      const p = y * side + x, l = lum[p];
      if (l < 0 || !near(l, lum[p - 1]) || !near(l, lum[p + 1]) || !near(l, lum[p - side]) || !near(l, lum[p + side])) continue;
      smooth++; tones[Math.min(63, (l * 64) | 0)]++;
    }
    const min = Math.max(3, lum.length / 800), used = tones.filter(c => c >= min), top = tones.slice().sort((a, b) => b - a);
    return used.length >= 8 && (smooth - top[0] - top[1]) / ink > 0.04;
  }

  return {
    lossyDecls, decideImage, mapL,
    TUNE, ROLES, PROPS, SHORTHANDS, LONG2SHORT,
    rgbToOklch, oklchToRgb, lightness, mapRgb, parseFast, parseColor,
    setResolver: f => { resolver = f; parseCache.clear(); },
    transform, analyzeCustom, customDecls, growVars, genBody,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ADM;
