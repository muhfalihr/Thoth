// platform_logo.ts — name the platform whose logo is burned into a cover / first-second frame.
//
// Reposts often credit their origin with an ICON rather than words: a TikTok note beside a moving
// @username, an IG camera or Reels clapper, the X mark. The vision model can only report what it
// sees in prose ("ada not musik kecil dengan bayangan cyan dan magenta di pojok kiri bawah"), which
// is not something `resolve_source.ts` can turn into a platform on its own — and asking the model to
// name the platform directly is exactly the guess this pipeline keeps getting burned by.
//
// So the naming is grounded in a table instead. `scripts/vision/embed_platform_logos.py` is run
// BEFORE Thoth and fills Supabase's `platform_logos` with one row per logo variant, each carrying a
// text embedding of a bilingual visual descriptor in the SAME space lib/embed.ts uses. Here we embed
// the vision model's prose and take the nearest row. No Python runs in the pipeline; this is one
// SELECT.
//
//   import { matchPlatformLogo } from './platform_logo.ts';
//   await matchPlatformLogo('not musik cyan magenta di pojok') → { platform: 'tiktok', score, … }
//
// Every failure — no key, no `pg`, table never seeded, ambiguous answer — degrades to null, because
// "no icon evidence" is the state the caller already handles.

import { embed } from './embed.ts';
import { supabaseUrl } from './env.ts';

export type LogoMatch = {
  platform: string;
  variant: string;
  score: number;
  /** Best score among rows of a DIFFERENT platform — the margin this answer won by. */
  runnerUp: number;
};

export type LogoRow = { platform: string; variant: string; score: number };

export type PlatformLogoDeps = {
  embedText?: (text: string) => Promise<number[] | null>;
  queryRows?: (vector: number[], limit: number) => Promise<LogoRow[]>;
  minScore?: number;
  minMargin?: number;
  log?: (line: string) => void;
};

// Tuned to be reluctant: a wrong platform is more expensive than no platform, since it sends the
// whole source search to the wrong finder.
const DEFAULT_MIN_SCORE = Number.parseFloat(process.env.THOTH_LOGO_MATCH_MIN || '0.55');
const DEFAULT_MIN_MARGIN = Number.parseFloat(process.env.THOTH_LOGO_MATCH_MARGIN || '0.03');
const CANDIDATES = 8;
// Decoy rows seeded by the Python catalog under this pseudo-platform (TV station bugs, news
// chyrons, on-screen clocks, the filmed scene itself). Winning here IS the answer "no platform icon"
// — without them every description is forced to pick one of six platforms.
const NONE_PLATFORM = '__none__';

async function defaultEmbed(text: string): Promise<number[] | null> {
  const [vector] = await embed([text]);
  return Array.isArray(vector) ? vector : null;
}

// halfvec has no JS driver representation; the literal form is what pgvector parses.
const vectorLiteral = (vector: number[]): string =>
  `[${vector.map((value) => value.toFixed(6)).join(',')}]`;

async function defaultQuery(vector: number[], limit: number): Promise<LogoRow[]> {
  const url = supabaseUrl();
  if (!url) return [];
  let Client: any;
  try {
    ({ Client } = (await import('pg')).default);
  } catch {
    return []; // optional dependency absent → no icon evidence, same as an unseeded table
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch {
    return [];
  }
  try {
    // One row per PLATFORM, not per variant: a plain top-N can be filled entirely by the platform
    // with the most seeded variants (youtube alone has 19), which would leave the margin gate below
    // with nothing to compare against and silently pass every answer.
    const result = await client.query(
      `SELECT platform, variant, score FROM (
         SELECT DISTINCT ON (platform)
                platform, variant, 1 - (text_embedding <=> $1::halfvec) AS score
           FROM platform_logos
          WHERE text_embedding IS NOT NULL
       ORDER BY platform, text_embedding <=> $1::halfvec
       ) best
     ORDER BY score DESC
        LIMIT $2`,
      [vectorLiteral(vector), limit],
    );
    return result.rows.map((row: any) => ({
      platform: String(row.platform || ''),
      variant: String(row.variant || ''),
      score: Number(row.score) || 0,
    }));
  } catch {
    // Table never seeded (or an older schema without text_embedding) — not an error worth aborting a
    // run over; the caller simply gets no icon evidence.
    return [];
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

/**
 * Nearest seeded logo for a free-text icon description, or null when the answer is not convincing.
 *
 * Two gates, not one: an absolute score (is this description about a logo at all?) and a margin over
 * the best row of a different platform (are two logos being confused?). The seeder warns about the
 * confusable pairs offline; this is the same guard at query time.
 */
export async function matchPlatformLogo(
  description: string,
  deps: PlatformLogoDeps = {},
): Promise<LogoMatch | null> {
  const text = (description || '').trim();
  if (text.length < 8) return null;
  const minScore = deps.minScore ?? DEFAULT_MIN_SCORE;
  const minMargin = deps.minMargin ?? DEFAULT_MIN_MARGIN;
  const log = deps.log ?? (() => {});

  // Both of these used to return null in silence, which made "the catalog said no" indistinguishable
  // from "the lookup never happened" — the difference between a seeding problem and a missing key.
  const vector = await (deps.embedText ?? defaultEmbed)(text);
  if (!vector?.length) {
    log('    · ikon platform: embedding deskripsi gagal → dilewati');
    return null;
  }

  const rows = await (deps.queryRows ?? defaultQuery)(vector, CANDIDATES);
  if (!rows.length) {
    log(
      '    · ikon platform: tabel `platform_logos` tak menjawab (belum di-seed / tanpa pg / tanpa URL Supabase)',
    );
    return null;
  }

  const best = rows[0];
  if (best.platform === NONE_PLATFORM) {
    log(`    · ikon platform: paling mirip "bukan logo" (${best.variant}) → diabaikan`);
    return null;
  }
  const runnerUp = rows.find((row) => row.platform !== best.platform)?.score ?? 0;
  if (best.score < minScore) {
    log(`    · ikon platform: kandidat terbaik ${best.platform} ${best.score.toFixed(3)} < ambang`);
    return null;
  }
  if (best.score - runnerUp < minMargin) {
    log(
      `    · ikon platform: ${best.platform} vs ${rows.find((row) => row.platform !== best.platform)?.platform} terlalu rapat (${best.score.toFixed(3)}/${runnerUp.toFixed(3)}) → diabaikan`,
    );
    return null;
  }
  return { platform: best.platform, variant: best.variant, score: best.score, runnerUp };
}
