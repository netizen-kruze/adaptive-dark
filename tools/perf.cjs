// Page-load cost of the extension: median load time with and without it.
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const sites = ['https://en.wikipedia.org/wiki/Firefox', 'https://stackoverflow.com/questions/11227809', 'https://news.ycombinator.com/', 'https://www.apple.com/mac/'];
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function run(addon) {
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe').addArguments('-headless', '-width=1280', '-height=900').setPreference('layout.css.prefers-color-scheme.content-override', 1);
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
  const out = {};
  try {
    if (addon) await d.installAddon(process.argv[2], true);
    for (const s of sites) {
      await d.get(s);                       // warm the cache
      const t = [];
      for (let i = 0; i < 5; i++) {
        await d.get(s);
        await new Promise(r => setTimeout(r, 1200));
        t.push(await d.executeScript("const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd);"));
      }
      out[s] = med(t);
    }
  } finally { await d.quit(); }
  return out;
}
(async () => {
  const a = await run(false), b = await run(true);
  for (const s of sites) console.log(`${s}  without=${a[s]}ms  with=${b[s]}ms  delta=${b[s] - a[s]}ms`);
})();
