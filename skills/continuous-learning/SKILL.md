---
name: continuous-learning
description: "Ekstrak pola reusable ('instinct') dari sesi kerja Thoth menjadi memory/skill, dengan confidence scoring. PROACTIVELY activate saat: (1) sesi menghasilkan pelajaran berulang (fix yang sama 2x+, konvensi baru, jebakan Windows/CUDA), (2) user bilang 'ingat ini', (3) akhir sesi panjang. Port pola continuous-learning-v2 dari ECC ke konteks Thoth (memory dir + BLUEPRINT/CLAUDE.md). Atomic, project-scoped, confidence-scored."
version: 1.0.0
---

# Continuous Learning (Instinct Capture)

Port ringan dari pola **continuous-learning-v2 / instinct** ECC ke Thoth. Tujuannya: ubah
pelajaran sesi jadi pengetahuan tahan-lama, bukan "mental note" yang hilang tiap sesi.

## When to Use This Skill

- Pola/fix muncul ≥2x dalam sesi (jebakan, workaround, konvensi tak tertulis)
- User bilang "ingat ini" / "jangan ulangi kesalahan tadi"
- Akhir sesi panjang — review apa yang layak disimpan
- Menemukan sesuatu non-obvious tentang build CUDA, FFmpeg Windows, provider, dll.

## How It Works — Konsep Instinct

Sebuah **instinct** = satu pelajaran atomik (bukan dokumen besar), dengan:
- **Trigger** — kapan ini berlaku
- **Action** — apa yang harus dilakukan
- **Evidence** — bukti/contoh dari sesi nyata
- **Confidence** — `low` (1x amatan) · `medium` (2–3x) · `high` (terverifikasi berulang)

### Di mana disimpan (project-scoped → promosi)
1. **Memory Thoth** (`C:\Users\mfr\.claude\projects\C--Users-mfr-Documents-MyTools-Thoth\memory\`)
   — untuk pelajaran lintas-sesi. Satu file = satu instinct, tulis pointer di `MEMORY.md`.
2. **Promosi ke aturan permanen** kalau confidence `high` & berlaku umum:
   - Konvensi pipeline → `CLAUDE.md` / skill `thoth-pipeline`
   - Status fitur → `BLUEPRINT.md`
   - Pola GPU/FFmpeg → skill `rust-gpu-ffmpeg`

## Steps

1. **Deteksi**: apakah ada pola berulang / pelajaran non-trivial di sesi ini?
2. **Rumuskan atomik**: Trigger → Action → Evidence → Confidence.
3. **Cek duplikat**: sudah ada di memory/CLAUDE.md/BLUEPRINT? Kalau ya → update + naikkan confidence.
4. **Simpan** di lokasi yang tepat (lihat di atas).
5. **Promosi** instinct `high`-confidence yang general ke aturan permanen.
6. **Pangkas** instinct yang terbukti salah/usang.

## Format instinct (di memory)

```markdown
---
name: <slug>
description: <ringkas — dipakai saat recall>
metadata: { type: feedback | project }
---
**Trigger:** <kapan berlaku>
**Action:** <lakukan ini>
**Evidence:** <contoh dari sesi/commit>
**Confidence:** low|medium|high
```

## Guardrails / Anti-patterns

- ❌ Simpan yang sudah jelas dari kode/git history/CLAUDE.md → hanya simpan yang non-obvious.
- ❌ Instinct gemuk/multi-topik → pecah jadi atomik.
- ❌ Klaim `high` dari 1x amatan → mulai `low`, naik saat terkonfirmasi ulang.
- ✅ Selalu sertakan Evidence; tanpa bukti = jangan disimpan sebagai fakta.

## Examples

> Sesi: build gagal 2x karena warning kritis CUDA diabaikan.
> → instinct: Trigger="lapor selesai"; Action="wajib build_cuda.bat zero-warning, jangan andalkan
> cargo check"; Evidence="sesi 2026-06-04"; Confidence=medium. Simpan ke memory; kalau berulang,
> promosikan ke `thoth-pipeline`.
