# Adaptive Dark

A Firefox extension that darkens websites which only have a light design, modelled on Safari 27.3's
[Adaptive Dark Mode](https://webkit.org/blog/18541/introducing-adaptive-dark-mode/).
Sites that are already dark, or that say they handle dark mode themselves, are left alone.

It is not affiliated with Apple or Mozilla. It collects no data and sends nothing anywhere: all work happens
inside your browser.

**Status: early (v0.4.0).** It has automated tests and has been checked on about twenty well-known sites, but
then swept across about 150 more (see Development). Expect some sites to look wrong; the per-site switches are there for that, and bug reports
with a URL are welcome.

## How it differs from a filter-based dark mode

- **Colours are remapped, not inverted.** Every colour in every stylesheet is remapped by lightness (OKLCH),
  keeping its hue. Light backgrounds become dark, dark text becomes light, borders and shadows are toned to
  match. Any text/background pair that met the WCAG 4.5:1 contrast ratio before still meets it afterwards
  (this is tested).
- **It backs off.** Pages that declare `color-scheme: light dark`, `dark` or `only light`, and pages that are
  already dark, are not touched. "Already dark" is judged by what is on screen, not just the page's base colour.
- **Photos stay photos.** Black-on-white line art, dark logos and icons are lightened (`<img>`, SVG `<image>`
  and CSS background images); light textures are darkened; photos, `<canvas>` and video are left alone.
- **No white flash.** A dark placeholder is shown from the first instant and the page's own colours are
  overridden before they can be painted.
- **Clean undo.** Switching it off restores the page exactly, without a reload. Printing uses the page's
  original colours.

Also handled: CSS variables, gradients, `@keyframes`, shadow DOM, iframes, inline styles, masked icons,
`mix-blend-mode: multiply`, and 1990s attributes (`bgcolor`, `text`, `link`, `background`).

## Install

There is no signed release yet, so for now it loads as a temporary add-on (removed when Firefox closes):

1. Download or clone this repository.
2. In Firefox open `about:debugging#/runtime/this-firefox` and choose **Load Temporary Add-on...**
3. Pick `extension/manifest.json`.
4. Disable Dark Reader or similar extensions while using it; they will fight.

Requires Firefox 142 or later.

## Use

The toolbar button opens four switches:

- **Darken this site**: per-site on/off. The line under it says what is happening on the current page
  ("Darkening this page", "Left alone: this page looks dark already", ...).
- **Force dark on this site**: darken it even if it looks dark already or says it has its own dark design.
- **Darken every site**: on means all sites unless switched off; off means only the sites you switch on.
- **Follow light / dark mode**: darken only while Windows or Firefox is set to dark (how Safari behaves).

Changes apply immediately. **Alt+Shift+D** toggles the current site (change the key in `about:addons` ->
gear icon -> Manage Extension Shortcuts).

## Known limits

- `only light` is honoured for the whole page, not for individual elements inside a page.
- Text placed over a light video or a detailed light photo can become hard to read: videos and photos are left as
  they are while the text on top of them is lightened.
- JPEG images are treated as photos and never inverted, so a black-on-white diagram saved as a JPEG stays white.
- Rules edited in place by scripts, without adding or removing rules, are picked up only after another change.
- Pages can detect the extension (it adds a `data-adm` attribute and a `<style>` element).
- Firefox does not let any extension run on `about:` pages, addons.mozilla.org, or its PDF viewer.

## Permissions

`<all_urls>` and `tabs` are needed to restyle pages and to know which site the toolbar panel is showing.
`storage` holds your settings locally. Stylesheets and small images are re-fetched by the extension so it can read colours the page's own security rules hide from scripts; nothing is uploaded.

## Development

    cd tools
    npm install
    npm test          # unit tests + end-to-end checks in real Firefox (headless) + lint
    npm run sites     # loads real websites and reports state and console errors
    npm run sweep     # ~150 real sites: leftover light areas, unreadable text, inverted images, slow pages, errors
    npm run flash     # Windows only: visible Firefox, samples real screen pixels for white flashes
    npm run build     # zip in dist/

The tests assume Firefox at `C:/Program Files/Mozilla Firefox/firefox.exe`; set `FIREFOX_BIN` otherwise.
[DEVELOPMENT.md](DEVELOPMENT.md) has the architecture, test status, and Firefox behaviours worth knowing.

## Licence

[MIT](LICENSE)
