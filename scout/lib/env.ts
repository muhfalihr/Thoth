// env.js — SATU-SATUNYA sumber credential/secret untuk semua script scout.
//
// Membaca .env di ROOT repo (../../.env — file yang sama dipakai Thoth Rust) sekali
// saat require, lalu inject ke process.env. Env asli dari shell MENANG — .env hanya
// mengisi variabel yang belum ada. Key file lama per-folder (.novita_key/.groq_key/
// .supabase_url) TIDAK dibaca lagi — semua secret hidup di satu .env root.
//
// Pakai:
//   import * as env from '../lib/env.ts';       // (atau './env' dari lib/)
//   env.novitaKey()  env.groqKey()  env.supabaseUrl()  env.get('THOTH_X', 'default')

import fs from 'node:fs';
import path from 'node:path';

const ENV_FILE = path.join(import.meta.dirname, '..', '..', '.env');

(function load() {
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_FILE, 'utf8');
  } catch (e) {
    return;
  } // tanpa .env → murni shell env
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2'); // strip quote opsional
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
})();

const get = (name: string, def = ''): string => (process.env[name] || def).trim();

const novitaKey = (): string => get('THOTH_NOVITA_API_KEY');
const groqKey = (): string => get('THOTH_GROQ_API_KEY') || get('GROQ_API_KEY');
const supabaseUrl = (): string => get('THOTH_SUPABASE_URL');

// ── Provider AI ───────────────────────────────────────────────────────────────
// SATU-SATUNYA tempat URL provider boleh ditulis. Tak ada call-site yang boleh menulis URL
// provider secara literal: saat provider/endpoint pindah (atau harus diarahkan ke gateway/
// vLLM lokal), literal yang tersebar di belasan file berarti perburuan file — dan tiap file
// yang terlewat gagal diam-diam.
//
// Daftar provider di bawah = daftar yang sama yang didukung crates Rust
// (`crates/thoth-core/src/endpoints.rs` + `analyze/provider/`), memakai nama variabel env yang
// SAMA persis (`THOTH_<PROVIDER>_API_KEY`, `THOTH_<PROVIDER>_BASE_URL`) supaya satu .env
// mengonfigurasi Rust dan scout sekaligus. `chatPath` mengikuti konvensi Rust per-provider:
// root yang sudah mengandung `/v1` (groq/openai) cuma menempel `/chat/completions`, root
// pra-`/v1` (novita/together/…) menempel `/v1/chat/completions`.
type EnvRecord = Record<string, string | undefined>;

/** Bentuk wire protocol. Terjemahannya ada di `lib/llm.ts`, bukan di sini. */
type WireFamily = 'openai' | 'anthropic' | 'gemini';

interface ProviderSpec {
  family: WireFamily;
  baseUrlVar: string;
  defaultBaseUrl: string;
  /** Var key, yang pertama terisi menang. Kosong = provider lokal tanpa auth. */
  keyVars: string[];
  chatPath: string;
  embeddingsPath: string;
}

const PROVIDERS = {
  novita: {
    family: 'openai',
    baseUrlVar: 'THOTH_NOVITA_BASE_URL',
    defaultBaseUrl: 'https://api.novita.ai/openai',
    keyVars: ['THOTH_NOVITA_API_KEY'],
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
  groq: {
    family: 'openai',
    baseUrlVar: 'THOTH_GROQ_BASE_URL',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyVars: ['THOTH_GROQ_API_KEY', 'GROQ_API_KEY'],
    chatPath: '/chat/completions',
    embeddingsPath: '/embeddings',
  },
  openai: {
    family: 'openai',
    baseUrlVar: 'THOTH_OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyVars: ['THOTH_OPENAI_API_KEY'],
    chatPath: '/chat/completions',
    embeddingsPath: '/embeddings',
  },
  claude: {
    family: 'anthropic',
    baseUrlVar: 'THOTH_CLAUDE_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyVars: ['THOTH_CLAUDE_API_KEY'],
    chatPath: '/messages',
    embeddingsPath: '', // Anthropic tak punya embeddings API.
  },
  gemini: {
    family: 'gemini',
    baseUrlVar: 'THOTH_GEMINI_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyVars: ['THOTH_GEMINI_API_KEY'],
    // Model masuk ke PATH, bukan body → diselesaikan di llm.ts, bukan lewat join biasa.
    chatPath: '/models/{model}:generateContent',
    embeddingsPath: '/models/{model}:embedContent',
  },
  openrouter: {
    family: 'openai',
    baseUrlVar: 'THOTH_OPENROUTER_BASE_URL',
    defaultBaseUrl: 'https://openrouter.ai/api',
    keyVars: ['THOTH_OPENROUTER_API_KEY'],
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
  together: {
    family: 'openai',
    baseUrlVar: 'THOTH_TOGETHER_BASE_URL',
    defaultBaseUrl: 'https://api.together.xyz',
    keyVars: ['THOTH_TOGETHER_API_KEY'],
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
  fireworks: {
    family: 'openai',
    baseUrlVar: 'THOTH_FIREWORKS_BASE_URL',
    defaultBaseUrl: 'https://api.fireworks.ai/inference',
    keyVars: ['THOTH_FIREWORKS_API_KEY'],
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
  vllm: {
    family: 'openai',
    baseUrlVar: 'THOTH_VLLM_BASE_URL',
    defaultBaseUrl: 'http://localhost:8000',
    keyVars: ['THOTH_VLLM_API_KEY'], // opsional; vLLM self-hosted biasanya tanpa auth
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
  ollama: {
    family: 'openai',
    baseUrlVar: 'THOTH_OLLAMA_BASE_URL',
    defaultBaseUrl: 'http://localhost:11434',
    keyVars: [],
    chatPath: '/v1/chat/completions',
    embeddingsPath: '/v1/embeddings',
  },
} as const satisfies Record<string, ProviderSpec>;

type ProviderName = keyof typeof PROVIDERS;

const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

/** Provider default kalau tak ada env yang menyetel — perilaku scout sebelum multi-provider. */
const DEFAULT_PROVIDER: ProviderName = 'novita';

const isProviderName = (value: string): value is ProviderName => Object.hasOwn(PROVIDERS, value);

const providerSpec = (name: ProviderName): ProviderSpec => PROVIDERS[name];

/**
 * Provider terpilih untuk satu peran. `THOTH_SCOUT_<ROLE>_PROVIDER` menang, lalu
 * `THOTH_SCOUT_PROVIDER` (berlaku untuk semua peran), lalu novita. Nama tak dikenal →
 * lempar, karena diam-diam jatuh ke novita berarti tagihan pergi ke provider yang salah.
 */
const providerFor = (
  role: 'chat' | 'vision' | 'embed' = 'chat',
  env: EnvRecord = process.env,
): ProviderName => {
  const roleVar = `THOTH_SCOUT_${role.toUpperCase()}_PROVIDER`;
  const raw = (
    (env[roleVar] || '').trim() || (env.THOTH_SCOUT_PROVIDER || '').trim()
  ).toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (!isProviderName(raw)) {
    throw new Error(
      `unknown provider "${raw}" in ${env[roleVar] ? roleVar : 'THOTH_SCOUT_PROVIDER'} — ` +
        `pilih salah satu: ${PROVIDER_NAMES.join(', ')}`,
    );
  }
  return raw;
};

const baseUrl = (env: EnvRecord, name: string, fallback: string): string =>
  ((env[name] || '').trim() || fallback).replace(/\/+$/, '');

/** Root satu provider — override lewat `THOTH_<PROVIDER>_BASE_URL`. */
const providerBaseUrl = (name: ProviderName, env: EnvRecord = process.env): string => {
  const spec = providerSpec(name);
  return baseUrl(env, spec.baseUrlVar, spec.defaultBaseUrl);
};

/** Key satu provider; string kosong berarti belum diset ATAU provider tak butuh key. */
const providerKey = (name: ProviderName, env: EnvRecord = process.env): string => {
  for (const variable of providerSpec(name).keyVars) {
    const value = (env[variable] || '').trim();
    if (value) return value;
  }
  return '';
};

/** Apakah provider ini siap dipakai (key ada, atau memang tak butuh key). */
const providerReady = (name: ProviderName, env: EnvRecord = process.env): boolean =>
  providerSpec(name).keyVars.length === 0 || providerKey(name, env) !== '';

/** URL chat provider. `{model}` di path (gemini) diisi caller lewat `model`. */
const providerChatUrl = (name: ProviderName, env: EnvRecord = process.env, model = ''): string =>
  `${providerBaseUrl(name, env)}${providerSpec(name).chatPath.replace('{model}', model)}`;

const providerEmbeddingsUrl = (
  name: ProviderName,
  env: EnvRecord = process.env,
  model = '',
): string => {
  const spec = providerSpec(name);
  if (!spec.embeddingsPath) throw new Error(`provider "${name}" has no embeddings endpoint`);
  return `${providerBaseUrl(name, env)}${spec.embeddingsPath.replace('{model}', model)}`;
};

// Transcribe tetap khusus Groq (Whisper API) — Rust pun hanya punya jalur ini di luar Whisper lokal.
const groqTranscriptionsUrl = (env?: EnvRecord): string =>
  `${providerBaseUrl('groq', env)}/audio/transcriptions`;

export type { EnvRecord, ProviderName, WireFamily };
export {
  DEFAULT_PROVIDER,
  ENV_FILE,
  get,
  groqKey,
  groqTranscriptionsUrl,
  isProviderName,
  novitaKey,
  PROVIDER_NAMES,
  PROVIDERS,
  providerBaseUrl,
  providerChatUrl,
  providerEmbeddingsUrl,
  providerFor,
  providerKey,
  providerReady,
  providerSpec,
  supabaseUrl,
};
