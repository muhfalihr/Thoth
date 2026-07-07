# scout — Setup (sekali per mesin)

`scout/` = layer content-sourcing JS untuk Thoth. Semua script dijalankan **langsung dari
`CLIPPER/scout/`** — tak ada workspace terpisah, tak ada langkah deploy. Setup ini sekali
saja; flow harian ada di **[README.md](README.md)** / **[RUNBOOK.md](RUNBOOK.md)**.

---

## 1. Prasyarat

| Item | Untuk |
|---|---|
| **Node.js LTS** (18+; box ini v24) | menjalankan semua script (`node ...`). `fetch`/`WebSocket` global. |
| **Brave / Chrome / Edge** | managed browser CDP (§2). `lib/browser.ts` auto-deteksi Brave > Chrome > Edge. |
| **Thoth ter-build + Python deps** | render sisi Rust — lihat [../SETUP.md](../SETUP.md). |

Tak ada dependency npm wajib untuk pipeline inti (script pakai Node builtins).
`npm install pg` hanya bila memakai CKB Supabase (§4).

---

## 2. Managed browser (standalone CDP — tanpa extension/pihak-ketiga)

`lib/browser.ts` melaunch Chromium (Brave/Chrome/Edge) dengan `--remote-debugging-port` +
profil khusus (`~/.clipper/browser-profile`), yang natively menyajikan CDP di **port 18800**.
Ini menggantikan segala relay/extension pihak-ketiga.

```powershell
node lib/browser.ts start      # launch + serve CDP di 18800
node lib/browser.ts status     # UP / DOWN
node lib/browser.ts stop
```

Setelah `start`, **login sekali** di window itu ke tab yang dipakai (minimal
**tiktok.com + instagram.com**; tambah x.com / facebook.com / google.com sesuai kebutuhan).
Cookie persisten di profil, jadi login cukup sekali. Biarkan tab-tab itu terbuka.

`lib/cdp.ts` otomatis memakai `http://127.0.0.1:18800` (override via env `THOTH_CDP`).
Verifikasi:
```powershell
node -e "fetch('http://127.0.0.1:18800/json/version').then(r=>console.log('CDP OK',r.status)).catch(()=>console.log('CDP DOWN'))"
```

Env opsional: `THOTH_CDP_PORT`, `THOTH_BROWSER_BIN` (path binary), `THOTH_BROWSER_PROFILE`
(dir profil), `THOTH_BROWSER_HEADLESS`. Lihat header `lib/browser.ts` untuk penjelasan CDP lengkap.

---

## 3. Credential — SATU sumber: `.env` di ROOT repo (TIDAK di-commit)

Semua secret scout dibaca dari **`.env` di root repo** (file yang sama dipakai Thoth Rust)
via `lib/env.ts`. Tak ada lagi key file per-folder:

| Variabel `.env` | Fungsi |
|---|---|
| `THOTH_NOVITA_API_KEY` | API key Novita (LLM/vision/embedding) — discovery/trace/footage. |
| `THOTH_GROQ_API_KEY` | API key Groq (Whisper fallback saat discovery baca voiceover). |
| `THOTH_SUPABASE_URL` | (opsional) CKB Supabase — lihat §4. |

Env asli dari shell menang; `.env` hanya mengisi variabel yang belum ada. **Jangan pernah
menyalin nilainya ke file ter-git.**

`config/ig_accounts.json` (akun IG terkurasi + daftar exclusion aggregator) dan
`config/curator_accounts.json` (kurator TikTok/X) **ter-git** — edit untuk mengganti daftar.

---

## 4. CKB (Cultural Knowledge Base) — opsional

Dipakai `enrich/enrich_context.ts` & `enrich/pulse_harvest.ts` untuk cache referensi/meme/pulse
lintas-mesin di Supabase Postgres:

```powershell
# URL via THOTH_SUPABASE_URL di .env root (§3)
npm install pg
```
Tanpa ini, CKB degrade ke cache lokal-JSON (`ckb.json`) — tetap jalan, tak lintas-mesin.

---

## 5. Smoke test

```powershell
node -e "require('./lib/cdp').listTargets().then(t=>console.log(t.length,'tabs')).catch(e=>console.log('CDP down',e.message))"
node cli.ts discover --max-per 2 --hours 48     # → output/reel_topics.json
```
Semua fitur bisa lewat satu entrypoint: **`node cli.ts`** (tanpa argumen = daftar perintah).
Lanjut ke flow lengkap di **[README.md](README.md)** (discover_reels → run_pipeline → `thoth run --content`).

---

## 6. Troubleshooting (setup)

| Gejala | Akar | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:18800` di semua script | Managed browser belum jalan | `node lib/browser.ts status` → kalau DOWN: `node lib/browser.ts start`. |
| `tab X belum ter-attach (skip)` | Tab platform itu tak terbuka/login | Buka & login tab platform tsb di managed browser, biarkan terbuka. |
| `node: command not found` | Node.js belum terpasang/PATH | Install Node.js LTS, buka shell baru. |
| Key error (LLM/vision) di script | `THOTH_NOVITA_API_KEY`/`THOTH_GROQ_API_KEY` kosong/salah | Isi variabelnya di `.env` root repo (§3). |
| CKB tak lintas-mesin | `pg`/URL Supabase belum diset | §4 — atau abaikan (fallback `ckb.json` lokal). |
