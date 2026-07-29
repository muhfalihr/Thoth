# Platform-Page OCR Stream Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every supported social-platform page into usable media before required OCR, with typed failures, bounded retry, and no page-URL fallback into FFprobe.

**Architecture:** Add a focused `media_resolution` module that classifies inputs, runs yt-dlp under one shared 30-second deadline, validates direct-stream output, and returns a discriminated result. Integrate that boundary into `attachVideoOcr`, retain TikTok/Threads special handling, then make duration probing and optional-candidate failure policy preserve the true failure class.

**Tech Stack:** Bun, TypeScript, Node.js `child_process`, yt-dlp, FFprobe/FFmpeg, Node `assert`.

## Global Constraints

- Supported Instagram, YouTube, X/Twitter, and Facebook page URLs must never reach FFprobe or FFmpeg.
- TikTok keeps its existing local-download OCR path.
- Threads keeps its existing extracted-video-source path.
- Resolution uses at most three attempts under one total 30-second deadline.
- Retry backoffs are exactly 500 ms and 1500 ms.
- No attempt starts after the shared deadline expires.
- Final-main `stream_resolution_failed` remains fatal.
- Optional unavailable candidates are dropped without consuming quota.
- `duration_probe_failed` is reserved for media that already passed resolution.
- Diagnostics never contain signed CDN URLs, URL queries, cookies, authorization values, tokens, or local temporary paths.
- No new runtime dependency is permitted.

---

### Task 1: Build the Typed, Deadline-Bounded Media Resolver

**Files:**
- Create: `scout/lib/media_resolution.ts`
- Create: `scout/lib/media_resolution.test.ts`
- Read/Reuse: `scout/lib/verify.ts:163-207`
- Read/Reuse: `scout/lib/paths.ts`

**Interfaces:**
- Consumes: `directStreamArgs(pageUrl: string, maxSlides?: number): string[]` from `scout/lib/verify.ts`.
- Produces: `resolveOcrMedia(input: string, deps?: ResolveOcrMediaDeps): Promise<MediaResolutionResult>`.
- Produces: `MediaResolutionResult`, `ResolvedMedia`, `UnavailableMedia`, `ResolverRunResult`, and `sanitizeResolverDetail`.

- [ ] **Step 1: Write failing classification and pass-through tests**

Create `scout/lib/media_resolution.test.ts` with these initial assertions:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveOcrMedia,
  sanitizeResolverDetail,
  type ResolverRunResult,
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
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
```

- [ ] **Step 2: Write failing retry and shared-deadline tests**

Append deterministic fake-clock cases:

```ts
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
```

- [ ] **Step 3: Write failing output-validation and sanitization tests**

Append:

```ts
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
  const result = await resolveOcrMedia(
    'https://www.youtube.com/watch?v=SAFE',
    {
      runResolver: async () => ({
        exitCode: 0,
        stdout:
          'https://user:password@cdn.example.test/private.mp4\n' +
          'https://cdn.example.test/safe.mp4\n',
        stderr: '',
        timedOut: false,
      }),
    },
  );
  assert.equal(
    result.status === 'resolved' && result.media,
    'https://cdn.example.test/safe.mp4',
  );
}

const sanitized = sanitizeResolverDetail(
  'Authorization: Bearer private-token --cookies C:\\private\\cookies.txt ' +
    'https://cdn.example.test/video.mp4?sessionid=secret',
);
assert.doesNotMatch(sanitized, /private-token|cookies\.txt|sessionid|https?:\/\//i);
assert.ok(sanitized.length <= 240);

console.log('ok media_resolution');
```

- [ ] **Step 4: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/media_resolution.test.ts
```

Expected: FAIL because `scout/lib/media_resolution.ts` does not exist.

- [ ] **Step 5: Implement the public contract and classifiers**

Create `scout/lib/media_resolution.ts` with these exported types and constants:

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { outPath } from './paths.ts';
import { directStreamArgs } from './verify.ts';

export const MEDIA_RESOLUTION_DEADLINE_MS = 30_000;
export const MEDIA_RESOLUTION_MAX_ATTEMPTS = 3;
export const MEDIA_RESOLUTION_BACKOFF_MS = [500, 1_500] as const;

export type MediaResolutionSource = 'local' | 'direct' | 'platform-resolver';
export type StreamResolutionReason =
  | 'timeout'
  | 'extractor_exit'
  | 'no_stream'
  | 'unsupported';

export type ResolvedMedia = {
  status: 'resolved';
  media: string;
  source: MediaResolutionSource;
  attempts: number;
  elapsed_ms: number;
};

export type UnavailableMedia = {
  status: 'unavailable';
  code: 'stream_resolution_failed';
  reason: StreamResolutionReason;
  attempts: number;
  elapsed_ms: number;
  safe_exit_code?: number;
  safe_detail?: string;
};

export type MediaResolutionResult = ResolvedMedia | UnavailableMedia;

export type ResolverRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ResolveOcrMediaDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  runResolver?: (
    executable: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<ResolverRunResult>;
  env?: Record<string, string | undefined>;
  appendDiagnostics?: (record: unknown) => void;
  log?: (line: string) => void;
};

const PLATFORM_PAGE_PATTERNS = [
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\//i,
  /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/)/i,
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\//i,
  /^https?:\/\/(?:www\.|web\.)?facebook\.com\/.+/i,
] as const;

const SPECIALIZED_PAGE_PATTERNS = [
  /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\//i,
  /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^/]+\/post\//i,
] as const;

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
```

- [ ] **Step 6: Implement process execution, sanitization, and result validation**

Add:

```ts
function defaultRunResolver(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ResolverRunResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: Math.max(1, timeoutMs), maxBuffer: 1 << 24, windowsHide: true },
      (error, stdout, stderr) => {
        const childError = error as (Error & {
          code?: string | number;
          killed?: boolean;
        }) | null;
        resolve({
          exitCode:
            typeof childError?.code === 'number'
              ? childError.code
              : childError
                ? 1
                : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut:
            childError?.code === 'ETIMEDOUT' ||
            (childError?.killed === true && /timed out/i.test(childError.message)),
        });
      },
    );
  });
}

export function sanitizeResolverDetail(value: string): string {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/gi, 'Authorization: [redacted]')
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/--cookies(?:-from-browser)?\s+\S+/gi, '--cookies [redacted]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function appendMediaResolutionDiagnostic(
  input: string,
  record: Record<string, unknown>,
): void {
  const sourceId = createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, 16);
  try {
    fs.appendFileSync(
      outPath('media_resolution_debug.jsonl'),
      `${JSON.stringify({
        source_id: sourceId,
        platform: platformForInput(input),
        ...record,
      })}\n`,
      'utf8',
    );
  } catch {}
}

function platformForInput(input: string): string {
  if (/instagram\.com/i.test(input)) return 'instagram';
  if (/(?:youtube\.com|youtu\.be)/i.test(input)) return 'youtube';
  if (/(?:x|twitter)\.com/i.test(input)) return 'twitter';
  if (/facebook\.com/i.test(input)) return 'facebook';
  return 'direct';
}

function directStreamFromOutput(stdout: string, input: string): string {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      if (
        !/^https?:\/\//i.test(line) ||
        line === input ||
        matchesAny(line, PLATFORM_PAGE_PATTERNS) ||
        matchesAny(line, SPECIALIZED_PAGE_PATTERNS)
      ) {
        return false;
      }
      try {
        const parsed = new URL(line);
        return !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }) || '';
}
```

- [ ] **Step 7: Implement the shared-deadline retry loop**

Add the exported operation:

```ts
export async function resolveOcrMedia(
  input: string,
  deps: ResolveOcrMediaDeps = {},
): Promise<MediaResolutionResult> {
  const value = String(input || '').trim();
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runResolver = deps.runResolver ?? defaultRunResolver;
  const log = deps.log ?? ((line: string) => console.log(line));
  const started = now();
  const writeDiagnostics =
    deps.appendDiagnostics ??
    ((record: unknown) =>
      appendMediaResolutionDiagnostic(
        value,
        record as Record<string, unknown>,
      ));
  const emitDiagnostic = (record: Record<string, unknown>) =>
    writeDiagnostics({
      platform: platformForInput(value),
      ...record,
    });

  if (value && fs.existsSync(value)) {
    return { status: 'resolved', media: value, source: 'local', attempts: 0, elapsed_ms: 0 };
  }
  if (!/^https?:\/\//i.test(value) || matchesAny(value, SPECIALIZED_PAGE_PATTERNS)) {
    return {
      status: 'unavailable',
      code: 'stream_resolution_failed',
      reason: 'unsupported',
      attempts: 0,
      elapsed_ms: Math.max(0, now() - started),
    };
  }
  if (!matchesAny(value, PLATFORM_PAGE_PATTERNS)) {
    return { status: 'resolved', media: value, source: 'direct', attempts: 0, elapsed_ms: 0 };
  }

  const deadline = started + MEDIA_RESOLUTION_DEADLINE_MS;
  const executable = deps.env?.YTDLP || process.env.YTDLP || 'yt-dlp';
  let attempts = 0;
  let reason: StreamResolutionReason = 'no_stream';
  let safeExitCode: number | undefined;
  let safeDetail = '';

  while (attempts < MEDIA_RESOLUTION_MAX_ATTEMPTS && now() < deadline) {
    const remaining = Math.max(0, deadline - now());
    if (remaining <= 0) break;
    attempts++;
    log(`[media] resolve attempt ${attempts}/${MEDIA_RESOLUTION_MAX_ATTEMPTS}`);
    const run = await runResolver(executable, directStreamArgs(value), remaining);
    safeExitCode = run.exitCode;
    safeDetail = sanitizeResolverDetail(run.stderr);
    const media = run.exitCode === 0 ? directStreamFromOutput(run.stdout, value) : '';
    if (media) {
      const result: ResolvedMedia = {
        status: 'resolved',
        media,
        source: 'platform-resolver',
        attempts,
        elapsed_ms: Math.min(MEDIA_RESOLUTION_DEADLINE_MS, Math.max(0, now() - started)),
      };
      emitDiagnostic({ ...result, media: undefined });
      log(
        `[media] resolved attempts=${attempts} elapsed=${result.elapsed_ms}ms`,
      );
      return result;
    }
    reason = run.timedOut ? 'timeout' : run.exitCode !== 0 ? 'extractor_exit' : 'no_stream';
    const backoff = MEDIA_RESOLUTION_BACKOFF_MS[attempts - 1];
    if (backoff === undefined) break;
    const sleepMs = Math.min(backoff, Math.max(0, deadline - now()));
    if (sleepMs > 0) await wait(sleepMs);
  }

  const result: UnavailableMedia = {
    status: 'unavailable',
    code: 'stream_resolution_failed',
    reason: now() >= deadline ? 'timeout' : reason,
    attempts,
    elapsed_ms: Math.min(MEDIA_RESOLUTION_DEADLINE_MS, Math.max(0, now() - started)),
    ...(safeExitCode !== undefined ? { safe_exit_code: safeExitCode } : {}),
    ...(safeDetail ? { safe_detail: safeDetail } : {}),
  };
  emitDiagnostic(result);
  log(
    `[media] unavailable reason=${result.reason} attempts=${attempts} elapsed=${result.elapsed_ms}ms`,
  );
  return result;
}
```

- [ ] **Step 8: Run focused tests and confirm GREEN**

Run:

```powershell
rtk proxy bun scout/lib/media_resolution.test.ts
```

Expected: prints `ok media_resolution` and exits zero.

- [ ] **Step 9: Run formatting and type validation**

Run:

```powershell
rtk proxy bunx biome check scout/lib/media_resolution.ts scout/lib/media_resolution.test.ts
rtk proxy bun run typecheck
```

Run the typecheck from `scout/`. Expected: both commands exit zero.

- [ ] **Step 10: Commit the resolver module**

```powershell
rtk git add -- scout/lib/media_resolution.ts scout/lib/media_resolution.test.ts
rtk git commit -m "feat(scout): add bounded OCR media resolver"
```

---

### Task 2: Enforce Typed Resolution Before Required OCR

**Files:**
- Modify: `scout/lib/ocr_content.ts:1-135`
- Modify: `scout/lib/ocr_content.test.ts:1-320`
- Test: `scout/lib/media_resolution.test.ts`

**Interfaces:**
- Consumes: `resolveOcrMedia(input, deps): Promise<MediaResolutionResult>`.
- Produces: `AttachVideoOcrDeps.resolve?: (source: string) => MediaResolutionResult | Promise<MediaResolutionResult>`.
- Produces: `OcrAnalysisError` code `stream_resolution_failed` before analysis begins.

- [ ] **Step 1: Replace string-resolver fixtures with typed-result fixtures**

In `scout/lib/ocr_content.test.ts`, change the successful resolver fixture to:

```ts
resolve: async () => ({
  status: 'resolved' as const,
  media: 'C:/local/video.mp4',
  source: 'local' as const,
  attempts: 0,
  elapsed_ms: 0,
}),
```

Change TikTok resolver fixtures to throw if invoked:

```ts
resolve: async () => {
  resolveCalls++;
  throw new Error('TikTok must use the localizer');
},
```

- [ ] **Step 2: Add failing fail-before-analysis tests**

Add:

```ts
{
  let analyzeCalls = 0;
  await assert.rejects(
    () =>
      attachVideoOcr(
        {
          url: 'https://www.instagram.com/reel/FAILED/',
          is_video: true as const,
        },
        {
          resolve: async () => ({
            status: 'unavailable' as const,
            code: 'stream_resolution_failed' as const,
            reason: 'timeout' as const,
            attempts: 3,
            elapsed_ms: 30_000,
          }),
          analyze: async () => {
            analyzeCalls++;
            return analyzed;
          },
        },
      ),
    (error: unknown) =>
      error instanceof OcrAnalysisError &&
      error.code === 'stream_resolution_failed' &&
      !error.message.includes('instagram.com'),
  );
  assert.equal(analyzeCalls, 0);
}

{
  let resolvedSource = '';
  await attachVideoOcr(
    { url: 'https://www.youtube.com/watch?v=123', is_video: true as const },
    {
      resolve: async () => ({
        status: 'resolved' as const,
        media: 'https://cdn.example.test/video.mp4',
        source: 'platform-resolver' as const,
        attempts: 2,
        elapsed_ms: 4_500,
      }),
      analyze: async (source) => {
        resolvedSource = source;
        return analyzed;
      },
    },
  );
  assert.equal(resolvedSource, 'https://cdn.example.test/video.mp4');
}
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/ocr_content.test.ts
```

Expected: FAIL because `AttachVideoOcrDeps.resolve` still returns a string and
unavailable results are passed incorrectly.

- [ ] **Step 4: Integrate `resolveOcrMedia` into `attachVideoOcr`**

Replace the `directStreamUrl` import with:

```ts
import {
  type MediaResolutionResult,
  resolveOcrMedia,
} from './media_resolution.ts';
```

Change the dependency type:

```ts
type AttachVideoOcrDeps = {
  resolve?: (
    source: string,
  ) => MediaResolutionResult | Promise<MediaResolutionResult>;
  analyze?: (source: string) => Promise<OcrAnalysis>;
  project?: (analysis: AnalyzedOcrAnalysis) => PersistedOcrFields;
  env?: OcrEnvironment;
  ocrTempRoot?: string;
  downloadTikTok?: (source: string, output: string) => Promise<string>;
};
```

Replace the non-TikTok resolution branch with:

```ts
const resolution = await (
  deps.resolve ??
  ((value: string) => resolveOcrMedia(value, { env: deps.env }))
)(source);
if (resolution.status === 'unavailable') {
  throw new OcrAnalysisError(
    'stream_resolution_failed',
    'OCR media stream could not be resolved safely',
  );
}
resolved = resolution.media;
```

Do not change the TikTok local-file branch.

- [ ] **Step 5: Run OCR-content and resolver tests**

Run:

```powershell
rtk proxy bun scout/lib/media_resolution.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
```

Expected: both scripts exit zero.

- [ ] **Step 6: Run OCR regressions and typecheck**

Run:

```powershell
rtk proxy bun scout/lib/subtitle_vision.test.ts
rtk proxy bun scout/pipeline/ocr_local.test.ts
rtk proxy bun run typecheck
```

Run the typecheck from `scout/`. Expected: all commands exit zero.

- [ ] **Step 7: Commit required-OCR integration**

```powershell
rtk git add -- scout/lib/ocr_content.ts scout/lib/ocr_content.test.ts
rtk git commit -m "fix(scout): require resolved media before OCR"
```

---

### Task 3: Preserve Typed FFprobe Failure Diagnostics

**Files:**
- Modify: `scout/lib/subtitle_vision.ts:32-40`
- Modify: `scout/lib/subtitle_vision.ts:594-626`
- Modify: `scout/lib/subtitle_vision.ts:661-718`
- Modify: `scout/lib/subtitle_vision.ts:798-814`
- Modify: `scout/lib/subtitle_vision.test.ts:97-126`

**Interfaces:**
- Produces: `DurationProbeResult`.
- Changes: `OcrAnalysisDeps.probeDuration?: (video: string) => DurationProbeResult`.
- Preserves: public OCR error codes `ffprobe_missing` and `duration_probe_failed`.

- [ ] **Step 1: Add failing typed-probe diagnostics tests**

Replace the numeric `probeDuration: () => 0` fixture and add diagnostic capture:

```ts
let durationDiagnostic: any;
const noDuration = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
  env: { THOTH_NOVITA_API_KEY: 'test' },
  probeDuration: () => ({
    status: 'failed',
    code: 'duration_probe_failed',
    reason: 'process_exit',
    safe_exit_code: 1,
  }),
  appendDiagnostics: (record) => {
    durationDiagnostic = record;
  },
});
assert.equal(noDuration.ocr_status, 'failed');
assert.equal(noDuration.error_code, 'duration_probe_failed');
assert.equal(durationDiagnostic.probe_reason, 'process_exit');
assert.equal(durationDiagnostic.probe_exit_code, 1);
```

Add invalid-output coverage:

```ts
let invalidDiagnostic: any;
const invalidOutput = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
  env: { THOTH_NOVITA_API_KEY: 'test' },
  probeDuration: () => ({
    status: 'failed',
    code: 'duration_probe_failed',
    reason: 'invalid_output',
  }),
  appendDiagnostics: (record) => {
    invalidDiagnostic = record;
  },
});
assert.equal(invalidOutput.error_code, 'duration_probe_failed');
assert.equal(invalidDiagnostic.probe_reason, 'invalid_output');
```

- [ ] **Step 2: Run subtitle tests and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/subtitle_vision.test.ts
```

Expected: FAIL because `probeDuration` still expects a number.

- [ ] **Step 3: Add the typed duration contract**

Add near `OcrAnalysisDeps`:

```ts
export type DurationProbeResult =
  | { status: 'ok'; duration: number }
  | {
      status: 'failed';
      code: 'ffprobe_missing' | 'duration_probe_failed';
      reason: 'missing_binary' | 'timeout' | 'process_exit' | 'invalid_output';
      safe_exit_code?: number;
    };
```

Change the dependency:

```ts
probeDuration?: (video: string) => DurationProbeResult;
```

- [ ] **Step 4: Replace the numeric sentinel probe**

Replace `FFPROBE_MISSING` and `probeDuration` with:

```ts
function probeDuration(
  videoUrl: string,
  env: Record<string, string | undefined>,
): DurationProbeResult {
  const ffmpeg = env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const ffprobe = env.THOTH_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  try {
    const raw = execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoUrl,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
    );
    const duration = parseDuration(raw);
    return duration > 0
      ? { status: 'ok', duration }
      : {
          status: 'failed',
          code: 'duration_probe_failed',
          reason: 'invalid_output',
        };
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & {
      status?: number;
      killed?: boolean;
    };
    if (processError.code === 'ENOENT') {
      return {
        status: 'failed',
        code: 'ffprobe_missing',
        reason: 'missing_binary',
      };
    }
    return {
      status: 'failed',
      code: 'duration_probe_failed',
      reason:
        processError.code === 'ETIMEDOUT' || processError.killed
          ? 'timeout'
          : 'process_exit',
      ...(typeof processError.status === 'number'
        ? { safe_exit_code: processError.status }
        : {}),
    };
  }
}
```

- [ ] **Step 5: Thread safe probe metadata into failed diagnostics**

Add an optional `diagnostic` parameter to `appendAnalysisDiagnostics` and
`failedAnalysis`:

```ts
type FailureDiagnostic = {
  probe_reason?: 'missing_binary' | 'timeout' | 'process_exit' | 'invalid_output';
  probe_exit_code?: number;
};
```

Add `diagnostic: FailureDiagnostic = {}` as the last parameter of both
`appendAnalysisDiagnostics` and `failedAnalysis`. Forward it from
`failedAnalysis`:

```ts
appendAnalysisDiagnostics(
  videoUrl,
  duration,
  result,
  frames,
  writeDiagnostics,
  retryCounts,
  diagnostic,
);
```

Use the concrete call shape:

```ts
const probe = duration > 0
  ? ({ status: 'ok', duration } as const)
  : (deps.probeDuration ?? ((video) => probeDuration(video, env)))(videoUrl);
if (probe.status === 'failed') {
  return failedAnalysis(
    videoUrl,
    duration,
    model,
    analyzedAt,
    probe.code,
    0,
    0,
    [],
    writeDiagnostics,
    { configured: retryCount, actual: 0 },
    {
      probe_reason: probe.reason,
      ...(probe.safe_exit_code !== undefined
        ? { probe_exit_code: probe.safe_exit_code }
        : {}),
    },
  );
}
const resolvedDuration = probe.duration;
```

At the end of the existing diagnostic object in `appendAnalysisDiagnostics`,
spread only these safe scalar fields:

```ts
const samples = frames.map(({ t, requested_t, boxes, error }, index) => ({
  t,
  ...(requested_t !== undefined ? { requested_t } : {}),
  boxes,
  headline_boxes: classified[index].headline_boxes,
  subtitle_boxes: classified[index].subtitle_boxes,
  ...(error ? { error } : {}),
}));

writeDiagnostics({
  schema_version: analysis.schema_version,
  ocr_status: analysis.ocr_status,
  provider: analysis.provider,
  model: analysis.model,
  analyzer_version: analysis.analyzer_version,
  analyzed_at: analysis.analyzed_at,
  video_id: hashVideoId(videoUrl),
  duration,
  requested_frames: analysis.requested_frames,
  valid_frames: analysis.valid_frames,
  configured_retry_count: retryCounts.configured,
  actual_retry_count: retryCounts.actual,
  samples,
  ...(analysis.verdict ? { verdict: analysis.verdict } : {}),
  ...(analysis.error_code
    ? {
        error_code: analysis.error_code,
        error_message: analysis.error_message,
      }
    : {}),
  ...diagnostic,
});
```

- [ ] **Step 6: Run focused and regression tests**

Run:

```powershell
rtk proxy bun scout/lib/subtitle_vision.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
rtk proxy bun scout/pipeline/ocr_local.test.ts
```

Expected: every script exits zero.

- [ ] **Step 7: Run typecheck and formatting**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib/subtitle_vision.ts lib/subtitle_vision.test.ts
```

Run both commands from `scout/`. Expected: exit zero.

- [ ] **Step 8: Commit typed FFprobe diagnostics**

```powershell
rtk git add -- scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
rtk git commit -m "fix(scout): preserve duration probe failure reasons"
```

---

### Task 4: Isolate Stream Failures for Optional Candidates

**Files:**
- Modify: `scout/lib/footage_candidate_ocr.ts:12-37`
- Modify: `scout/lib/footage_candidate_ocr.test.ts:1-80`
- Modify: `scout/pipeline/trace_source.ts:791-824`
- Test: `scout/lib/footage_candidate_selection.test.ts`

**Interfaces:**
- Consumes: `OcrAnalysisError.code`.
- Changes: `attachFootageOcrCandidate` maps both `media_access_failed` and `stream_resolution_failed` to `{ status: 'unavailable'; code: 'media_access_failed' }`.
- Produces: main-search OCR loop containing only successfully analyzed candidates.

- [ ] **Step 1: Add failing optional stream-failure coverage**

In `scout/lib/footage_candidate_ocr.test.ts`, replace the single unavailable
case with:

```ts
for (const code of ['media_access_failed', 'stream_resolution_failed'] as const) {
  const unavailable = await attachFootageOcrCandidate(record, async () => {
    throw new OcrAnalysisError(code, 'safe');
  });
  assert.deepEqual(unavailable, {
    status: 'unavailable',
    code: 'media_access_failed',
  });
}
```

Keep `missing_api_key`, `incomplete_frame_coverage`, and ordinary exceptions as
fatal assertions.

- [ ] **Step 2: Run the candidate test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/footage_candidate_ocr.test.ts
```

Expected: FAIL because `stream_resolution_failed` is rethrown.

- [ ] **Step 3: Expand only the candidate-local media classification**

Change the catch condition:

```ts
if (
  error instanceof OcrAnalysisError &&
  ['media_access_failed', 'stream_resolution_failed'].includes(error.code)
) {
  return { status: 'unavailable', code: 'media_access_failed' };
}
```

Do not add OCR provider, configuration, parsing, or coverage codes.

- [ ] **Step 4: Make `findStoryVideo` drop unavailable OCR candidates**

Import:

```ts
import { attachFootageOcrCandidate } from '../lib/footage_candidate_ocr.ts';
```

Replace the raw `directStreamUrl` plus page fallback loop with:

```ts
const analyzedCandidates = [];
for (const candidate of onTopicU) {
  const ocrInput = {
    ...candidate,
    url: candidate.videoSrc || candidate.url,
    is_video: true as const,
  };
  const result = await attachFootageOcrCandidate(ocrInput);
  if (result.status === 'unavailable') {
    console.log(
      `    ↪ fallback: drop ${candidate.platform} candidate reason=media_access_failed`,
    );
    continue;
  }
  carryCurrentOcrMetadata(candidate, result.entry);
  candidate.sv = { outcome: candidate.ocr_outcome };
  analyzedCandidates.push(candidate);
}
if (!analyzedCandidates.length) {
  console.log('    ↪ fallback: semua kandidat on-topik tidak dapat dianalisis.');
  return null;
}
```

Change the later `tierOf`, `bestOf`, and `demoted` inputs from `onTopicU` to
`analyzedCandidates`.

- [ ] **Step 5: Run candidate and trace dependencies**

Run:

```powershell
rtk proxy bun scout/lib/footage_candidate_ocr.test.ts
rtk proxy bun scout/lib/footage_candidate_selection.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
rtk proxy bun scout/lib/verify.test.ts
```

Expected: every script exits zero.

- [ ] **Step 6: Run Scout typecheck and formatting**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib/footage_candidate_ocr.ts lib/footage_candidate_ocr.test.ts pipeline/trace_source.ts
```

Run both commands from `scout/`. Expected: exit zero.

- [ ] **Step 7: Commit optional-candidate isolation**

```powershell
rtk git add -- scout/lib/footage_candidate_ocr.ts scout/lib/footage_candidate_ocr.test.ts scout/pipeline/trace_source.ts
rtk git commit -m "fix(scout): isolate unresolved OCR candidates"
```

---

### Task 5: Run Complete Offline and Live Acceptance

**Files:**
- Verify: `scout/lib/media_resolution.test.ts`
- Verify: `scout/lib/ocr_content.test.ts`
- Verify: `scout/lib/subtitle_vision.test.ts`
- Verify: `scout/lib/footage_candidate_ocr.test.ts`
- Verify: `scout/lib/footage_candidate_selection.test.ts`
- Verify: `scout/lib/verify.test.ts`
- Verify: `scout/pipeline/ocr_local.test.ts`

**Interfaces:**
- Verifies the complete `resolveOcrMedia -> attachVideoOcr -> duration probe -> OCR` chain.
- Produces no source changes unless a verification failure reveals a defect; any defect fix returns to the owning task's test cycle and commit.

- [ ] **Step 1: Run all focused assertion scripts**

```powershell
rtk proxy bun scout/lib/media_resolution.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
rtk proxy bun scout/lib/subtitle_vision.test.ts
rtk proxy bun scout/lib/footage_candidate_ocr.test.ts
rtk proxy bun scout/lib/footage_candidate_selection.test.ts
rtk proxy bun scout/lib/verify.test.ts
rtk proxy bun scout/pipeline/ocr_local.test.ts
```

Expected: each script prints its success marker or exits zero.

- [ ] **Step 2: Run project checks**

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib pipeline
```

Run from `scout/`. Expected: both commands exit zero.

- [ ] **Step 3: Validate the repository diff**

```powershell
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; status contains only the intended implementation
changes plus pre-existing user changes.

- [ ] **Step 4: Run the live resolver-to-FFprobe smoke test**

With `YTDLP_COOKIES_FILE` pointing to the repository cookie file, resolve:

```text
https://www.instagram.com/imajinari.merchandise/reel/DbUrhHZpQgk/
```

Use a small Bun invocation that imports `resolveOcrMedia`; pass only the returned
media value to the repository `ffprobe.exe`. Expected:

- resolution status is `resolved`;
- attempts are between 1 and 3;
- elapsed time is at most 30,000 ms;
- FFprobe prints a positive duration;
- console and JSONL diagnostics contain no CDN URL.

- [ ] **Step 5: Run the reported pipeline smoke test**

```powershell
rtk proxy bun scout/cli.ts run-pipeline "https://www.instagram.com/p/DbQoG9IjzGX"
```

Expected:

- the selected platform page is resolved before OCR;
- FFprobe never receives the Instagram page URL;
- final OCR metadata is analyzed and current;
- no `duration_probe_failed` is emitted for a page-resolution failure; and
- a persistent resolver failure surfaces as `stream_resolution_failed`.
