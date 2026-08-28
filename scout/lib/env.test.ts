// scout/lib/env.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROVIDER,
  groqTranscriptionsUrl,
  PROVIDER_NAMES,
  PROVIDERS,
  providerChatUrl,
  providerEmbeddingsUrl,
  providerFor,
  providerKey,
  providerReady,
} from './env.ts';

assert.equal(
  providerChatUrl('novita', {}),
  `${PROVIDERS.novita.defaultBaseUrl}${PROVIDERS.novita.chatPath}`,
);
assert.equal(
  providerEmbeddingsUrl('novita', {}),
  `${PROVIDERS.novita.defaultBaseUrl}${PROVIDERS.novita.embeddingsPath}`,
);
assert.equal(groqTranscriptionsUrl({}), `${PROVIDERS.groq.defaultBaseUrl}/audio/transcriptions`);

// A blank value is a value nobody meant to set — treat it as unset rather than building
// `/chat/completions` against nothing.
assert.equal(
  providerChatUrl('novita', { THOTH_NOVITA_BASE_URL: '   ' }),
  providerChatUrl('novita', {}),
);

// Overrides point every AI call at another host (a gateway, a local vLLM), with or without the
// trailing slash an operator naturally pastes.
assert.equal(
  providerChatUrl('novita', { THOTH_NOVITA_BASE_URL: 'http://127.0.0.1:8000/' }),
  'http://127.0.0.1:8000/v1/chat/completions',
);
assert.equal(
  providerEmbeddingsUrl('openai', { THOTH_OPENAI_BASE_URL: 'https://gateway.test/openai' }),
  'https://gateway.test/openai/embeddings',
);
assert.equal(
  groqTranscriptionsUrl({ THOTH_GROQ_BASE_URL: 'https://gateway.test/groq' }),
  'https://gateway.test/groq/audio/transcriptions',
);

// Model Gemini masuk ke PATH, bukan body — kalau `{model}` tak tersulih, requestnya 404 diam-diam.
assert.equal(
  providerChatUrl('gemini', {}, 'gemini-2.0-flash'),
  `${PROVIDERS.gemini.defaultBaseUrl}/models/gemini-2.0-flash:generateContent`,
);

// Setiap provider yang didukung Rust harus punya entry di sini, kalau tidak scout tak bisa
// dipakai dengan konfigurasi .env yang sama.
for (const name of [
  'groq',
  'openai',
  'claude',
  'gemini',
  'novita',
  'openrouter',
  'together',
  'fireworks',
  'vllm',
  'ollama',
] as const) {
  assert.ok(PROVIDER_NAMES.includes(name), `provider ${name} hilang dari registry`);
}

// Pemilihan peran: var peran menang atas var global, dan default tetap perilaku lama.
assert.equal(providerFor('chat', {}), DEFAULT_PROVIDER);
assert.equal(providerFor('vision', { THOTH_SCOUT_PROVIDER: 'openai' }), 'openai');
assert.equal(
  providerFor('vision', { THOTH_SCOUT_PROVIDER: 'openai', THOTH_SCOUT_VISION_PROVIDER: 'claude' }),
  'claude',
);
// Nama salah ketik harus berisik — kalau tidak, tagihan diam-diam jalan ke provider default.
assert.throws(() => providerFor('chat', { THOTH_SCOUT_PROVIDER: 'gpt5' }), /unknown provider/);

// Key: var pertama yang terisi menang; provider lokal tanpa auth tetap dianggap siap.
assert.equal(providerKey('groq', { GROQ_API_KEY: 'fallback' }), 'fallback');
assert.equal(
  providerKey('groq', { THOTH_GROQ_API_KEY: 'primary', GROQ_API_KEY: 'fallback' }),
  'primary',
);
assert.equal(providerReady('ollama', {}), true);
assert.equal(providerReady('openai', {}), false);
assert.equal(providerReady('openai', { THOTH_OPENAI_API_KEY: 'k' }), true);
console.log('ok env_provider_urls');

// The point of the helpers above is that they are the ONLY place a provider host is written.
// A literal that creeps back into a call site is invisible to every override an operator sets.
{
  const root = path.join(import.meta.dirname, '..');
  const skip = new Set(['node_modules', 'output', 'deprecated', '.git']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mjs)$/.test(entry.name)) continue;
      if (full === path.join(root, 'lib', 'env.ts') || full === import.meta.filename) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (
          /https?:\/\/[^\s'"`]*(novita|groq|openai|anthropic|googleapis|openrouter)\.[a-z]/i.test(
            line,
          ) &&
          !line.trimStart().startsWith('//')
        ) {
          offenders.push(`${path.relative(root, full)}:${index + 1}`);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'provider hosts belong in lib/env.ts, not in call sites');
  console.log('ok env_no_hardcoded_provider_host');
}
