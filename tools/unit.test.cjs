// Unit tests for color.js (pure logic). Run: node --test unit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const A = require(path.resolve(process.env.ADM_EXT || '../extension', 'color.js'));

const lum = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const env = (vars = [], extra = {}) => Object.assign({ colorVars: new Set(vars), composite: new Set(), found: false }, extra);
const body = (items, e) => A.genBody(items, e || env(), false);

test('OKLCH round trip is exact for sRGB corners and greys', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [18, 52, 86], [128, 128, 128], [250, 240, 230]]) {
    const [L, C, h] = A.rgbToOklch(...c);
    assert.deepEqual(A.oklchToRgb(L, C, h), c);
  }
});

test('roles: white background goes dark, black text goes light, hue is kept', () => {
  assert.ok(A.lightness(A.mapRgb('bg', 255, 255, 255)) < 0.25);
  assert.ok(A.lightness(A.mapRgb('fg', 0, 0, 0)) > 0.85);
  assert.deepEqual(A.mapRgb('bg', 20, 20, 20), [20, 20, 20], 'dark backgrounds stay');
  assert.deepEqual(A.mapRgb('fg', 255, 255, 255), [255, 255, 255], 'light text stays');
  const h0 = A.rgbToOklch(255, 235, 200)[2], m = A.mapRgb('bg', 255, 235, 200), h1 = A.rgbToOklch(...m)[2];
  assert.ok(Math.abs(h0 - h1) < 0.12, 'hue drift ' + Math.abs(h0 - h1));
});

test('WCAG 4.5:1 text contrast is never lost by the mapping (Safari\'s stated target)', () => {
  const pal = [];
  for (let L = 0; L <= 1.0001; L += 0.05) {
    pal.push(A.oklchToRgb(L, 0, 0));
    for (let h = 0; h < 360; h += 45) { pal.push(A.oklchToRgb(L, 0.08, h * Math.PI / 180)); pal.push(A.oklchToRgb(L, 0.2, h * Math.PI / 180)); }
  }
  let checked = 0;
  for (const fg of pal) for (const bg of pal) {
    if (cr(fg, bg) < 4.5) continue;
    checked++;
    const m = cr(A.mapRgb('fg', ...fg), A.mapRgb('bg', ...bg));
    assert.ok(m >= 4.5, `fg ${fg} on bg ${bg}: ${m.toFixed(2)}`);
  }
  assert.ok(checked > 10000);
});

test('parseFast understands hex, rgb(), hsl(), modern syntax and alpha', () => {
  assert.deepEqual(A.parseFast('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(A.parseFast('#00000080'), [0, 0, 0, 0.502]);
  assert.deepEqual(A.parseFast('rgb(255 0 0 / 50%)'), [255, 0, 0, 0.5]);
  assert.deepEqual(A.parseFast('rgba(1, 2, 3, .25)'), [1, 2, 3, 0.25]);
  assert.deepEqual(A.parseFast('hsl(120, 100%, 50%)'), [0, 255, 0, 1]);
  assert.equal(A.parseFast('url(x)'), null);
});

test('transform: literals, variables, fallbacks, Tailwind alpha, strings untouched', () => {
  let e = env();
  assert.match(A.transform('#ffffff', 'bg', e), /^#1[0-9a-f]1[0-9a-f]1[0-9a-f]$/); assert.ok(e.found);
  e = env(['--x']);
  assert.equal(A.transform('var(--x)', 'fg', e), 'var(--adm-fg--x, var(--x))');
  e = env();
  assert.match(A.transform('var(--nope, #fff)', 'bg', e), /^var\(--nope,\s*#1/); assert.ok(e.found);
  e = env();
  assert.match(A.transform('rgb(255 255 255 / var(--tw-bg-opacity))', 'bg', e), /^rgb\(2\d 2\d 2\d \/ var\(--tw-bg-opacity\)\)$/);
  e = env();
  assert.equal(A.transform('"#fff white"', 'bg', e), '"#fff white"'); assert.equal(e.found, false);
  e = env();
  assert.equal(A.transform('transparent', 'bg', e), 'transparent');
  e = env();
  assert.match(A.transform('linear-gradient(to right, #fff 0%, rgba(255,255,255,0) 100%)', 'bg', e), /^linear-gradient\(to right, #1\w+ 0%, rgba\(255,255,255,0\) 100%\)$/);
});

test('url(): made absolute for linked sheets, recoloured copy substituted for backgrounds', () => {
  let e = env([], { base: 'https://cdn.example/css/a.css' });
  assert.equal(A.transform('url(../img/i.png)', 'bg', e), 'url("https://cdn.example/img/i.png")');
  assert.equal(e.found, false);
  const asked = [];
  e = env([], { docBase: 'https://site.example/p/', bg: u => { asked.push(u); return 'data:image/svg+xml;base64,AAAA'; } });
  assert.equal(A.transform('url(icon.svg) no-repeat', 'bg', e), 'url("data:image/svg+xml;base64,AAAA") no-repeat');
  assert.deepEqual(asked, ['https://site.example/p/icon.svg']); assert.ok(e.found);
  e = env([], { bg: () => 'x' });
  assert.equal(A.transform('url(#grad)', 'fg', e), 'url(#grad)', 'fragment refs and non-background roles are untouched');
  const got = [];
  e = env([], { bg: u => { got.push(u); return null; } });
  A.transform('url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\" fill=\\27 red\\27/>")', 'bg', e);
  assert.deepEqual(got, ['data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" fill=\'red\'/>'], 'CSS escapes are decoded before the image is fetched');
});

test('custom properties: rgb triplets, hsl triplets, twins per role', () => {
  const i = A.analyzeCustom('255, 255, 255');
  assert.equal(i.kind, 'rgb3');
  const d = Object.fromEntries(A.customDecls('--bs-body-bg-rgb', '255, 255, 255', i, env()));
  assert.match(d['--adm-bg--bs-body-bg-rgb'], /^2\d, 2\d, 2\d$/);
  assert.equal(d['--adm-fg--bs-body-bg-rgb'], '255, 255, 255');
  assert.equal(A.analyzeCustom('0 0% 100%').kind, 'hsl3');
  assert.equal(A.analyzeCustom('12px').color, false);
  const vars = new Set(), comp = new Set();
  A.growVars([{ name: '--a', info: A.analyzeCustom('#fff') }, { name: '--b', info: A.analyzeCustom('var(--a)') }, { name: '--c', info: A.analyzeCustom('1px solid var(--b)') }], vars, comp);
  assert.deepEqual([...vars].sort(), ['--a', '--b', '--c']);
  assert.deepEqual([...comp], ['--c']);
});

test('genBody: longhands, shorthands with var(), fallback colours, !important', () => {
  assert.match(body([{ p: 'color', v: '#000', i: false }]), /^color:#[d-f]\w+;$/);
  assert.equal(body([{ p: 'color', v: '#fff', i: false }]), 'color:#fff;', 'already-light text is restated so an earlier override cannot beat it');
  assert.equal(body([{ p: 'color', v: 'inherit', i: false }]), 'color:inherit;', 'keywords are restated for the same reason');
  assert.equal(body([{ p: 'background', v: 'none', i: true }]), 'background-color:transparent !important;', 'background: none clears the colour');
  assert.equal(body([{ p: 'border', v: 'none', i: false }]), '', 'border: none needs nothing');
  assert.equal(body([{ p: 'background', v: 'var(--bg)', i: true }], env(['--bg'])), 'background-color:var(--adm-bg--bg, var(--bg)) !important;');
  assert.match(body([{ p: 'border', v: '1px solid var(--line, #dddddd)', i: false }]), /^border-color:var\(--line,\s*#[34]\w+\);$/);
  assert.equal(body([{ p: 'background', v: 'var(--img) center', i: false }]), '', 'non-colour variable: leave alone');
});

test('genBody: masked icons use the text role, blend modes are neutralised', () => {
  assert.equal(body([{ p: 'background-color', v: '#202122', i: false }]), 'background-color:#202122;', 'dark surface stays (restated)');
  assert.match(body([{ p: 'background-color', v: '#202122', i: false, role: 'fg' }]), /^background-color:#[c-f]\w+;$/);
  assert.equal(body([{ p: 'mix-blend-mode', v: 'normal', blend: true, i: false }]), 'mix-blend-mode:normal;');
});

test('genBody: recovered shorthand restates what followed it', () => {
  const items = [{ p: 'background', v: 'linear-gradient(rgba(255,255,255,0),var(--bg,#fff))', i: false, after: [{ p: 'background-repeat', v: 'no-repeat', i: false }] }];
  const b = body(items);
  assert.match(b, /^background:linear-gradient\(rgba\(255,255,255,0\),var\(--bg,#1\w+\)\);background-repeat:no-repeat;$/);
  const c = body([{ p: 'background', v: 'var(--bg)', i: false, after: [{ p: 'background-color', v: '#ffeeee', i: false }, { p: 'background-size', v: 'cover', i: false }] }], env(['--bg']));
  assert.match(c, /^background-color:var\(--adm-bg--bg, var\(--bg\)\);background-color:#\w+;$/, 'longhand case restates colours only');
});

test('lossyDecls: finds shorthand+var followed by a related property, in document order', () => {
  const css = `
    /* comment with { brace */
    @charset "utf-8";
    .a{color:red;background:var(--x);background-size:cover}
    .skip{background:var(--x)}
    .skip2{background:#fff;background-size:cover}
    @media screen{ .b::after{content:"}{";background:linear-gradient(#fff,var(--y)) !important;background-repeat:no-repeat} }
    @font-face{font-family:x;src:url(a.woff)}
    @keyframes k{from{background:var(--x);background-size:1px}}
    .c{border:1px solid var(--l);border-bottom:0; .d{outline:1px solid var(--o);outline-offset:2px} }
    .e{--json:{a:b};border-color:var(--l);border-top-color:transparent}`;
  const r = A.lossyDecls(css);
  assert.deepEqual(r.map(x => x.sel), ['.a', '.b::after', '.c', '.d', '.e']);
  assert.deepEqual(r[0].items, [{ p: 'background', v: 'var(--x)', i: false, after: [{ p: 'background-size', v: 'cover', i: false }] }]);
  assert.equal(r[1].items[0].i, true);
  assert.equal(r[1].items[0].v, 'linear-gradient(#fff,var(--y))');
  assert.deepEqual(r[2].items[0].after.map(a => a.p), ['border-bottom']);
  assert.deepEqual(r[3].items[0].after.map(a => a.p), ['outline-offset']);
  assert.deepEqual(r[4].items[0].after.map(a => a.p), ['border-top-color']);
  assert.deepEqual(A.lossyDecls('.x{background:var(--a'), [], 'truncated input does not throw');
});

// ---- image decision on synthetic 48x48 samples
const S = 48;
function sample(fn) { const d = new Uint8ClampedArray(S * S * 4); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const p = fn(x, y), i = (y * S + x) * 4; d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = p[3]; } return d; }
test('decideImage: glyphs, line art, photos, thin strokes, textures', () => {
  const glyph = sample((x, y) => (x > 12 && x < 36 && y > 12 && y < 36 ? [20, 20, 20, 255] : [0, 0, 0, 0]));
  const whiteGlyph = sample((x, y) => (x > 12 && x < 36 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const lineArt = sample((x, y) => (x % 12 === 0 || y % 12 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const photo = sample((x, y) => [x * 5, 255 - y * 5, (x * y) % 255, 255]);
  const thin = sample((x, y) => (y % 6 === 0 ? [0, 0, 0, 70] : [0, 0, 0, 0]));       // anti-aliased wordmark
  const texture = sample((x, y) => { const v = 235 + ((x + y) % 3) * 6; return [v, v, v, 255]; });
  const greyPhoto = sample((x, y) => { const v = (x * 5 + y * 3) % 256; return [v, v, v, 255]; });
  assert.equal(A.decideImage(glyph, 'img'), true);
  assert.equal(A.decideImage(whiteGlyph, 'img'), false);
  assert.equal(A.decideImage(lineArt, 'img'), true);
  assert.equal(A.decideImage(photo, 'img'), false);
  assert.equal(A.decideImage(thin, 'img'), true);
  assert.equal(A.decideImage(texture, 'img'), true, 'a near-white, colourless <img> (pale banner) is darkened');
  const pale = sample((x, y) => { const v = 205 + ((x + y) % 3) * 6; return [v, v, v, 255]; });
  assert.equal(A.decideImage(pale, 'img'), false, 'a light-grey <img> is left alone');
  assert.equal(A.decideImage(pale, 'bg'), true);
  assert.equal(A.decideImage(texture, 'bg'), true, 'a light background texture is darkened');
  assert.equal(A.decideImage(greyPhoto, 'bg'), false);
  assert.equal(A.decideImage(new Uint8ClampedArray(S * S * 4), 'img'), false, 'empty image');
  const wordmark = sample((x, y) => (y > 16 && y < 32 ? (x < 36 ? [0, 0, 0, 255] : [14, 101, 192, 255]) : [0, 0, 0, 0]));   // black text + blue emblem
  const brand = sample((x, y) => (y > 16 && y < 32 ? (x < 8 ? [0, 0, 0, 255] : [220, 40, 40, 255]) : [0, 0, 0, 0]));
  const navy = sample((x, y) => (y > 16 && y < 32 ? [0, 51, 102, 255] : [0, 0, 0, 0]));
  assert.equal(A.decideImage(wordmark, 'img'), true, 'mostly-black logo with a coloured emblem');
  assert.equal(A.decideImage(brand, 'img'), false, 'mostly-coloured logo is kept');
  assert.equal(A.decideImage(navy, 'img'), false, 'coloured glyphs are kept');

  // Product photos: a shaded object on a pure white backdrop (white camera with a dark lens),
  // a black object on white, and a dark cut-out on transparency. All colourless, none a drawing.
  const ball = (cx, cy, r, lo, hi, bg) => sample((x, y) => {
    const dd = Math.hypot(x - cx, y - cy);
    if (dd > r) return bg;
    if (dd < 4) return [15, 15, 15, 255];                                    // lens
    const v = Math.round(hi - (hi - lo) * (Math.hypot(x - cx + 6, y - cy + 6) / (r + 6)));   // lit from top-left
    return [v, v, v, 255];
  });
  assert.equal(A.decideImage(ball(24, 24, 16, 150, 250, [255, 255, 255, 255]), 'img'), false, 'white product on white is a photo');
  assert.equal(A.decideImage(ball(24, 24, 16, 8, 120, [255, 255, 255, 255]), 'img'), false, 'black product on white is a photo');
  assert.equal(A.decideImage(ball(24, 24, 16, 8, 120, [0, 0, 0, 0]), 'img'), false, 'dark cut-out product is a photo');
  assert.equal(A.decideImage(lineArt, 'img', true), false, 'a JPEG <img> is never inverted');
  assert.equal(A.decideImage(lineArt, 'bg', true), true, 'the JPEG rule does not apply to background images');
  const haze = sample((x, y) => { const v = 226 + ((x * 3 + y * 5) % 17); return [v, v - 2, v - 3, 255]; });   // pale, soft, featureless
  assert.equal(A.decideImage(haze, 'img', true), 'backdrop', 'a pale featureless JPEG is a candidate backdrop');
  assert.equal(A.decideImage(ball(24, 24, 16, 150, 250, [255, 255, 255, 255]), 'img', true), false, 'a white product photo is not a backdrop');
  // Drawings keep being recognised: anti-aliased strokes and a diagram with flat grey boxes.
  const soften = sample((x, y) => { const e = Math.min(x % 12, 12 - (x % 12)); return e === 0 ? [0, 0, 0, 255] : e === 1 ? [128, 128, 128, 255] : [255, 255, 255, 255]; });
  const boxes = sample((x, y) => (x % 16 === 0 || y % 16 === 0 ? [0, 0, 0, 255] : (x > 16 && x < 32 && y > 16 && y < 32 ? [210, 210, 210, 255] : [255, 255, 255, 255])));
  assert.equal(A.decideImage(soften, 'img'), true, 'anti-aliased line art is still inverted');
  assert.equal(A.decideImage(boxes, 'img'), true, 'diagram with a flat grey fill is still inverted');
});
