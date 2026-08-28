// llm.ts — satu pintu untuk semua panggilan chat/vision scout, ke provider mana pun.
//
// Scout dulu bicara langsung ke Novita di ~14 tempat: tiap call-site menulis sendiri URL,
// header Bearer, body OpenAI, dan cara membaca `choices[0].message.content`. Artinya scout
// terkunci ke satu provider, sementara crates Rust sudah mendukung sepuluh.
//
// Di sini SATU bentuk internal dipertahankan — request/response ala OpenAI, karena itulah
// yang sudah diucapkan semua call-site — lalu diterjemahkan ke wire protocol provider
// terpilih (`lib/env.ts` yang memilih & menyimpan endpoint/key-nya):
//
//   openai    → pass-through (novita, groq, openai, openrouter, together, fireworks, vllm, ollama)
//   anthropic → Messages API (system terpisah, blok gambar base64/url, header x-api-key)
//   gemini    → generateContent (model di path, key di query, parts + inlineData)
//
// Jadi call-site tak pernah tahu provider apa yang dipakai, dan menambah provider = satu
// entry di `PROVIDERS`, bukan menyentuh 14 file.

import {
  type EnvRecord,
  type ProviderName,
  providerChatUrl,
  providerFor,
  providerKey,
  providerReady,
  providerSpec,
  type WireFamily,
} from './env.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  [extra: string]: unknown;
}

export interface ChatOptions {
  /** Peran menentukan provider mana yang dipakai. Default: auto — 'vision' kalau ada gambar. */
  role?: 'chat' | 'vision';
  provider?: ProviderName;
  env?: EnvRecord;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Bentuk balasan yang dilihat call-site: selalu ala OpenAI, apa pun providernya. */
export interface ChatResponse {
  ok: boolean;
  status: number;
  provider: ProviderName;
  json(): Promise<any>;
  text(): Promise<string>;
}

const hasImage = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part?.type === 'image_url'),
  );

const resolveProvider = (body: ChatBody, options: ChatOptions): ProviderName => {
  if (options.provider) return options.provider;
  const role = options.role ?? (hasImage(body.messages) ? 'vision' : 'chat');
  return providerFor(role, options.env);
};

const textOf = (content: ChatMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
        .map((part) => part.text)
        .join('\n');

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * Anthropic & Gemini butuh byte gambar, bukan URL. Data URL dipecah langsung; URL http
 * diambil sekali di sini supaya call-site tak perlu tahu perbedaan itu.
 */
async function inlineImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ mediaType: string; data: string }> {
  const inline = url.match(DATA_URL);
  if (inline) return { mediaType: inline[1], data: inline[2] };
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`image_fetch_${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return {
    mediaType: resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg',
    data: buffer.toString('base64'),
  };
}

async function anthropicBody(body: ChatBody, fetchImpl: typeof fetch): Promise<unknown> {
  const system = body.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n\n');

  const messages = [];
  for (const message of body.messages) {
    if (message.role === 'system') continue;
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text });
      } else {
        const { mediaType, data } = await inlineImage(part.image_url.url, fetchImpl);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
      }
    }
    messages.push({ role: message.role, content: blocks });
  }

  return {
    model: body.model,
    // Wajib di Messages API (OpenAI menganggapnya opsional) — beri plafon yang sama dengan
    // panggilan scout terpanjang supaya tak ada jawaban yang terpotong diam-diam.
    max_tokens: body.max_tokens ?? 4096,
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(system ? { system } : {}),
    messages,
  };
}

async function geminiBody(body: ChatBody, fetchImpl: typeof fetch): Promise<unknown> {
  const system = body.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n\n');

  const contents = [];
  for (const message of body.messages) {
    if (message.role === 'system') continue;
    const parts = [];
    if (typeof message.content === 'string') {
      parts.push({ text: message.content });
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else {
          const { mediaType, data } = await inlineImage(part.image_url.url, fetchImpl);
          parts.push({ inlineData: { mimeType: mediaType, data } });
        }
      }
    }
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }

  return {
    ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.max_tokens === undefined ? {} : { maxOutputTokens: body.max_tokens }),
    },
  };
}

export interface ChatRequest {
  provider: ProviderName;
  family: WireFamily;
  url: string;
  init: RequestInit;
}

/**
 * Terjemahkan body ala-OpenAI ke request provider terpilih. Dipisah dari [`chatCompletion`]
 * supaya pemanggil yang punya wrapper fetch sendiri (mis. timeout OCR) tetap lewat satu
 * terjemahan yang sama.
 */
export async function buildChatRequest(
  body: ChatBody,
  options: ChatOptions = {},
): Promise<ChatRequest> {
  const provider = resolveProvider(body, options);
  const spec = providerSpec(provider);
  const env = options.env ?? process.env;
  const key = providerKey(provider, env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  let url = providerChatUrl(provider, env, body.model);
  let payload: unknown = body;

  if (spec.family === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    payload = await anthropicBody(body, fetchImpl);
  } else if (spec.family === 'gemini') {
    // Key Gemini ikut di query string, bukan header.
    url += `?key=${encodeURIComponent(key)}`;
    payload = await geminiBody(body, fetchImpl);
  } else if (key) {
    // Provider lokal (ollama, vLLM tanpa auth) sengaja dikirim tanpa Authorization.
    headers.Authorization = `Bearer ${key}`;
  }

  return {
    provider,
    family: spec.family,
    url,
    init: { method: 'POST', headers, body: JSON.stringify(payload) },
  };
}

/** Ubah balasan provider jadi bentuk OpenAI (`choices[0].message.content`). */
export function normalizeChatResponse(family: WireFamily, data: any): any {
  if (family === 'openai') return data;
  if (family === 'anthropic') {
    const content = (data?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('');
    return { choices: [{ message: { content } }], _raw: data };
  }
  const content = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => part?.text ?? '')
    .join('');
  return { choices: [{ message: { content } }], _raw: data };
}

/**
 * Panggilan chat/vision ke provider terpilih. Bentuk balasannya sengaja meniru `Response`
 * (`ok`/`status`/`json()`) supaya call-site lama — yang semuanya memeriksa `resp.ok` lalu
 * membaca `choices[0].message.content` — tak perlu diubah selain barisan fetch-nya.
 */
export async function chatCompletion(
  body: ChatBody,
  options: ChatOptions = {},
): Promise<ChatResponse> {
  const request = await buildChatRequest(body, options);
  const fetchImpl = options.fetchImpl ?? fetch;

  let signal = options.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!signal && options.timeoutMs) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
    signal = controller.signal;
  }

  try {
    const response = await fetchImpl(request.url, { ...request.init, signal });
    // Body dibaca sekali di sini: setelah diterjemahkan, `response.json()` asli tak bisa
    // dipanggil ulang oleh call-site.
    const raw = await response.text();
    const parse = () => {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    };
    return {
      ok: response.ok,
      status: response.status,
      provider: request.provider,
      json: async () => normalizeChatResponse(request.family, parse()),
      text: async () => raw,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Isi teks balasan, atau `''` kalau provider mengembalikan sesuatu yang tak terduga. */
export function chatContent(data: any): string {
  return data?.choices?.[0]?.message?.content ?? '';
}

/** Key provider peran ini — call-site memakainya untuk gate "kredensial ada?". */
export function chatKey(role: 'chat' | 'vision' = 'chat', env?: EnvRecord): string {
  return providerKey(providerFor(role, env), env);
}

/** Siap dipakai? Provider lokal tanpa auth (ollama) tetap `true` walau key kosong. */
export function chatReady(role: 'chat' | 'vision' = 'chat', env?: EnvRecord): boolean {
  return providerReady(providerFor(role, env), env);
}
