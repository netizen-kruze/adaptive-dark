// Runs sweep.cjs over a long site list in several browsers at once.
//   node sweep-shards.cjs <extension-dir|none> <out-dir> <shards> <sites.json> [more-sites.json ...]
// Env INNER / QUIET are passed through. Each shard writes to <out-dir>/sN; the merged results
// (sweep-<addon|none>-dark.json and, with INNER, pages.json) land in <out-dir>.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const [ext, outDir, nArg, ...files] = process.argv.slice(2);
const n = Math.max(1, +nArg || 1);
const sites = files.flatMap(f => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8').replace(/^﻿/, '')));
const tag = `${ext === 'none' ? 'none' : 'addon'}-dark`;
fs.mkdirSync(outDir, { recursive: true });
// A site and its inner pages ("name~1") stay in the same shard.
const groups = [];
for (const s of sites) { if (s[0].includes('~') && groups.length) groups[groups.length - 1].push(s); else groups.push([s]); }
const shards = Array.from({ length: n }, () => []);
groups.forEach((g, i) => shards[i % n].push(...g));
let left = n;
shards.forEach((list, i) => {
  const dir = path.join(outDir, 's' + i);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sites.json');
  fs.writeFileSync(file, JSON.stringify(list));
  const child = spawn(process.execPath, [path.join(__dirname, 'sweep.cjs'), ext, dir, file, 'dark'], { env: Object.assign({}, process.env, { QUIET: '1' }), stdio: 'ignore' });
  child.on('exit', () => {
    if (--left) return;
    const order = new Map(sites.map((s, k) => [s[0].split('~')[0], k]));
    const key = name => (order.has(name.split('~')[0]) ? order.get(name.split('~')[0]) : 1e9) * 10 + (+name.split('~')[1] || 0);
    const merge = f => shards.flatMap((_, k) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, 's' + k, f), 'utf8')); } catch (e) { return []; } });
    const res = merge(`sweep-${tag}.json`).sort((a, b) => key(a.name) - key(b.name));
    fs.writeFileSync(path.join(outDir, `sweep-${tag}.json`), JSON.stringify(res, null, 1));
    if (process.env.INNER) fs.writeFileSync(path.join(outDir, 'pages.json'), JSON.stringify(merge('pages.json').sort((a, b) => key(a[0]) - key(b[0]))));
    for (const k of shards.keys()) { const src = path.join(outDir, 's' + k, 'shots'); if (fs.existsSync(src)) { fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true }); for (const f of fs.readdirSync(src)) fs.renameSync(path.join(src, f), path.join(outDir, 'shots', f)); } }
    console.log(`done: ${res.length} pages, ${res.filter(r => r.frozen).length} frozen, ${res.filter(r => r.blocked).length} blocked, ${res.filter(r => r.error && !r.frozen).length} errors`);
  });
});
