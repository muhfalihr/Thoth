import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ResolverRunResult,
  resolveOcrMedia,
  sanitizeResolverDetail,
} from './media_resolution.ts';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-media-resolution-'));
try {
  const localPath = path.join(tempRoot, 'video.mp4');
  fs.writeFileSync(localPath, Buffer.alloc(1));
  let localRuns = 0;
  const local = await resolveOcrMedia(localPath, {
    runResolver: async () => {
      localRuns++;
      throw new Error('must not run');
    },
  });
  assert.equal(local.status, 'resolved');
  assert.equal(local.status === 'resolved' && local.source, 'local');
  assert.equal(localRuns, 0);

  let directRuns = 0;
  const directUrl = 'https://cdn.example.test/media?id=123';
  const direct = await resolveOcrMedia(directUrl, {
    runResolver: async () => {
      directRuns++;
      throw new Error('must not run');
    },
  });
  assert.equal(direct.status, 'resolved');
  assert.equal(direct.status === 'resolved' && direct.media, directUrl);
  assert.equal(directRuns, 0);

  for (const pageUrl of [
    'https://www.instagram.com/reel/ABC123/',
    'https://www.youtube.com/watch?v=ABC123',
    'https://x.com/user/status/123',
    'https://www.facebook.com/user/videos/123',
  ]) {
    let runs = 0;
    const resolved = await resolveOcrMedia(pageUrl, {
      runResolver: async () => {
        runs++;
        return {
          exitCode: 0,
          stdout: 'https://cdn.example.test/video.mp4\n',
          stderr: '',
          timedOut: false,
        };
      },
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(runs, 1);
  }

  for (const usernamePrefixedInstagram of [
    'https://www.instagram.com/imajinari.merchandise/reel/DbUrhHZpQgk/',
    'https://www.instagram.com/someuser/p/ABC123/',
  ]) {
    let runs = 0;
    const resolved = await resolveOcrMedia(usernamePrefixedInstagram, {
      runResolver: async () => {
        runs++;
        return {
          exitCode: 0,
          stdout: 'https://cdn.example.test/video.mp4\n',
          stderr: '',
          timedOut: false,
        };
      },
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.status === 'resolved' && resolved.source, 'platform-resolver');
    assert.equal(runs, 1);
  }

  for (const specializedPage of [
    'https://www.tiktok.com/@user/video/123',
    'https://www.threads.net/@user/post/ABC',
  ]) {
    const result = await resolveOcrMedia(specializedPage);
    assert.deepEqual(
      result.status === 'unavailable'
        ? { code: result.code, reason: result.reason, attempts: result.attempts }
        : result,
      { code: 'stream_resolution_failed', reason: 'unsupported', attempts: 0 },
    );
  }

  {
    let clock = 1_000;
    const calls: number[] = [];
    const waits: number[] = [];
    const logs: string[] = [];
    const outcomes: ResolverRunResult[] = [
      { exitCode: 1, stdout: '', stderr: 'temporary extractor error', timedOut: false },
      {
        exitCode: 0,
        stdout: 'https://cdn.example.test/recovered.mp4\n',
        stderr: '',
        timedOut: false,
      },
    ];
    const result = await resolveOcrMedia('https://www.instagram.com/reel/RECOVER/', {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      log: (line) => logs.push(line),
      runResolver: async (_executable, _args, timeoutMs) => {
        calls.push(timeoutMs);
        clock += 4_000;
        return outcomes.shift()!;
      },
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.attempts, 2);
    assert.deepEqual(waits, [500]);
    assert.deepEqual(calls, [30_000, 25_500]);
    assert.deepEqual(logs, [
      '[media] resolve attempt 1/3',
      '[media] resolve attempt 2/3',
      '[media] resolved attempts=2 elapsed=8500ms',
    ]);
    assert.doesNotMatch(logs.join(' '), /instagram|cdn\.example|RECOVER/i);
  }

  {
    let clock = 10_000;
    const timeouts: number[] = [];
    const result = await resolveOcrMedia('https://x.com/user/status/999', {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      runResolver: async (_executable, _args, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += Math.min(timeoutMs, 14_000);
        return { exitCode: 1, stdout: '', stderr: 'rate limited', timedOut: false };
      },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.status === 'unavailable' && result.reason, 'extractor_exit');
    assert.deepEqual(timeouts, [30_000, 15_500]);
    assert.equal(result.attempts, 2);
    assert.equal(result.elapsed_ms, 30_000);
  }

  {
    let calls = 0;
    const diagnostics: unknown[] = [];
    const page = 'https://www.instagram.com/reel/SAME/';
    const result = await resolveOcrMedia(page, {
      sleep: async () => {},
      appendDiagnostics: (record) => diagnostics.push(record),
      runResolver: async () => {
        calls++;
        return {
          exitCode: 0,
          stdout: calls === 1 ? `${page}\n` : 'https://cdn.example.test/final.mp4\n',
          stderr: '',
          timedOut: false,
        };
      },
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.attempts, 2);
    assert.equal(diagnostics.length, 1);
    assert.equal((diagnostics[0] as any).platform, 'instagram');
    assert.doesNotMatch(JSON.stringify(diagnostics), /cdn\.example|final\.mp4/i);
  }

  {
    const result = await resolveOcrMedia('https://www.youtube.com/watch?v=SAFE', {
      runResolver: async () => ({
        exitCode: 0,
        stdout:
          'https://user:password@cdn.example.test/private.mp4\n' +
          'https://cdn.example.test/safe.mp4\n',
        stderr: '',
        timedOut: false,
      }),
    });
    assert.equal(result.status === 'resolved' && result.media, 'https://cdn.example.test/safe.mp4');
  }

  const sanitized = sanitizeResolverDetail(
    'Authorization: Bearer private-token --cookies C:\\private\\cookies.txt ' +
      'https://cdn.example.test/video.mp4?sessionid=secret',
  );
  assert.doesNotMatch(sanitized, /private-token|cookies\.txt|sessionid|https?:\/\//i);
  assert.ok(sanitized.length <= 240);

  const sanitizedSecretFragments = sanitizeResolverDetail(
    'Cookie: sessionid=cookie-secret; csrftoken=csrf-secret\n' +
      'token=token-secret api_key=key-secret /tmp/thoth/private.mp4',
  );
  assert.doesNotMatch(
    sanitizedSecretFragments,
    /cookie-secret|csrf-secret|token-secret|key-secret|private\.mp4|\/tmp\//i,
  );

  const sanitizedKeyValueSecrets = sanitizeResolverDetail(
    'authorization=secret client_secret=client password=pw auth_token=auth ' +
      "output=/var/tmp/secret.mp4 path='/tmp/private.mp4'",
  );
  assert.doesNotMatch(
    sanitizedKeyValueSecrets,
    /=secret\b|=client\b|=pw\b|=auth\b|\/var\/tmp\/|\/tmp\/private\.mp4/i,
  );

  const sanitizedBoundaryPaths = sanitizeResolverDetail(
    "quoted='/tmp/quoted.mp4' assigned=/var/tmp/assigned.mp4 " +
      'paren=(/tmp/paren.mp4 colon:/var/tmp/colon.mp4',
  );
  assert.doesNotMatch(
    sanitizedBoundaryPaths,
    /quoted\.mp4|assigned\.mp4|paren\.mp4|colon\.mp4|\/(?:var\/)?tmp\//i,
  );

  const sanitizedSpacedTempPaths = sanitizeResolverDetail(
    'win="C:\\Users\\runner\\AppData\\Local\\Temp\\private clip.mp4"\n' +
      "posix='/tmp/private clip.mp4'\n" +
      'forward="C:/Users/runner/AppData/Local/Temp/private clip.mp4"',
  );
  assert.doesNotMatch(
    sanitizedSpacedTempPaths,
    /private clip\.mp4|clip\.mp4|C:[\\/]|\/tmp\/|\/Temp\//i,
  );

  const sanitizedUnquotedSpacedTempPaths = sanitizeResolverDetail(
    'win=C:\\Users\\runner\\AppData\\Local\\Temp\\private clip.mp4\n' +
      'posix=/tmp/private clip.mp4\n' +
      'forward=C:/Users/runner/AppData/Local/Temp/private clip.mp4',
  );
  assert.doesNotMatch(
    sanitizedUnquotedSpacedTempPaths,
    /private clip\.mp4|clip\.mp4|C:[\\/]|\/tmp\/|\/Temp\//i,
  );

  const sanitizedStructuredSecrets = sanitizeResolverDetail(
    '{"client_secret":"json-client","password":"json-password","auth_token":"json-auth"} ' +
      'client_secret: colon-client --password cli-password --client-secret cli-client',
  );
  assert.doesNotMatch(
    sanitizedStructuredSecrets,
    /json-client|json-password|json-auth|colon-client|cli-password|cli-client/i,
  );

  // A known platform host serving an UNRECOGNIZED path is still an HTML page, never media. The
  // resolver used to key off a handful of path shapes (/p/, /reel/, watch?v=, /status/) and treat
  // everything else as "already a direct media url", so these went to ffprobe verbatim. ffprobe read
  // HTML and exited 1 → `duration_probe_failed`, a code build_footage does not tolerate, so one such
  // candidate killed the whole required stage.
  for (const unrecognizedPath of [
    'https://www.instagram.com/imajinari.id/',
    'https://www.instagram.com/stories/imajinari.id/3512/',
    'https://www.youtube.com/shorts/ABC123',
  ]) {
    let runs = 0;
    const resolved = await resolveOcrMedia(unrecognizedPath, {
      log: () => {},
      runResolver: async () => {
        runs++;
        return {
          exitCode: 0,
          stdout: 'https://cdn.example.test/video.mp4\n',
          stderr: '',
          timedOut: false,
        };
      },
    });
    assert.equal(runs, 1, `${unrecognizedPath} must go through yt-dlp, not straight to ffmpeg`);
    assert.equal(resolved.status === 'resolved' && resolved.source, 'platform-resolver');
  }

  // TikTok/Threads keep dedicated resolvers, so ANY url on those hosts must be rejected here —
  // including the shapes the old /video/ and /post/ path patterns missed.
  for (const specializedHost of ['https://www.tiktok.com/@user/photo/123', 'https://vt.tiktok.com/ZSABC/']) {
    const result = await resolveOcrMedia(specializedHost, { log: () => {} });
    assert.equal(result.status, 'unavailable', `${specializedHost} must not be treated as media`);
    assert.equal(result.status === 'unavailable' && result.reason, 'unsupported');
  }

  console.log('ok media_resolution');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
