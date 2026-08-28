// scout/lib/llm.test.ts — terjemahan wire protocol lintas provider.
//
// Yang dijaga di sini: call-site scout menulis SATU bentuk (ala OpenAI), dan tiap keluarga
// provider menerima bentuk yang benar-benar dimengertinya. Kalau terjemahan ini meleset,
// gejalanya bukan crash melainkan HTTP 400 dari provider — persis error yang dulu bikin scout
// terkunci ke satu vendor.
import assert from 'node:assert/strict';
import { providerChatUrl } from './env.ts';
import { buildChatRequest, chatCompletion, chatContent, chatReady } from './llm.ts';

const PNG = 'iVBORw0KGgo=';
const IMAGE_MESSAGE = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'apa isi gambar ini?' },
    { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${PNG}` } },
  ],
};
const BODY = {
  model: 'some-model',
  max_tokens: 128,
  temperature: 0.2,
  messages: [
    { role: 'system' as const, content: 'jadilah ringkas' },
    { role: 'user' as const, content: 'halo' },
  ],
};

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

// ── OpenAI family: pass-through ───────────────────────────────────────────────
{
  const request = await buildChatRequest(BODY, {
    env: { THOTH_SCOUT_PROVIDER: 'novita', THOTH_NOVITA_API_KEY: 'nv' },
  });
  assert.equal(request.family, 'openai');
  assert.equal(request.url, providerChatUrl('novita', {}));
  assert.equal((request.init.headers as any).Authorization, 'Bearer nv');
  // Body TIDAK boleh disentuh untuk keluarga ini — pass-through adalah jaminannya.
  assert.deepEqual(bodyOf(request.init), BODY);
  console.log('ok llm_openai_passthrough');
}

// Provider lokal tanpa auth tak boleh mengirim header Authorization kosong (vLLM/ollama menolaknya).
{
  const request = await buildChatRequest(BODY, { env: { THOTH_SCOUT_PROVIDER: 'ollama' } });
  assert.equal(request.url, 'http://localhost:11434/v1/chat/completions');
  assert.ok(!('Authorization' in (request.init.headers as any)));
  assert.equal(chatReady('chat', { THOTH_SCOUT_PROVIDER: 'ollama' }), true);
  console.log('ok llm_local_provider_needs_no_key');
}

// ── Anthropic family ──────────────────────────────────────────────────────────
{
  const request = await buildChatRequest(
    { ...BODY, messages: [BODY.messages[0], IMAGE_MESSAGE] },
    { env: { THOTH_SCOUT_PROVIDER: 'claude', THOTH_CLAUDE_API_KEY: 'ck' } },
  );
  const payload = bodyOf(request.init);
  assert.equal(request.url, providerChatUrl('claude', {}));
  assert.equal((request.init.headers as any)['x-api-key'], 'ck');
  assert.equal((request.init.headers as any)['anthropic-version'], '2023-06-01');
  // system keluar dari `messages` — Messages API menolaknya sebagai role.
  assert.equal(payload.system, 'jadilah ringkas');
  assert.ok(payload.messages.every((m: any) => m.role !== 'system'));
  assert.deepEqual(payload.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  });
  console.log('ok llm_anthropic_translation');
}

// max_tokens wajib di Messages API walau call-site tak mengisinya.
{
  const request = await buildChatRequest(
    { model: 'm', messages: [{ role: 'user', content: 'halo' }] },
    { env: { THOTH_SCOUT_PROVIDER: 'claude', THOTH_CLAUDE_API_KEY: 'ck' } },
  );
  assert.ok(bodyOf(request.init).max_tokens > 0);
  console.log('ok llm_anthropic_max_tokens_default');
}

// ── Gemini family ─────────────────────────────────────────────────────────────
{
  const request = await buildChatRequest(
    { ...BODY, messages: [BODY.messages[0], IMAGE_MESSAGE] },
    { env: { THOTH_SCOUT_PROVIDER: 'gemini', THOTH_GEMINI_API_KEY: 'gk' } },
  );
  const payload = bodyOf(request.init);
  // Model ada di path dan key di query — dua hal yang tak ada di keluarga OpenAI.
  assert.equal(request.url, `${providerChatUrl('gemini', {}, 'some-model')}?key=gk`);
  assert.equal(payload.system_instruction.parts[0].text, 'jadilah ringkas');
  assert.deepEqual(payload.contents[0].parts[1], {
    inlineData: { mimeType: 'image/png', data: PNG },
  });
  assert.equal(payload.generationConfig.maxOutputTokens, 128);
  console.log('ok llm_gemini_translation');
}

// Gambar dari URL http harus diambil dan di-inline: Gemini/Anthropic tak menerima URL apa adanya.
{
  const request = await buildChatRequest(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://cdn.test/a.jpg' } }],
        },
      ],
    },
    {
      env: { THOTH_SCOUT_PROVIDER: 'gemini', THOTH_GEMINI_API_KEY: 'gk' },
      fetchImpl: (async () =>
        new Response(Buffer.from('binary'), {
          headers: { 'content-type': 'image/jpeg' },
        })) as unknown as typeof fetch,
    },
  );
  assert.deepEqual(bodyOf(request.init).contents[0].parts[0], {
    inlineData: { mimeType: 'image/jpeg', data: Buffer.from('binary').toString('base64') },
  });
  console.log('ok llm_remote_image_inlined');
}

// ── Balasan dinormalkan ke bentuk OpenAI ──────────────────────────────────────
{
  const anthropic = await chatCompletion(BODY, {
    env: { THOTH_SCOUT_PROVIDER: 'claude', THOTH_CLAUDE_API_KEY: 'ck' },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'jawaban anthropic' }] }),
      )) as unknown as typeof fetch,
  });
  assert.equal(chatContent(await anthropic.json()), 'jawaban anthropic');

  const gemini = await chatCompletion(BODY, {
    env: { THOTH_SCOUT_PROVIDER: 'gemini', THOTH_GEMINI_API_KEY: 'gk' },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'jawaban gemini' }] } }] }),
      )) as unknown as typeof fetch,
  });
  assert.equal(chatContent(await gemini.json()), 'jawaban gemini');
  console.log('ok llm_response_normalised');
}

// Status gagal tetap terbaca lewat `ok`/`status`, seperti Response asli yang dulu dipakai.
{
  const response = await chatCompletion(BODY, {
    env: { THOTH_SCOUT_PROVIDER: 'novita', THOTH_NOVITA_API_KEY: 'nv' },
    fetchImpl: (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch,
  });
  assert.equal(response.ok, false);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'nope');
  console.log('ok llm_error_status_preserved');
}

// Peran otomatis: pesan bergambar memakai provider vision, pesan teks memakai provider chat.
{
  const env = {
    THOTH_SCOUT_PROVIDER: 'novita',
    THOTH_SCOUT_VISION_PROVIDER: 'openai',
    THOTH_NOVITA_API_KEY: 'nv',
    THOTH_OPENAI_API_KEY: 'ok',
  };
  const vision = await buildChatRequest({ ...BODY, messages: [IMAGE_MESSAGE] }, { env });
  const text = await buildChatRequest(BODY, { env });
  assert.equal(vision.provider, 'openai');
  assert.equal(text.provider, 'novita');
  console.log('ok llm_role_auto_selection');
}
