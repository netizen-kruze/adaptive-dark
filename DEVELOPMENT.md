# Adaptive Dark: developer notes

Firefox extension (Manifest V2) that darkens light-only websites, modelled on Safari 27.3's Adaptive Dark Mode.
The extension is in `extension/`, the tests in `tools/`. This file records what has been tested, how the design
maps to what Apple published, and the Firefox behaviours that cost time to discover.

## Status: v0.4.0 (2026-11-17), tested in Firefox 160 on Windows 11
- `npx web-ext lint`: 0 errors, 0 warnings.
- 12 unit tests (Node) and 133 end-to-end checks (real Firefox, headless) pass.
- 19 real sites load with no extension errors in the Browser Console.
- Real-screen sampling (165 samples/s, visible window, dark Firefox theme): 0 light frames across 9 navigations.
- Not machine-testable: the physical Alt+Shift+D key press (its handler and registration are tested).
- Not tested: crowdsupply.com itself in the test browser (Cloudflare bot check; its structure is a fixture), real old.reddit.com pages (login wall), a real light-only Tailwind site (covered by fixtures only).
- "Script terminated by timeout" in the Browser Console (at a different harmless line each time, ~3 runs in 5)
  was Firefox killing the content script on the transient about:blank document of a brand-new tab, not slow
  code. Fixed in 0.3.1 by not starting on a top-level about:blank without an opener (5 clean runs in a row).
  The one-off at `splitTop` during a real-site run in 0.2.0 was probably the same thing; unproven.

- Product photos (0.3.2): colourless photos (white/black objects on white) were inverted as line art.
  `shaded()` in color.js now counts distinct tones among smooth, non-edge pixels of a 96x96 sample; drawings
  have few, photos many. Checked on Amazon search pages: 1 of 262 product images still inverted (a thin white
  lamp), Wikipedia circuit diagrams and text GIFs still inverted. Amazon is not in the scripted site lists.

- Wide sweep (0.4.0): `sweep.cjs` over 151 public sites (`sites-wide.json`), dark scheme; 8 blocked by bot checks,
  102 darkened, 41 left alone. After the fixes below: 0 pages with unconverted light boxes, 0 with text made
  unreadable (contrast < 2.5 where the page's own was fine), longest single pause 209 ms (rottentomatoes),
  most total work 2.4 s over 59 rebuilds (ibm.com, CSS-in-JS churn). Bugs it found, all with fixtures in
  `/sweep-cases.html` or unit tests:
  - cascade: an override of an earlier rule beat a later page rule whose colour mapped to itself (rust-lang.org).
    `genBody` now restates every colour declaration, keywords included, and `background: none`.
  - `all: initial` made `/mask/.test(cssText)` true, so a white overlay was treated as a masked icon (techcrunch).
  - `@property` colour defaults had no twins (apple.com) -> emitted on `:root`.
  - inline `style="background: var(--x)"` (microsoft.com) -> `processInline` rewrites the shorthand.
  - page `!important` in adopted sheets beat ours by order -> those overrides go in an anonymous `@layer`.
  - JPEG <img> is never inverted (dark products on white); large pale featureless images are 'backdrop' and
    inverted only when they cover a third of the window (microsoft.com hero).
  - a shared canvas was read after an `await` in `load()` (race between parallel image analyses).
  Known and not fixed: light text over a light <video> (ui.com hero); one WebP product shot (raspberrypi.com);
  `Promise resolved while context is inactive` console lines when a tab navigates mid-message.

## How to test (run from `tools/`; `npm install` once; set `FIREFOX_BIN` if Firefox is not in the default Windows location)
- `npm test` — unit tests, `e2e.cjs` (fixtures served by `server.cjs`), then lint. Exit code 0 = pass.
- `npm run sites` / `node harness.cjs <ext> <out> sites dark|light` (env `SITES=sites2.json` for the second list).
- `npm run flash` — `flash-real.cjs` + `capture.ps1`: visible window, real screen pixels. Pass `none` instead of
  the extension folder for the baseline.
- `node perf-work.cjs <ext>` — rebuild count and longest pause per site. `node perf.cjs <ext>` — load-time delta.
- `npm run sweep` then `node sweep-report.cjs out/sweep` (add a `node sweep.cjs none out/sweep` baseline first) and
  `node sheet.cjs out/sweep/sweep-addon-dark.json out/sweep/sheets` for contact sheets of every inverted image.
- When adding a feature: add a fixture to `server.cjs` and an `ok(...)` check to `e2e.cjs`.

## What Apple published (webkit.org/blog/18541, 2026-11-03) and how this matches
Apple gives no algorithm or numbers except the WCAG 4.5:1 text target. Behaviours:
- Backs off on `color-scheme: light dark` (meta or CSS on :root/body) and `light only` -> `ownsScheme()`.
  Per-element `only light` is NOT implemented here (page level only).
- Estimates whether the page is predominantly light or dark -> `leaveAlone()`: base colour of body/html, then
  `lightShare()` (36 viewport sample points) overrules a 'dark' verdict when at least half of the screen is light
  (crowdsupply.com: body #222, all content in white sections). After a 'dark'/'declares' teardown,
  `watchForChange()` looks again at 0.6/1.5/4/10 s and on html/body theme-attribute changes (max 4 restarts).
- Per-site override: `settings.force{host:true}` -> `cfg.force` skips every leave-alone check (popup: Force dark).
- Inverts luminosity, keeps hue, aims for 4.5:1 -> `mapL()`; the unit test proves no pair that had 4.5:1 loses it.
- Darkens light gradients; inverts simple black-and-white bitmaps by histogram; transforms SVG colours;
  leaves photos and canvas -> `decideImage()`, `recolour()`.
- Turns off masks / mix-blend-mode where needed -> mask => text role, multiply/darken/color-burn => normal.
- Requires system dark appearance -> optional here ("Follow light / dark mode").
- Hides itself from the page -> not possible for an extension.

## Firefox facts learned the hard way
- A shorthand containing `var()` reads back as raw text ONLY if no related property follows it in the rule.
  `background: var(--x); background-repeat: y` blanks both. Recovered from source text (`lossyDecls`, `recoverLost`).
- A content script's `<style>` passes the page CSP only if its text is set BEFORE insertion. `data:` background
  images referenced from it also pass `img-src 'self'`. The `tabs.insertCSS` fallback has never been exercised.
- `browser.runtime.sendMessage` for the enabled state is too slow for cached pages: a frame can paint first.
  The background page therefore registers a one-line script per enabled site that boots content.js synchronously
  (`ADM.boot` / `ADM_PRE`).
- Stylesheet `load` events and parser-inserted `<style>` must be handled immediately (`rebuildNow`), not debounced.
- Headless WebDriver screenshots show a white frame before layout starts; a real window with a dark Firefox theme
  shows Firefox's own dark backstop there. Trust `flash-real.cjs`, not headless screenshots, for flash questions.
- `getPropertyValue` returns `url("...")` with CSS-escaped quotes; unescape before fetching (`urlFn`).
- WebDriver cannot press extension shortcuts, and `-remote-allow-system-access` must go to geckodriver as
  `--allow-system-access`.

## Architecture
- `color.js` — pure. OKLCH math, `mapL(role, L)` for roles bg/fg/bd/sh, `transform(value, role, env)` rewrites one
  CSS value (env.bg swaps background image URLs), `analyzeCustom`/`customDecls`/`growVars` handle colour custom
  properties (per-role twins `--adm-<role>--name`), `genBody` builds an override rule body, `lossyDecls` scans
  stylesheet text, `decideImage` classifies a 96x96 pixel sample (`shaded` tells photos from drawings).
- `content.js` — per document/shadow-root `Scope`: extracts colour declarations from every stylesheet via CSSOM
  (cached per sheet by rule count + media), emits override rules with the same selector and wrappers into one
  `<style data-adm-s>` kept last in `<html>`. `processInline` (inline styles, legacy attributes) with exact
  restore (`tidyAttr`), `checkImg`, `bgLookup` (held back with a blank image until answered), `leaveAlone`,
  `start`/`teardown` (restartable), `evaluate` (settings, system theme, printing), MutationObserver + 700 ms poll.
- `background.js` — settings (`enabledByDefault`, `followSystem`, `sites{host: bool}`, `force{host: true}`), placeholder CSS + boot
  script registration, live broadcast, image analysis (`analyze`) and recolouring (`recolour`, size-capped
  streaming fetch), `toggleSite` for the shortcut, CSP fallback.
- `popup.html/js` — four switches and a status line (asks the page via `status` message).

## Backlog
- Per-element `color-scheme: only light` subtrees.
- Source-text recovery inside `@import`ed sheets.
- Text over light video / photo backdrops; WebP/AVIF product photos of dark objects.
- In-place CSSOM edits that keep the rule count.
- Whole-shorthand overrides (`background: ...`) can beat a later page rule of equal specificity for the
  non-colour parts (repeat/size/position).
- Adopted stylesheets are overridden with forced `!important` (cascade order workaround).
- Split the single override `<style>` per source sheet so large sites re-parse less on change.
- Signed builds in GitHub Releases; possibly a listing on addons.mozilla.org.
