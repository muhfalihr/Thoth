// provider_check.test.ts — the reference container and the fallback worker must be
// given the same provider input, and this is the only place that says so before a
// run starts.
//
// Every map below is synthetic. The check is a configuration assertion, not an
// authentication attempt: a present key proves nothing about quota or model
// availability, so the executable must stay offline and print only role readiness.

import { expect, test } from 'bun:test';
import { checkReferenceProviders, renderProviderReport } from './provider_check.ts';

const CANARY_KEY = 'synthetic-canary-only-not-a-real-key';

const READY = {
  THOTH_SCOUT_PROVIDER: 'novita',
  THOTH_NOVITA_API_KEY: CANARY_KEY,
  THOTH_SUBTITLE_OCR_MODEL: 'deepseek/deepseek-ocr',
};

test('a fully configured novita environment is ready for every reference role', () => {
  expect(checkReferenceProviders(READY)).toEqual({
    chat: true,
    vision: true,
    embed: true,
    ocrModel: true,
  });
});

test('the default provider counts as novita even without an explicit selection', () => {
  const { THOTH_SCOUT_PROVIDER: _unused, ...implicit } = READY;

  expect(checkReferenceProviders(implicit)).toEqual({
    chat: true,
    vision: true,
    embed: true,
    ocrModel: true,
  });
});

test('a missing provider key fails every role that needs it', () => {
  const { THOTH_NOVITA_API_KEY: _unused, ...keyless } = READY;

  expect(checkReferenceProviders(keyless)).toEqual({
    chat: false,
    vision: false,
    embed: false,
    ocrModel: true,
  });
});

test('an empty provider key is treated as missing', () => {
  expect(checkReferenceProviders({ ...READY, THOTH_NOVITA_API_KEY: '   ' })).toMatchObject({
    chat: false,
  });
});

test('a non-novita role fails even when that provider is fully credentialed', () => {
  const report = checkReferenceProviders({
    ...READY,
    THOTH_SCOUT_VISION_PROVIDER: 'groq',
    THOTH_GROQ_API_KEY: CANARY_KEY,
  });

  expect(report).toEqual({ chat: true, vision: false, embed: true, ocrModel: true });
});

test('an unknown provider name fails the role instead of throwing', () => {
  const report = checkReferenceProviders({
    ...READY,
    THOTH_SCOUT_EMBED_PROVIDER: 'not-a-provider',
  });

  expect(report).toEqual({ chat: true, vision: true, embed: false, ocrModel: true });
});

test('the ocr model must be provider qualified', () => {
  for (const model of ['', '   ', 'deepseek-ocr', 'deepseek ocr', 'a/b c']) {
    expect(checkReferenceProviders({ ...READY, THOTH_SUBTITLE_OCR_MODEL: model })).toMatchObject({
      ocrModel: false,
    });
  }
});

test('the report renders booleans and the model name, never the key', () => {
  const lines = renderProviderReport(READY);

  expect(lines).toEqual([
    'chat_provider=novita chat_ready=true',
    'vision_provider=novita vision_ready=true',
    'embed_provider=novita embed_ready=true',
    'ocr_model=deepseek/deepseek-ocr ocr_model_ready=true',
  ]);
  expect(lines.join('\n')).not.toContain(CANARY_KEY);
});

test('an unusable selection is named without echoing any value', () => {
  const lines = renderProviderReport({
    ...READY,
    THOTH_SCOUT_CHAT_PROVIDER: 'not-a-provider',
    THOTH_SUBTITLE_OCR_MODEL: 'not-qualified',
  });

  expect(lines[0]).toBe('chat_provider=unknown chat_ready=false');
  expect(lines[3]).toBe('ocr_model=not-qualified ocr_model_ready=false');
  expect(lines.join('\n')).not.toContain(CANARY_KEY);
});

test('the module never reaches a provider endpoint', async () => {
  const source = await Bun.file(new URL('./provider_check.ts', import.meta.url)).text();

  expect(source).not.toContain('chatCompletion');
  expect(source).not.toContain('llm.ts');
  expect(source).not.toContain('fetch(');
});

test('importing the module runs nothing', async () => {
  const child = Bun.spawn(
    ['bun', '-e', "await import('./scout/runtime/provider_check.ts'); console.log('imported')"],
    { cwd: Bun.fileURLToPath(new URL('../../', import.meta.url)), stdout: 'pipe', stderr: 'pipe' },
  );

  expect(await new Response(child.stdout).text()).toBe('imported\n');
  expect(await child.exited).toBe(0);
});
