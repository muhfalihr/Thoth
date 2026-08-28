// source_credit_scan.ts — read the source credit off the COVER and the FIRST SECOND of a repost.
//
// A repost credits its origin in one of two visual ways, and the caption often carries neither:
//
//   * as TEXT — "@akun" burned into the frame, usually in the exact shape a caption would use, or a
//     platform watermark that drags a moving "@username" along with it, and
//   * as an ICON — a bare platform logo with no words at all.
//
// Text is harvested with the same OCR pass the subtitle stage already uses (boxes + text), then run
// through lib/source_credit.ts so a reply target can never be mistaken for a credit. The icon is
// described in prose by the vision model and that prose is matched against the seeded `platform_logos`
// table (lib/platform_logo.ts) — the model is never asked to NAME the platform, because that is the
// guess this pipeline keeps getting burned by.
//
// Everything degrades to an empty scan: no key, no frames, no seeded table, all yield
// `{ handles: [], platform: '' }`, which is exactly the "no visual credit" state the caller handles.

import { buildChatRequest, chatContent, chatKey, normalizeChatResponse } from '../lib/llm.ts';
import { matchPlatformLogo, type PlatformLogoDeps } from '../lib/platform_logo.ts';
import { extractHandles, type HandleHit } from '../lib/source_credit.ts';
import { extractFrameDataUrl, fetchJsonWithTimeout, ocrFrame } from '../lib/subtitle_vision.ts';
import { visionInputDataUrl } from './trace_source_vision.ts';

export type CreditScan = {
  handles: HandleHit[];
  /**
   * Raw OCR text from the scanned frames, deduped.
   *
   * `handles` only carries tokens written with an "@", but a TikTok watermark prints the username
   * BARE ("vincentius.christ76"), and harvesting every bare lowercase token as a handle would pick up
   * ordinary words. So the text goes to the LLM as-is and the guards verify the answer against it.
   */
  frameText: string;
  /** Platform named by the seeded logo table, or '' when no icon was convincing. */
  platform: string;
  platformScore: number;
  /** Prose the vision model produced for the icon — kept for the log and the prompt. */
  iconNote: string;
  /** Frames actually read (cover counts as one). */
  framesRead: number;
};

export type CreditScanInput = {
  /** Cover image: a data: URL, an http(s) URL, or a local path. */
  coverInput?: string;
  /** Direct video URL/path ffmpeg can seek — the page URL of a TikTok will NOT work. */
  videoSrc?: string;
  /** Seconds into the video to sample. Default: the first ~1.5 s, where credits live. */
  sampleTimes?: number[];
};

export type CreditScanDeps = {
  env?: Record<string, string | undefined>;
  ocr?: (image: string) => Promise<{ text: string }>;
  describeIcon?: (image: string) => Promise<string>;
  matchLogo?: (description: string) => Promise<{ platform: string; score: number } | null>;
  extractFrame?: (src: string, seconds: number) => string;
  logoDeps?: PlatformLogoDeps;
  log?: (line: string) => void;
};

const DEFAULT_TIMES = [0.2, 0.8, 1.5];
const EMPTY: CreditScan = {
  handles: [],
  frameText: '',
  platform: '',
  platformScore: 0,
  iconNote: '',
  framesRead: 0,
};
const FRAME_TEXT_CAP = 400;
/** How many frames may be shown to the vision model before giving up on finding an icon. */
const ICON_LOOKS = 2;

// "no icon" and "an icon the catalog could not name" are different failures with different fixes —
// one is a vision/frame problem, the other a seeding problem — and a log that renders them the same
// way sends the next debugging round to the wrong component.
const iconSummary = (scan: CreditScan, origin: string): string => {
  if (scan.platform) return `${scan.platform} (${scan.platformScore.toFixed(3)}) @${origin}`;
  if (scan.iconNote)
    return `terlihat @${origin} tapi tak dinamai katalog — "${scan.iconNote.slice(0, 60)}"`;
  return 'tak terlihat';
};

const parseTimes = (raw: string | undefined): number[] => {
  const parsed = (raw || '')
    .split(',')
    .map((value) => Number.parseFloat(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : DEFAULT_TIMES;
};

// The icon question is deliberately DESCRIPTIVE. Asking "which platform is this?" invites the model
// to answer from the topic of the video rather than from the pixels; asking what the mark looks like
// keeps the naming in the table, where it is grounded.
const ICON_PROMPT = `Lihat gambar ini. Apakah ada IKON/LOGO/WATERMARK platform media sosial yang
tercetak di frame (bukan konten videonya)? Kalau ADA, jelaskan SINGKAT bentuk, warna, dan posisinya
apa adanya — jangan menyebut nama platformnya, cukup deskripsikan yang terlihat. Kalau TIDAK ADA,
jawab persis: TIDAK ADA.`;

async function describeIconDefault(
  image: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (!chatKey('vision', env)) return '';
  try {
    const request = await buildChatRequest(
      {
        model: env.THOTH_LLM_VISION_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct',
        max_tokens: 120,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: ICON_PROMPT },
              { type: 'image_url', image_url: { url: image, detail: 'high' } },
            ],
          },
        ],
      },
      { role: 'vision', env },
    );
    const { response, data } = await fetchJsonWithTimeout(request.url, request.init, 30_000);
    if (!response.ok) return '';
    const text = chatContent(normalizeChatResponse(request.family, data)).trim();
    return /tidak ada/i.test(text) ? '' : text.slice(0, 300);
  } catch {
    return '';
  }
}

async function ocrDefault(
  image: string,
  env: Record<string, string | undefined>,
): Promise<{ text: string }> {
  const model = env.THOTH_SUBTITLE_OCR_MODEL || 'deepseek/deepseek-ocr-2';
  const { boxes } = await ocrFrame(image, model, env);
  return { text: boxes.map((box) => box.text).join(' ') };
}

/**
 * Scan a repost's cover and first second for a source credit.
 *
 * The cover is scanned first and is often enough on its own; video frames are only sampled when the
 * caller already holds a direct media URL, so this never triggers a download of its own.
 */
export async function scanSourceCredit(
  input: CreditScanInput,
  deps: CreditScanDeps = {},
): Promise<CreditScan> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const ocr = deps.ocr ?? ((image: string) => ocrDefault(image, env));
  const describeIcon = deps.describeIcon ?? ((image: string) => describeIconDefault(image, env));

  const images: Array<{ image: string; origin: string }> = [];
  if (input.coverInput) {
    const dataUrl = await visionInputDataUrl(input.coverInput);
    if (dataUrl) images.push({ image: dataUrl, origin: 'cover' });
  }
  if (input.videoSrc) {
    const grab =
      deps.extractFrame ?? ((src: string, t: number) => extractFrameDataUrl(src, t, env));
    for (const t of input.sampleTimes ?? parseTimes(env.THOTH_CREDIT_SCAN_TIMES)) {
      const frame = grab(input.videoSrc, t);
      if (frame) images.push({ image: frame, origin: `t=${t}s` });
    }
  }
  if (!images.length) return EMPTY;

  const handles = new Map<string, HandleHit>();
  // Frames repeat the same burned-in credit, so collect the OCR text per distinct line instead of
  // concatenating every frame — the same watermark three times over would crowd out the cap.
  const seenText = new Set<string>();
  for (const { image, origin } of images) {
    const { text } = await ocr(image);
    if (!text) continue;
    seenText.add(text.replace(/\s+/g, ' ').trim());
    for (const hit of extractHandles(text, origin)) {
      const previous = handles.get(hit.handle);
      if (previous) previous.credited ||= hit.credited;
      else handles.set(hit.handle, hit);
    }
  }
  const frameText = [...seenText].join(' | ').slice(0, FRAME_TEXT_CAP);

  // NOT just images[0]. The cover is a separately fetched THUMBNAIL, not a frame of this video — a
  // TikTok cover carries the news headline but none of the burned-in watermark, so asking about it
  // alone reports "no icon" for a video whose very next frame shows the mark plainly. Ask the
  // following frame when the first one comes back empty, capped so a video with no icon anywhere
  // never pays a call per frame.
  let iconNote = '';
  let iconOrigin = '';
  for (const { image, origin } of images.slice(0, ICON_LOOKS)) {
    iconNote = await describeIcon(image);
    if (iconNote) {
      iconOrigin = origin;
      break;
    }
  }
  let platform = '';
  let platformScore = 0;
  if (iconNote) {
    const matcher =
      deps.matchLogo ??
      ((description: string) => matchPlatformLogo(description, { log, ...deps.logoDeps }));
    const match = await matcher(iconNote);
    if (match) {
      platform = match.platform;
      platformScore = match.score;
    }
  }

  const scan: CreditScan = {
    handles: [...handles.values()],
    frameText,
    platform,
    platformScore,
    iconNote,
    framesRead: images.length,
  };
  // Always logged, even when empty: a silent scan used to be indistinguishable from a scan that
  // never ran, which is exactly how a working OCR read went unnoticed for a whole debugging round.
  log(
    `    · kredit visual: ${scan.framesRead} frame` +
      ` | handle: ${scan.handles.map((hit) => `@${hit.handle}${hit.credited ? '*' : ''}`).join(', ') || '-'}` +
      ` | teks: ${scan.frameText.slice(0, 80) || '-'}` +
      ` | ikon: ${iconSummary(scan, iconOrigin)}`,
  );
  return scan;
}
