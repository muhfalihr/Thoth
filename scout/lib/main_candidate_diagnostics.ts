import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { outPath } from './paths.ts';

const SAFE_KEYS = new Set([
  'origin',
  'platform',
  'safe_handle',
  'status',
  'reason',
  'similarity',
  'floor',
  'visual_kind',
  'ocr_outcome',
  'replacement_started',
  'detail',
]);

// `detail` carries a failure CODE, not a message: every producer draws from a closed vocabulary of
// snake_case identifiers. Enforcing that shape here keeps the allowlist's promise intact even if a
// future caller passes along an error string that quotes a url or a header.
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function sanitizeMainCandidateDiagnostic(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_KEYS.has(key)) continue;
    if (key === 'detail' && !(typeof value === 'string' && CODE.test(value))) continue;
    output[key] = value;
  }
  if (typeof input.candidate_url === 'string') {
    output.candidate_id = createHash('sha256')
      .update(input.candidate_url)
      .digest('hex')
      .slice(0, 16);
  }
  return output;
}

export function appendMainCandidateDiagnostic(record: Record<string, unknown>): void {
  const safe = sanitizeMainCandidateDiagnostic(record);
  const path = outPath('main_candidate_debug.jsonl');
  const line = `${JSON.stringify(safe)}\n`;
  try {
    fs.appendFileSync(path, line, 'utf8');
  } catch {
    // Diagnostics are optional and must not interrupt the main candidate pipeline.
  }
}

export function formatMainGateSummary(value: {
  accepted: number;
  rejected: Record<string, number>;
}): string {
  const rejected = Object.entries(value.rejected)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',');
  return `accepted=${value.accepted} rejected(${rejected})`;
}
