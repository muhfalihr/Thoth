---
name: skill-creator
description: "Meta-skill: bikin skill baru sesuai pola ECC untuk Claude Code (Thoth, di Thoth\\skills\\). PROACTIVELY activate saat user minta 'bikin skill', 'tambah kemampuan', atau menambah workflow berulang. Memuat template + checklist format skill."
version: 1.1.0
---

# Skill Creator (pola ECC)

Standarisasi pembuatan skill mengikuti pola ECC: **frontmatter kaya-trigger → When to Use →
How It Works → Steps → Output/Contract → Guardrails → Examples**. Progressive disclosure: SKILL.md
ramping, detail panjang ke file pendamping.

## When to Use This Skill

- User minta menambah skill/kemampuan baru
- Sebuah workflow sudah dilakukan berulang dan layak dikodifikasi (lihat `continuous-learning`)
- Merapikan skill yang sudah ada agar konsisten dengan pola

## Lokasi & format

- Lokasi: `Thoth\skills\<name>\SKILL.md`
- Frontmatter: `name`, `description` (pakai PROACTIVELY + trigger konkret), `version`
- Tools yang dirujuk: Read/Edit/Bash/`build_cuda.bat` + konvensi nyata repo (`thoth-pipeline`,
  `rust-gpu-ffmpeg`, aturan Windows path)

## Anatomi SKILL.md

1. **Frontmatter** — `description` adalah surface paling penting: tulis padat + daftar trigger
   konkret biar auto-aktivasi tepat.
2. **When to Use** — bullet skenario.
3. **How It Works** — mekanisme/aturan inti.
4. **Steps** — langkah berurut.
5. **Output / Contract** — schema/hasil yang dijanjikan bila relevan.
6. **Guardrails / Anti-patterns** — ❌ jangan / ✅ lakukan.
7. **Examples** — minimal 1 contoh dialog/task nyata.

## Steps (bikin skill baru)

1. Tulis `description` dulu (trigger-rich) — ini menentukan kapan skill terpanggil.
2. Isi 7 bagian anatomi. Detail panjang (referensi, script) → file terpisah di folder skill.
3. Rujuk konvensi nyata repo (pipeline, build, path Windows) — jangan klaim tool yang tak ada.
4. Verifikasi: skill bisa ditemukan & dipahami tanpa konteks tambahan.

## Template (salin)

```markdown
---
name: <kebab-name>
description: "<apa + kapan; daftar trigger konkret>"
version: 1.0.0
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
- ❌ SKILL.md raksasa → pecah, pakai progressive disclosure.
- ✅ Satu skill = satu tanggung jawab jelas.

## Examples

> "Bikin skill buat validasi content-set sebelum thoth run."
> → lokasi `Thoth\skills\contentset-lint\SKILL.md` → frontmatter trigger-rich →
> 7 bagian + schema output JSON → contoh dialog.
