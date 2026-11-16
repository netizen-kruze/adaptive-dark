// How much main-thread work does the content script do per page? Uses a temp copy of the
// extension with PERF_ATTR switched on. Usage: node perf-work.cjs <ext-dir> [url ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const src = path.resolve(process.argv[2]);
const urls = process.argv.slice(3).length ? process.argv.slice(3) : ['https://stackoverflow.com/questions/11227809', 'https://www.usa.gov/', 'https://www.nytimes.com/', 'https://en.wikipedia.org/wiki/Firefox', 'https://www.apple.com/mac/', 'https://sfbay.craigslist.org/', 'https://news.ycombinator.com/'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-perf-'));
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
const cj = path.join(tmp, 'content.js');
const code = fs.readFileSync(cj, 'utf8');
if (!code.includes('const PERF_ATTR = false;')) throw new Error('PERF_ATTR flag not found');
fs.writeFileSync(cj, code.replace('const PERF_ATTR = false;', 'const PERF_ATTR = true;'));
(async () => {
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe').addArguments('-headless', '-width=1280', '-height=900').setPreference('layout.css.prefers-color-scheme.content-override', 1);
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
  let worst = 0;
  try {
    await d.installAddon(tmp, true);
    for (const u of urls) {
      await d.get(u);
      await new Promise(r => setTimeout(r, 6000));
      const a = await d.executeScript("return document.documentElement.getAttribute('data-adm-perf')");
      if (!a) { console.log(`${u.padEnd(48)} (not darkened)`); continue; }
      const [n, ms, max, css] = a.split('/').map(Number);
      worst = Math.max(worst, max);
      console.log(`${u.padEnd(48)} rebuilds=${String(n).padStart(3)}  total=${String(ms).padStart(5)}ms  longest=${String(max).padStart(4)}ms  css=${Math.round(css / 1024)}KB`);
    }
  } finally { await d.quit(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('longest single pause: ' + worst + 'ms');
})();
