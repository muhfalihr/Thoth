---
name: skill-creator
description: "Meta-skill: bikin skill baru sesuai pola ECC, untuk DUA sistem — Claude Code (Thoth, di Thoth\\skills\\) dan OpenClaw (Ella, di ~/.openclaw/workspace/skills/). PROACTIVELY activate saat user minta 'bikin skill', 'tambah kemampuan', atau menambah workflow berulang. Memuat template + checklist + perbedaan format kedua sistem."
version: 1.0.0
---

# Skill Creator (pola ECC, dua sistem)

Standarisasi pembuatan skill mengikuti pola ECC: **frontmatter kaya-trigger → When to Use →
How It Works → Steps → Output/Contract → Guardrails → Examples**. Progressive disclosure: SKILL.md
ramping, detail panjang ke file pendamping.

## When to Use This Skill

- User minta menambah skill/kemampuan baru
- Sebuah workflow sudah dilakukan berulang dan layak dikodifikasi (lihat `continuous-learning`)
- Merapikan skill yang sudah ada agar konsisten dengan pola

## Dua target, dua format

| Aspek | **Thoth (Claude Code)** | **Ella (OpenClaw)** |
|---|---|---|
| Lokasi | `Thoth\skills\<name>\SKILL.md` | `~/.openclaw/workspace/skills/<name>/SKILL.md` |
| Frontmatter | `name`, `description` (pakai PROACTIVELY + trigger), `version` | `name`, `description`, `metadata.openclaw.requires {skills,tools,credentials}`, `tags` |
| Tujuan | Bantu develop tool Rust | Automation sosial-media / tugas Ella |
| Tools dirujuk | Read/Edit/Bash/build_cuda.bat | browser `muhfalihr-chrome`, web_search, `xpoz-social-search` |

## Anatomi SKILL.md (sama untuk keduanya)

1. **Frontmatter** — `description` adalah surface paling penting: tulis padat + daftar trigger
   konkret biar auto-aktivasi tepat.
2. **When to Use** — bullet skenario.
3. **How It Works** — mekanisme/aturan inti.
4. **Steps** — langkah berurut.
5. **Output / Contract** — untuk skill Ella, sertakan schema JSON (selaras `AGENTS.md`).
6. **Guardrails / Anti-patterns** — ❌ jangan / ✅ lakukan.
7. **Examples** — minimal 1 contoh dialog/task nyata.

## Steps (bikin skill baru)

1. Tentukan target (Thoth atau Ella) → pilih lokasi & format frontmatter.
2. Tulis `description` dulu (trigger-rich) — ini menentukan kapan skill terpanggil.
3. Isi 7 bagian anatomi. Detail panjang (referensi, script) → file terpisah di folder skill.
4. Untuk Ella: deklarasikan `requires` (skills/tools/credentials) yang benar; jangan klaim tool
   yang `disabled` di config.
5. Untuk Thoth: rujuk konvensi nyata (`thoth-pipeline`, `rust-gpu-ffmpeg`), aturan Windows path.
6. Verifikasi: skill bisa ditemukan & dipahami tanpa konteks tambahan.

## Template (salin)

```markdown
---
name: <kebab-name>
description: "<apa + kapan; daftar trigger konkret>"
# Thoth: version: 1.0.0
# Ella: metadata: { openclaw: { requires: { tools: [...], skills: [...] } } }, tags: [...]
---
# <Judul>
## When to Use
## How It Works
## Steps
## Output / Guardrails
## Examples
```

## Guardrails / Anti-patterns

- ❌ `description` vague ("helper umum") → auto-aktivasi gagal. Harus spesifik + trigger.
- ❌ Skill Ella mengklaim tool yang belum aktif (cek `openclaw.json` dulu).
- ❌ Menaruh skill di lokasi salah (Thoth root vs OpenClaw workspace — beda mesin baca).
- ❌ SKILL.md raksasa → pecah, pakai progressive disclosure.
- ✅ Satu skill = satu tanggung jawab jelas.

## Examples

> "Bikin skill buat Ella riset competitor."
> → target Ella → lokasi `~/.openclaw/workspace/skills/competitor-research/SKILL.md` → frontmatter
> openclaw (requires xpoz + browser) → 7 bagian + schema output JSON → contoh dialog.
