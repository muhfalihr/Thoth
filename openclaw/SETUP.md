# OpenClaw — Setup untuk Content-Sourcing Thoth

OpenClaw adalah **runtime agent ("Ella")** yang menjelajah sosmed lewat browser login-mu,
merakit **content-set JSON** `{main, footage[], comments[], figures[]}`, lalu menyerahkannya ke
Thoth (`thoth run --content <set.json>`). Dokumen ini fokus **setup sisi OpenClaw**. Untuk *flow
menjalankan* sourcing harian, lihat **[README.md](README.md)**.

> Setup Thoth (Rust/Python) yang umum ada di **[../SETUP.md](../SETUP.md)**. OpenClaw bersifat
> **opsional** — Thoth tetap jalan dengan `thoth run --url <link>` tanpa OpenClaw.

---

## 1. Arsitektur runtime (wajib paham — sumber 90% masalah)

OpenClaw mengekspos **dua service localhost yang berbeda**:

| Service | Port | Apa | Status normal |
|---|---|---|---|
| **Gateway** | `18789` | Otak agent Ella (bridge Telegram / dashboard). Scheduled Task **"OpenClaw Gateway"**. | biasanya **sudah jalan** di background |
| **CDP Browser Relay** | `18792` | Chrome DevTools Protocol ke **Brave login-mu**. Di-host oleh **node host** (`openclaw node run`), bukan gateway/extension. Scheduled Task **"OpenClaw Node"**. | harus **Running** agar script jalan |

**Konsekuensi penting:** semua script `*.js` (discover/search/trace/crop/scrape) memakai **relay 18792**,
BUKAN gateway. Jadi `openclaw status` "Ready" (18789) **tidak menjamin** script jalan — relay 18792
bisa tetap DOWN. Extension Brave "OpenClaw Browser Relay" hanyalah **client**; yang membuka 18792
adalah **node host**.

---

## 2. Prerequisites

1. **OpenClaw** terinstall (produk terpisah; ikuti installer resminya) + CLI `openclaw` ada di PATH.
   Verifikasi: `openclaw status` (gateway), `openclaw node status` (node host).
2. **Node.js 18+** — runtime semua script `*.js`.
   ```powershell
   winget install OpenJS.NodeJS.LTS
   node --version
   ```
3. **Brave browser** dengan extension **"OpenClaw Browser Relay"** terpasang, dan **tab login**
   minimal: `instagram.com` + `tiktok.com` (tambah `x.com`/`facebook.com`/`google.com` sesuai platform).
   Tab harus **dibiarkan terbuka**.
4. **Thoth** sudah ter-build + Python deps (lihat [../SETUP.md](../SETUP.md)).

---

## 3. Menyalakan node host + relay (langkah kritis)

Saat pertama / setelah update OpenClaw, node host sering hilang. Nyalakan:

```powershell
openclaw node status                 # cek Scheduled Task "OpenClaw Node"
# Kalau stopped/missing:
openclaw node run --host 127.0.0.1 --port 18789
```
Run pertama biasanya minta pairing (`PAIRING_REQUIRED` / role upgrade):
```powershell
openclaw devices list                # cari request "Pending" (device-mu, "role upgrade")
openclaw devices approve <requestId> # setujui
openclaw node run --host 127.0.0.1 --port 18789   # ulangi → Brave expose CDP di 18792
```
**Permanen** (survive reboot/update) — daftarkan sebagai service:
```powershell
openclaw node install
openclaw node start
```
> Jika handoff dari `openclaw node run` foreground ke service: **stop foreground dulu** (keduanya tak
> bisa bind 18792 bersamaan). Gateway (18789) bisa ikut "stopped" saat churn approval — restart:
> `openclaw gateway run` atau `schtasks /Run /TN "OpenClaw Gateway"`.

**Verifikasi relay hidup** (dari `~/.openclaw/workspace`):
```powershell
node -e "fetch('http://127.0.0.1:18792/json/version').then(r=>console.log('OK',r.status)).catch(()=>console.log('DOWN'))"
```

---

## 4. Workspace & key files

Runtime ada di **`~/.openclaw/workspace`** (BUKAN folder `openclaw/` di repo Thoth). Isi penting:

| Item | Fungsi |
|---|---|
| `.novita_key` | API key Novita (LLM/vision/embedding) — dipakai script discovery/trace/footage. **JANGAN commit.** |
| `.groq_key` | API key Groq (Whisper fallback saat discovery baca voiceover). **JANGAN commit.** |
| `ig_accounts.json` | Daftar akun IG terkurasi untuk `discover_reels` **dan** daftar exclusion (akun aggregator yang videonya tak boleh jadi main/footage). |
| `output/` | Content-set JSON + `output/crops/*.png` (crop komentar/profil). |
| `skills/` | Skill agent (lihat §5). |
| `AGENTS.md` / `IDENTITY.md` / `SOUL.md` / `USER.md` / `MEMORY.md` / `TOOLS.md` | Persona & memori agent Ella + catatan environment-specific. |
| `*.js` | Script pipeline (mirror dari modul git `openclaw/`, lihat §6). |

> Key disimpan sebagai file teks polos di workspace, **tidak** di-`.gitignore`-repo karena memang
> tidak berada di repo. Jangan pernah menyalin isinya ke file ter-git.

---

## 5. Skills (di `~/.openclaw/workspace/skills/`)

| Skill | Fungsi |
|---|---|
| **content-sourcing** | Temukan & validasi video/post layak di-clip → hand-off URL+metadata ke ingest Thoth. |
| **contentset-lint** | Gerbang terakhir: lint content-set JSON sebelum `thoth run --content` (bentuk URL per platform, field wajib, file `image_path` ada). |
| **trend-scout** | Deteksi tren/topik/hashtag/sound naik daun (YT/X/TikTok/IG/FB) sebelum nge-clip. |
| **distribution-draft** | Susun paket posting (caption/hashtag/jadwal) dari hasil render. DEFAULT = DRAFT (tunggu approval). |
| **engagement-monitor** | Pantau performa konten terbit (views/retention/like/share/komentar) + rekomendasi. |
| **xpoz-setup** / **xpoz-social-search** | (Opsional) MCP Xpoz untuk search real-time X/IG/Reddit. `xpoz-setup` wajib dulu sebelum skill Xpoz lain. |

Skill di-trigger oleh agent Ella sesuai deskripsinya; bisa juga dipakai manual sebagai panduan flow.

---

## 6. Deploy script dari repo → workspace

Script `*.js` adalah **source-of-truth ter-git** di `CLIPPER/openclaw/`. Edit di sana, lalu deploy:

```powershell
cd C:\Users\mfr\Documents\MyTools\CLIPPER\openclaw
node sync.js push      # modul repo → ~/.openclaw/workspace  (deploy)
node sync.js pull      # workspace → modul repo  (tarik hotfix lalu commit)
```
`sync.js` hanya menyalin `*.js` + `ig_accounts.json` + `deprecated/*.js` (key/markdown tidak ikut).

---

## 7. Smoke test (setelah setup)

```powershell
cd ~/.openclaw/workspace
node -e "require('./cdp').listTargets().then(t=>console.log(t.length,'tabs')).catch(e=>console.log('relay down',e.message))"
node discover_reels.js --max-per 2 --hours 48     # harus menghasilkan output/reel_topics.json
```
Lanjut ke flow lengkap di **[README.md](README.md)** (discover_reels → run_pipeline → `thoth run --content`).

---

## 8. Troubleshooting (setup)

| Gejala | Akar | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:18792` di semua script | Node host mati (sering hilang setelah update OpenClaw) | §3: `openclaw node status` → `node start`; kalau task hilang `node install` lalu `start`; kalau minta pairing → `devices list`/`approve`. Klik extension TIDAK menolong kalau node host mati. |
| `openclaw status` Ready tapi script tetap gagal | Gateway hidup ≠ relay hidup | Relay 18792 dihost node host, bukan gateway. Cek §3. |
| `tab X belum ter-attach relay (skip)` | Tab platform itu tak terbuka/login | Buka & login tab platform tsb di Brave, biarkan terbuka. |
| Gateway "stopped" setelah approve device | Churn pairing | `openclaw gateway run` atau `schtasks /Run /TN "OpenClaw Gateway"` (hanya perlu untuk Ella/Telegram, bukan script). |
| `node: command not found` | Node.js belum terpasang/PATH | Install Node.js LTS, buka shell baru. |
| Key error (LLM/vision) di script | `.novita_key`/`.groq_key` kosong/salah | Isi file key di `~/.openclaw/workspace` (bukan di repo). |

Referensi lanjutan: `~/.openclaw/workspace/TOOLS.md` (catatan runtime spesifik mesin), dan
[README.md](README.md) §5–6 (flow & maintenance).
