// provider_check.ts — offline assertion that the shared Scout provider input is present.
//
// Legacy Scout aborts its first pipeline step without a model provider key, so a
// deployment that only carries the digest is not fallback-ready. This executable is
// the pre-run check for that: it names the provider selected for each reference role
// and whether the inputs that role needs exist.
//
// It is a configuration check, never an authentication attempt. A present key proves
// nothing about authentication, quota, or model availability, so nothing here calls a
// provider. `checkReferenceProviders` also takes its environment explicitly rather
// than defaulting to `process.env`, because importing `lib/env.ts` hydrates
// `process.env` from the repository `.env` as a pre-existing side effect and a caller
// must be able to assert on exactly the map it passed.

import { type EnvRecord, type ProviderName, providerFor, providerReady } from '../lib/env.ts';

export const REQUIRED_PROVIDER: ProviderName = 'novita';
export const OCR_MODEL_VARIABLE = 'THOTH_SUBTITLE_OCR_MODEL';
export const REFERENCE_ROLES = ['chat', 'vision', 'embed'] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export interface ReferenceProviderReport {
  chat: boolean;
  vision: boolean;
  embed: boolean;
  ocrModel: boolean;
}

/** A provider-qualified model identifier: `vendor/model`, no whitespace. */
const OCR_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The provider chosen for one role, or null when the name is not in the registry. */
export function selectedProvider(role: ReferenceRole, env: EnvRecord): ProviderName | null {
  try {
    return providerFor(role, env);
  } catch {
    return null;
  }
}

export function checkReferenceProviders(env: EnvRecord): ReferenceProviderReport {
  const report: ReferenceProviderReport = {
    chat: false,
    vision: false,
    embed: false,
    ocrModel: OCR_MODEL_PATTERN.test((env[OCR_MODEL_VARIABLE] ?? '').trim()),
  };
  for (const role of REFERENCE_ROLES) {
    const provider = selectedProvider(role, env);
    report[role] = provider === REQUIRED_PROVIDER && providerReady(provider, env);
  }
  return report;
}

/** Role readiness only: booleans and the model name, never a key or a base URL. */
export function renderProviderReport(env: EnvRecord): string[] {
  const report = checkReferenceProviders(env);
  const lines = REFERENCE_ROLES.map(
    (role) =>
      `${role}_provider=${selectedProvider(role, env) ?? 'unknown'} ${role}_ready=${report[role]}`,
  );
  const model = (env[OCR_MODEL_VARIABLE] ?? '').trim() || '(unset)';
  lines.push(`ocr_model=${model} ocr_model_ready=${report.ocrModel}`);
  return lines;
}

function main(): void {
  for (const line of renderProviderReport(process.env)) console.log(line);
  const report = checkReferenceProviders(process.env);
  process.exitCode = report.chat && report.vision && report.embed && report.ocrModel ? 0 : 1;
}

if (import.meta.main) main();
