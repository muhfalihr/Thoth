// source_credit.ts — decide which @handle in a post's TEXT is a genuine source credit.
//
// A repost's caption, its on-screen headline, and the watermark burned into its first second are all
// full of @mentions, and only some of them credit the origin of the footage. Three failure modes have
// each shipped a wrong source into a run:
//
//   1. "Membalas @E N O L A ..." — TikTok's own reply prefix. The mention is the COMMENTER being
//      answered, and it carries a display name ("E N O L A"), not a handle, so chasing it searches
//      for an account that does not exist.
//   2. A platform the text never mentions. The LLM guessed "instagram" for a TikTok post; the source
//      search was then handed to the Instagram finder.
//   3. A handle the LLM invented outright ("@niscayabernostro" for a detikjatim clip). Nothing in the
//      post contains it.
//
// Everything here is a check against the text the model was shown, so a claim survives only when the
// evidence for it is actually there.

// Reply prefixes, ID + EN. The trailing @ is part of the pattern: only a mention immediately after
// the prefix is a reply target.
const REPLY_PREFIX =
  /(?:membalas|menjawab|balasan|balas|reply(?:ing)?\s+to|answering)\s*(?:komentar\s*)?(?:dari\s*)?(?:ke(?:pada)?\s*)?@/gi;

// Genuine source-credit conventions. A handle that also appears behind one of these is a credit even
// if it happens to appear behind a reply prefix somewhere else in the same text.
const CREDIT_MARKER =
  /(?:\bcr\b|\bcredit\b|\bvia\b|\bsumber\b|\bsource\b|📸|📷|🎥|\btt\/)\s*:?\s*@?/gi;

// Platform evidence must be IN the text. Without this the model is free to guess, and a guessed
// platform sends the source search to the wrong finder entirely.
const PLATFORM_EVIDENCE: Record<string, RegExp> = {
  tiktok: /tiktok|\btt\s*[/:]|douyin/i,
  instagram: /instagram|\big\b|\binsta\b|\breels?\b|📸|📷|🎥/i,
  twitter: /twitter|\bx\.com|\btweet/i,
  youtube: /youtube|youtu\.be|\byt\b|\bshorts?\b/i,
  facebook: /facebook|\bfb\b/i,
  threads: /threads/i,
};

// A watermark handle survives OCR as "@ user_name" or "@USER_NAME"; a caption may spell a display
// name with spaces ("E N O L A"). Dropping spaces and punctuation lets one comparison cover both.
export const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9._]/g, '');

function mentionFollows(pattern: RegExp, text: string, wanted: string): boolean {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
    if (compact(after).startsWith(wanted)) return true;
  }
  return false;
}

/** True when this account only ever appears as the target of a reply — never as a credit. */
export function isReplyMentionOnly(account: string, text: string): boolean {
  const wanted = compact(account);
  // A very short handle matches the start of almost any sentence; never claim one either way.
  if (wanted.length < 3) return false;
  return mentionFollows(REPLY_PREFIX, text, wanted) && !mentionFollows(CREDIT_MARKER, text, wanted);
}

/** True when the text itself names this platform (or uses one of its credit conventions). */
export function platformHasEvidence(platform: string, text: string): boolean {
  const pattern = PLATFORM_EVIDENCE[platform];
  return !!pattern && pattern.test(text);
}

/**
 * True when this account literally occurs in the text the model was shown.
 *
 * The comparison is on the compacted forms, so "@E N O L A" in a caption backs an answer of "enola",
 * and an OCR'd "@ detik jatim" backs "detikjatim" — but an account that appears nowhere backs
 * nothing, which is the only thing standing between a hallucinated handle and a search for it.
 */
export function accountHasEvidence(account: string, text: string): boolean {
  const wanted = compact(account);
  if (wanted.length < 3) return false;
  return compact(text).includes(wanted);
}

export type HandleHit = {
  handle: string;
  /** Where the handle was read from — used only for logging/prompt provenance. */
  origin: string;
  /** True when the mention sits behind a credit marker (cr:/via/sumber/📸/tt/). */
  credited: boolean;
};

// Real handles have no spaces. Requiring that is what keeps a reply prefix's display name
// ("@E N O L A") from being harvested as if it were an account.
const HANDLE = /@([a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9])/gi;

// Platform UI chrome that OCR reads as a handle-shaped token but which credits nobody.
const UI_NOISE = new Set([
  'tiktok',
  'instagram',
  'youtube',
  'facebook',
  'threads',
  'shorts',
  'reels',
]);

/**
 * Harvest @handles from one piece of text (caption, OCR of a frame, vision headline).
 *
 * Reply targets are dropped here rather than downstream, so no caller can accidentally treat one as
 * a candidate. Order is preserved and duplicates collapse to their strongest form: a handle seen
 * once behind "cr:" stays `credited` even if it also appears bare later.
 */
export function extractHandles(text: string, origin: string): HandleHit[] {
  const source = text || '';
  const hits = new Map<string, HandleHit>();
  HANDLE.lastIndex = 0;
  for (let match = HANDLE.exec(source); match; match = HANDLE.exec(source)) {
    const handle = match[1].toLowerCase().replace(/[._]+$/, '');
    if (handle.length < 3 || UI_NOISE.has(handle)) continue;
    if (isReplyMentionOnly(handle, source)) continue;
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    CREDIT_MARKER.lastIndex = 0;
    const credited = CREDIT_MARKER.test(before);
    const previous = hits.get(handle);
    if (previous) {
      previous.credited ||= credited;
    } else {
      hits.set(handle, { handle, origin, credited });
    }
  }
  return [...hits.values()];
}
