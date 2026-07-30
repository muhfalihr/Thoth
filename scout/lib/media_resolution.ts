// media_resolution.ts — typed, deadline-bounded resolver from a page/local/direct input to a
// real, ffmpeg-openable media stream. Supported platform *page* URLs (Instagram/YouTube/X/
// Facebook) must never reach FFprobe/FFmpeg directly — they get resolved to a signed CDN URL
// here first, with a shared 30s deadline across at most 3 attempts (backoffs 500ms, 1500ms).
// TikTok/Threads keep their existing dedicated paths and are explicitly rejected here
// ('unsupported') so callers don't double-resolve them.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { outPath } from './paths.ts';
import { sanitizeResolverDetail } from './redact.ts';
import { directStreamArgs } from './verify.ts';

export const MEDIA_RESOLUTION_DEADLINE_MS = 30_000;
export const MEDIA_RESOLUTION_MAX_ATTEMPTS = 3;
export const MEDIA_RESOLUTION_BACKOFF_MS = [500, 1_500] as const;

export type MediaResolutionSource = 'local' | 'direct' | 'platform-resolver';
export type StreamResolutionReason = 'timeout' | 'extractor_exit' | 'no_stream' | 'unsupported';

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

// Routing is by HOST, not by url path. Keying off a handful of path shapes (/p/, /reel/, watch?v=,
// /status/) meant every OTHER path on the same host fell through to the "not a known page url, so it
// must already be direct media" branch below — instagram profile and /stories/ urls, youtube.com/
// shorts, tiktok /photo/ and vt.tiktok.com short links were handed to ffprobe verbatim. ffprobe read
// HTML, exited 1, and that surfaced as `duration_probe_failed`, which build_footage does not
// tolerate, so a single such candidate killed a required stage. An unrecognized path on a platform
// host is still a web page: resolve it, never pass it through.
const PLATFORM_HOSTS = [
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  'facebook.com',
] as const;

// TikTok/Threads keep dedicated resolvers, so the whole host is rejected here rather than the two
// path shapes that used to be — callers must not double-resolve them.
const SPECIALIZED_HOSTS = ['tiktok.com', 'threads.net', 'threads.com'] as const;

function hostMatches(value: string, hosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
}

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
        const childError = error as
          | (Error & {
              code?: string | number;
              killed?: boolean;
            })
          | null;
        resolve({
          exitCode: typeof childError?.code === 'number' ? childError.code : childError ? 1 : 0,
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

export { sanitizeResolverDetail };

function appendMediaResolutionDiagnostic(input: string, record: Record<string, unknown>): void {
  const sourceId = createHash('sha256').update(input).digest('hex').slice(0, 16);
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
  return (
    String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => {
        if (
          !/^https?:\/\//i.test(line) ||
          line === input ||
          hostMatches(line, PLATFORM_HOSTS) ||
          hostMatches(line, SPECIALIZED_HOSTS)
        ) {
          return false;
        }
        try {
          const parsed = new URL(line);
          return !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      }) || ''
  );
}

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
      appendMediaResolutionDiagnostic(value, record as Record<string, unknown>));
  const emitDiagnostic = (record: Record<string, unknown>) =>
    writeDiagnostics({
      platform: platformForInput(value),
      ...record,
    });

  if (value && fs.existsSync(value)) {
    return { status: 'resolved', media: value, source: 'local', attempts: 0, elapsed_ms: 0 };
  }
  if (!/^https?:\/\//i.test(value) || hostMatches(value, SPECIALIZED_HOSTS)) {
    return {
      status: 'unavailable',
      code: 'stream_resolution_failed',
      reason: 'unsupported',
      attempts: 0,
      elapsed_ms: Math.max(0, now() - started),
    };
  }
  if (!hostMatches(value, PLATFORM_HOSTS)) {
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
      log(`[media] resolved attempts=${attempts} elapsed=${result.elapsed_ms}ms`);
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
    // Deadline exhaustion alone does not mean the failure cause was a timeout — an attempt only
    // truly timed out when the resolver process itself reported timedOut. Report the last
    // observed failure cause instead; only fall back to 'timeout' when no attempt ran at all
    // (attempts === 0, e.g. a zero/negative deadline before the loop could start).
    reason: attempts === 0 ? 'timeout' : reason,
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
