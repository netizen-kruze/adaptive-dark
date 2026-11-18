// Turns a sweep (with the extension) and its baseline (without) into a short list of pages
// worth a look.   node sweep-report.cjs <out-dir> [dark|light] [--all]
const fs = require('fs');
const path = require('path');
const [outDir, scheme = 'dark', all] = process.argv.slice(2);
const read = k => { try { return JSON.parse(fs.readFileSync(path.join(outDir, `sweep-${k}-${scheme}.json`), 'utf8')); } catch (e) { return []; } };
const addon = read('addon'), base = new Map(read('none').map(r => [r.name, r]));
const tally = { total: addon.length, on: 0, leftAlone: 0, blocked: 0, error: 0, flagged: 0, images: 0, inverted: 0 };
let worst = 0;
for (const r of addon) {
  if (r.error) { tally.error++; console.log(`${r.name.padEnd(15)} ERROR ${r.error.slice(0, 90)}`); continue; }
  if (r.blocked) { tally.blocked++; continue; }
  const b = base.get(r.name) || {};
  const perf = r.perf ? r.perf.split('/').map(Number) : null;
  tally.images += r.imgs; tally.inverted += r.inverted.length;
  const flags = [];
  if (r.state === 'on') {
    tally.on++;
    if (perf) worst = Math.max(worst, perf[2]);
    if (r.shot.light >= 15 || r.shot2.light >= 15) flags.push(`light ${r.shot.light}/${r.shot2.light}%`);
    if (r.lightBoxes.length) flags.push('boxes ' + r.lightBoxes.slice(0, 3).map(x => `${x.el.slice(0, 40)} ${x.bg.slice(0, 28)} ${x.area}%`).join(' | '));
    const extra = r.badCount - (b.badCount || 0);
    if (extra > 3) flags.push(`unreadable +${extra} (${r.badCount} vs ${b.badCount || 0} of ${r.textChecked}) ` + r.badText.slice(0, 3).map(t => `"${t.text}" ${t.fg} on ${t.bg} ${t.ratio} <${t.el.slice(0, 30)}>`).join(' | '));
    if (perf && (perf[2] > 150 || perf[1] > 1500)) flags.push(`slow total=${perf[1]}ms longest=${perf[2]}ms rebuilds=${perf[0]}`);
  } else {
    tally.leftAlone++;
    if (r.shot.light >= 40) flags.push(`left alone but ${r.shot.light}% light`);
  }
  if (r.console) flags.push('console ' + r.console.slice(0, 2).join(' | '));
  if (flags.length) tally.flagged++;
  if (flags.length || all) console.log(`${r.name.padEnd(15)} ${r.state}  ${flags.join('\n' + ' '.repeat(20))}`);
}
console.log('\n' + JSON.stringify(tally) + ` longestPause=${worst}ms`);
