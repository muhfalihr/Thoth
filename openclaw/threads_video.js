// threads_video.js — extract the downloadable VIDEO from a Threads post.
//
// yt-dlp can't take a threads.com PAGE url ("Unsupported URL"), BUT the post's <video> element has a
// direct Meta-CDN src (instagram.*.fbcdn.net / scontent.cdninstagram.com/*.mp4) which yt-dlp (or a
// plain fetch) CAN download. Works even when the video is nested inside an embedded/quoted post —
// querySelector('video') still finds it. Picks the largest <video> on the page (the main content).
//
//   module: const { threadsVideoSrc } = require('./threads_video');
//           await threadsVideoSrc(postUrl[, {client}])  → fbcdn mp4 URL or ''
//   CLI:    node threads_video.js <threads_post_url> [--download]
//
// ⚠️ The fbcdn URL is SIGNED & EPHEMERAL (expires in hours) — download promptly.

const fs = require('fs');
const { execSync } = require('child_process');
const { connect, sleep, run } = require('./cdp');
const { outPath } = require('./paths');

const YTDLP = process.env.YTDLP || 'yt-dlp';

// Download a (fbcdn) video URL to outFile via yt-dlp. Returns true on success. The fbcdn URL is
// ephemeral, so call this promptly after threadsVideoSrc to capture the mp4 locally.
function downloadThreads(vurl, outFile) {
  if (!vurl) return false;
  try { execSync(`"${YTDLP}" --no-warnings -o "${outFile}" "${vurl.replace(/"/g, '%22')}"`, { stdio: 'pipe', timeout: 120000 }); }
  catch (e) { return false; }
  return fs.existsSync(outFile);
}

async function threadsVideoSrc(postUrl, { client } = {}) {
  let c = client, own = false;
  if (!c) { c = await connect({ match: ['threads.com', 'threads.net'], requireMatch: true }); own = true; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    const code = (postUrl.split('/post/')[1] || '').replace(/[/?#].*$/, '');
    const cur = await c.evaluate('location.href');
    if (!cur || (code && !cur.includes(code))) await c.navigate(postUrl, 6000);
    await sleep(2500);
    // Largest <video> by rendered area = the primary content (handles nested/embedded posts).
    return (await c.evaluate(`(() => {
      const vs = Array.from(document.querySelectorAll('video'));
      if (!vs.length) return '';
      vs.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (rb.width * rb.height) - (ra.width * ra.height); });
      return vs[0].currentSrc || vs[0].src || '';
    })()`)) || '';
  } finally { if (own) c.close(); }
}

module.exports = { threadsVideoSrc, downloadThreads };

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const doDownload = args.includes('--download');
  if (!url) { console.log('Usage: node threads_video.js <threads_post_url> [--download]'); process.exit(1); }
  run(async () => {
    const src = await threadsVideoSrc(url);
    if (!src) { console.log('⚠️  tak ada <video> di post ini (mungkin post teks/foto).'); return; }
    console.log('✅ video CDN url:\n' + src);
    if (doDownload) {
      const code = (url.split('/post/')[1] || 'thr').replace(/[/?#].*$/, '');
      const out = outPath(`threads_${code}.mp4`);
      console.log('⬇️  download → ' + out);
      console.log(downloadThreads(src, out) ? '📄 ' + out : '❌ download gagal');
    }
  });
}
