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
  try { raw = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) { return; } // tanpa .env → murni shell env
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

export { ENV_FILE, get, novitaKey, groqKey, supabaseUrl };
