// sync.js — sinkronkan module ini (source-of-truth ter-git di Thoth/openclaw) dengan runtime
// di ~/.openclaw/workspace (tempat script BENAR-BENAR dieksekusi: key file, output/, tab relay).
//
//   node sync.js push   # module → workspace  (deploy setelah edit di sini; DEFAULT)
//   node sync.js pull   # workspace → module  (tarik hotfix yang dibuat langsung di workspace)
//
// Yang disinkronkan: *.js top-level (kecuali sync.js), ig_accounts.json, deprecated/*.js.
// Yang TIDAK pernah disentuh: key file (.novita_key dll), output/, skills/, file persona (md).
// push menimpa file workspace dengan versi module — pastikan hotfix workspace sudah di-pull dulu.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODULE = __dirname;
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw', 'workspace');
const MODE = (process.argv[2] || 'push').toLowerCase();
if (!['push', 'pull'].includes(MODE)) { console.log('Usage: node sync.js [push|pull]'); process.exit(1); }
if (!fs.existsSync(WORKSPACE)) { console.log('❌ workspace tak ada:', WORKSPACE); process.exit(1); }

const SKIP = new Set(['sync.js']);
const listJs = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => (f.endsWith('.js') || f === 'ig_accounts.json') && !SKIP.has(f))
  : [];

const [srcRoot, dstRoot] = MODE === 'push' ? [MODULE, WORKSPACE] : [WORKSPACE, MODULE];
let copied = 0, same = 0;

function copyOne(src, dst) {
  const a = fs.existsSync(src) ? fs.readFileSync(src) : null;
  if (!a) return;
  const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (b && a.equals(b)) { same++; return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`  ${MODE === 'push' ? '→' : '←'} ${path.relative(MODE === 'push' ? MODULE : WORKSPACE, MODE === 'push' ? dst : src) || path.basename(dst)}`);
  copied++;
}

console.log(`sync ${MODE}: ${srcRoot}  →  ${dstRoot}`);
for (const f of listJs(srcRoot)) copyOne(path.join(srcRoot, f), path.join(dstRoot, f));
for (const f of listJs(path.join(srcRoot, 'deprecated'))) copyOne(path.join(srcRoot, 'deprecated', f), path.join(dstRoot, 'deprecated', f));
console.log(`selesai: ${copied} file disalin, ${same} identik (skip).`);
if (MODE === 'pull') console.log('Jangan lupa commit perubahan module di repo Thoth.');
