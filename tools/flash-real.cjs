// Real-screen white-flash test: a VISIBLE Firefox window navigates while capture.ps1 samples
// actual screen pixels inside it. Usage: node flash-real.cjs <ext-dir|none> <dark|light>
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { start } = require('./server.cjs');
const [ext, scheme] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = 8731, B = 8732, L = `http://127.0.0.1:${A}`;
const targets = [L + '/basic.html', 'https://news.ycombinator.com/', 'https://en.wikipedia.org/wiki/Firefox', L + '/slowcss.html', 'https://www.apple.com/mac/', 'https://paulgraham.com/articles.html', L + '/basic.html', 'https://news.ycombinator.com/news?p=2', 'https://en.wikipedia.org/wiki/Mozilla'];

(async () => {
  const srv = await start(A, B);
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe')
    .setPreference('layout.css.prefers-color-scheme.content-override', scheme === 'light' ? 1 : 0);
  if (scheme !== 'light') opts.setPreference('ui.systemUsesDarkTheme', 1);
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
  const marks = [];
  const out = path.join(__dirname, 'out', `flash-real-${ext === 'none' ? 'baseline' : 'addon'}-${scheme}.csv`);
  try {
    if (ext !== 'none') await d.installAddon(path.resolve(ext), true);
    await d.manage().window().setRect({ x: 80, y: 60, width: 1000, height: 760 });
    await d.get(L + '/basic.html'); await sleep(2500);
    const cap = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture.ps1'), '-X', '520', '-Y', '560', '-Seconds', String(targets.length * 4 + 3), '-Out', out], { stdio: 'ignore' });
    await sleep(1200);
    for (const u of targets) { marks.push({ u, t: Date.now() }); await d.get(u).catch(() => {}); const left = 3800 - (Date.now() - marks[marks.length - 1].t); if (left > 0) await sleep(left); }
    await new Promise(r => cap.on('exit', r));
  } finally { await d.quit().catch(() => {}); srv.close(); }
  const rows = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).map(l => l.split(',').map(Number));
  console.log(`${ext === 'none' ? 'BASELINE (no extension)' : 'WITH EXTENSION'}, appearance ${scheme}: ${rows.length} samples, ${(rows.length / ((rows[rows.length - 1][0] - rows[0][0]) / 1000)).toFixed(0)} per second`);
  let worstAll = 0;
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].t : m.t + 3800;
    const seg = rows.filter(r => r[0] >= m.t && r[0] < end);
    const bright = seg.filter(r => (r[1] + r[2] + r[3]) / 3 > 150);
    let last = '', parts = [];
    for (const r of seg) { const v = Math.round((r[1] + r[2] + r[3]) / 3); const k = v > 150 ? 'LIGHT' : v > 70 ? 'mid' : 'dark'; if (k !== last) { parts.push(`${r[0] - m.t}ms ${k}(${v})`); last = k; } }
    worstAll = Math.max(worstAll, bright.length);
    console.log(`  ${m.u.replace(/^https?:\/\//, '').slice(0, 40).padEnd(40)} light samples: ${String(bright.length).padStart(3)}/${seg.length}   ${parts.join(' > ')}`);
  });
  console.log(worstAll ? '  => light frames were seen on screen' : '  => no light frame reached the screen');
})();
