// extract_figures.js — identify the FIGURE(S) a topic is about (person / organization / community)
// from the main title + description/caption + headline, and write them into the content-set as
// `figures[]`. Thoth can use this for a subject intro card and to ground the narration.
//
//   module: import { figuresFrom } from './extract_figures.ts';
//           await figuresFrom({ title, description, caption, headline })  → [{name,type,role,description}]
//   CLI (content-set): bun extract_figures.js <content_set.json>     → sets set.figures, writes file
//   CLI (test):        bun extract_figures.js --title "..." --desc "..." [--caption] [--headline]
//
// Returns [] when there is no specific notable figure (e.g. an ordinary anonymous person). Uses
// Novita (THOTH_NOVITA_API_KEY via lib/env.js); model via THOTH_LLM_MODEL (default deepseek-v3.1 — discrimination needs a strong text reasoner).

import fs from 'node:fs';

import { chatCompletion, chatKey } from '../lib/llm.ts';
import { ui } from '../lib/ui.ts';
import type { AcquisitionRunContext } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';

const KEY = chatKey();
const MODEL = process.env.THOTH_LLM_MODEL || 'deepseek/deepseek-v3.1'; // text reasoning (diskriminasi tokoh) — reasoner teks, bukan model vision
const TYPES = ['person', 'organization', 'community'];

const PROMPT = ({
  title,
  description,
  caption,
  headline,
}) => `Dari teks topik di bawah, identifikasi TOKOH UTAMA yang sedang DIBICARAKAN: ORANG (nama tokoh),
ORGANISASI, atau KOMUNITAS yang spesifik & dikenal publik.

ATURAN:
- Hanya yang BENAR-BENAR jadi subjek pembahasan (bukan sekadar disebut sekilas / lokasi / brand b-roll).
- JANGAN masukkan akun pengunggah/kurator (mis. akun reels/berita) kecuali dia memang subjeknya.
- Kalau TIDAK ada tokoh/organisasi/komunitas spesifik (mis. cerita tentang orang biasa anonim), kembalikan [].
- "type" salah satu: ${TYPES.join(' | ')}.

TEKS:
[JUDUL]: ${(title || '').slice(0, 200) || '(kosong)'}
[DESKRIPSI/CAPTION]: ${((description || '') + ' ' + (caption || '')).trim().slice(0, 600) || '(kosong)'}
[HEADLINE]: ${(headline || '').slice(0, 200) || '(kosong)'}

Keluarkan HANYA JSON valid: {"figures":[{"name":"","type":"","role":"jabatan/peran singkat","description":"1 kalimat konteks"}]}`;

async function figuresFrom({
  title = '',
  description = '',
  caption = '',
  headline = '',
  key = KEY,
  model = MODEL,
} = {}) {
  if (!key) return [];
  if (!(title || description || caption || headline)) return [];
  let txt = '';
  try {
    const resp = await chatCompletion({
        model,
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: PROMPT({ title, description, caption, headline }) }],
      });
    if (!resp.ok) return [];
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    return [];
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch (e) {
    return [];
  }
  return (Array.isArray(o.figures) ? o.figures : [])
    .map((f) => ({
      name: String(f.name || '').trim(),
      type: TYPES.includes(String(f.type || '').toLowerCase())
        ? String(f.type).toLowerCase()
        : 'person',
      role: String(f.role || '').trim(),
      description: String(f.description || '').trim(),
    }))
    .filter((f) => f.name)
    .slice(0, 5);
}

export { figuresFrom };

export interface FileStageOptions {
  file: string;
}

export async function runExtractFigures(
  options: FileStageOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  void context;
  const { file } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const main = set.main || {};
  // Include footage descriptions — named subjects (people/orgs) often appear there even when the
  // main caption is a teaser. Comments too (sometimes name the subject).
  const footageDesc = (set.footage || [])
    .map((f) => f.description)
    .filter(Boolean)
    .slice(0, 12)
    .join(' | ');
  const desc = ((main.description || '') + ' ' + footageDesc).trim();
  const figures = await figuresFrom({ title: main.title || '', description: desc });
  set.figures = figures;
  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
  console.log(
    `figures (${figures.length}): ${figures.map((f) => `${f.name} [${f.type}]`).join(', ') || '(tak ada tokoh spesifik)'}`,
  );
  console.log('📄 ' + file);
}

export function parseExtractFiguresArgs(argv: string[]): FileStageOptions {
  const file = argv.find(
    (a, i) => !a.startsWith('--') && !['--title', '--desc', '--caption', '--headline'].includes(argv[i - 1]),
  );
  if (!file) throw new Error('no content-set file given');
  if (!fs.existsSync(file)) {
    console.log(ui.red(`${ui.ERR} File tak ada: ${file}`));
    process.exit(1);
  }
  return { file };
}

// ---- CLI ----
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : '';
  };
  const FILE = args.find(
    (a, i) =>
      !a.startsWith('--') &&
      !['--title', '--desc', '--caption', '--headline'].includes(args[i - 1]),
  );
  if (FILE) {
    runAcquisitionCli(async () => {
      const options = parseExtractFiguresArgs(args);
      const context = await createStandaloneAcquisitionContext();
      await runExtractFigures(options, context);
    });
  } else {
    (async () => {
      const input = {
        title: get('--title'),
        description: get('--desc'),
        caption: get('--caption'),
        headline: get('--headline'),
      };
      if (!input.title && !input.description && !input.caption && !input.headline) {
        console.log(
          'Usage: bun extract_figures.ts <content_set.json> | --title "..." --desc "..."',
        );
        process.exit(1);
      }
      console.log(JSON.stringify(await figuresFrom(input), null, 2));
    })();
  }
}
