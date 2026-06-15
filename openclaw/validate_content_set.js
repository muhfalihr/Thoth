// validate_content_set.js — lint a content-set BEFORE `clipper run --content`.
//
// Catches the failure modes that produce 404 / off-topic / "video ngawur" hand-offs:
//   - main.url missing or wrong URL shape per platform
//   - footage URLs with fabricated/handle-as-shortcode shapes (IG/Twitter)
//   - is_video:false entries without a real image_path on disk
//   - main.description missing (narration hallucination risk — contract: WAJIB)
//
//   node validate_content_set.js <content_set.json>
//
// Exit 0 = safe to hand off (errors=0). Exit 1 = has errors → fix before clipper run.

const fs = require('fs');
const { lintContentSet } = require('./validate');

const file = process.argv[2];
if (!file) { console.log('Usage: node validate_content_set.js <content_set.json>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('❌ File tidak ada:', file); process.exit(1); }

let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error('❌ JSON tidak valid:', e.message); process.exit(1); }

const { errors, warnings, info, ok } = lintContentSet(data);

console.log('='.repeat(60));
console.log('  Content-set lint:', file);
console.log('='.repeat(60));
if (info.length)     { console.log('\nℹ️  Info'); info.forEach(m => console.log('   - ' + m)); }
if (warnings.length) { console.log('\n⚠️  Warning (boleh lanjut, tapi cek)'); warnings.forEach(m => console.log('   - ' + m)); }
if (errors.length)   { console.log('\n❌ Error (WAJIB diperbaiki sebelum clipper run)'); errors.forEach(m => console.log('   - ' + m)); }

console.log('\n' + '-'.repeat(60));
console.log(`Result: ${ok ? '✅ PASS' : '❌ FAIL'}  (errors=${errors.length}, warnings=${warnings.length})`);
if (ok) console.log(`Aman: clipper run --content "${file}"`);
process.exit(ok ? 0 : 1);
