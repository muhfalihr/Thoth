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
]);

export function sanitizeMainCandidateDiagnostic(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SAFE_KEYS.has(key)) output[key] = value;
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
  fs.appendFileSync(outPath('main_candidate_debug.jsonl'), `${JSON.stringify(safe)}\n`, 'utf8');
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
