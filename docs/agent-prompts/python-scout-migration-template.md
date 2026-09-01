# Python Scout Migration Agent Prompt Template

Gunakan template ini untuk mengarahkan agent ke roadmap, specification, dan implementation plan yang benar. Isi semua placeholder dalam kurung siku sebelum mengirim prompt.

## Universal Template

```text
Anda bekerja di repository CLIPPER.

Tujuan sesi:
- Mode kerja: [REVIEW_SPEC | WRITE_PLAN | IMPLEMENT_PLAN | REVIEW_IMPLEMENTATION]
- Tahap roadmap: [nomor dan nama tahap]
- Deliverable sesi: [hasil konkret yang diminta]
- Spec sudah disetujui secara tertulis: [YA | TIDAK]
- Plan sudah disetujui: [YA | TIDAK | BELUM ADA]

Authority — baca dokumen berikut secara penuh dan berurutan sebelum bertindak:
1. `AGENTS.md` dan seluruh instruksi yang dirujuk olehnya.
2. `docs/python-scout-migration-roadmap.md` untuk urutan tahap dan retirement gates.
3. `[PATH_SPEC_AKTIF]` sebagai sumber kebenaran requirement tahap ini.
4. `[PATH_PLAN_AKTIF]` sebagai urutan eksekusi, jika file tersebut sudah ada.
5. File kode dan test yang disebut langsung oleh spec/plan.

Urutan otoritas:
- Instruksi user dan `AGENTS.md` mengatur cara kerja.
- Spec aktif mengatur scope, architecture, behavior, dan acceptance criteria.
- Implementation plan mengatur urutan perubahan untuk merealisasikan spec.
- Roadmap mengatur hubungan tahap ini dengan migrasi keseluruhan.
- Kode saat ini adalah evidence implementasi, bukan alasan untuk mengubah requirement diam-diam.

Jika dokumen bertentangan, sebutkan kutipan/path yang bertentangan dan berhenti sebelum melakukan perubahan yang bergantung pada konflik tersebut.

Scope tetap:
- Migrasi dilakukan per capability dan per platform.
- React dashboard tetap TypeScript.
- Rust tetap menjadi media engine untuk pekerjaan media-heavy.
- Target retirement adalah runtime Bun/TypeScript di `scout/`.
- Interface domain dan artifact tetap typed, versioned, redacted, dan restart-safe.
- Perubahan user yang tidak terkait tetap dipertahankan.

Routing berdasarkan mode:

REVIEW_SPEC
1. Bandingkan seluruh requirement spec dengan roadmap dan kode saat ini.
2. Catat ambiguity, contradiction, missing acceptance gate, atau scope leak.
3. Usulkan perubahan spec yang konkret beserta alasannya.
4. Selesaikan ketika setiap section spec sudah diperiksa dan belum ada requirement yang ambigu.
5. Berhenti sebelum menulis plan atau kode.

WRITE_PLAN
1. Pastikan `Spec sudah disetujui secara tertulis` bernilai YA.
2. Gunakan skill planning yang tersedia dan ikuti instruksinya.
3. Petakan file yang dibuat, diubah, dan diuji beserta tanggung jawab masing-masing.
4. Pecah pekerjaan menjadi task kecil dengan siklus failing test, minimal implementation, verification, dan commit checkpoint.
5. Cantumkan exact commands dan expected result untuk setiap verification step.
6. Simpan plan ke `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
7. Self-review plan terhadap setiap acceptance criterion dalam spec.
8. Selesaikan ketika seluruh requirement spec memiliki task implementasi dan verification yang eksplisit.
9. Berhenti sebelum implementasi dan minta approval plan.

IMPLEMENT_PLAN
1. Pastikan `Plan sudah disetujui` bernilai YA.
2. Baca spec dan plan secara penuh sebelum mengubah kode.
3. Eksekusi hanya task plan yang diminta: [TASK_RANGE].
4. Gunakan TDD untuk feature dan bugfix: failing test, minimal implementation, refactor, verification.
5. Pertahankan interface dan acceptance criteria dari spec.
6. Jalankan focused tests setelah setiap task dan full relevant verification sebelum menyatakan selesai.
7. Catat deviation dari plan; minta keputusan user jika deviation mengubah scope atau architecture.
8. Selesaikan ketika task yang diminta, test, lint/format, dan artifact checks semuanya lulus.

REVIEW_IMPLEMENTATION
1. Review perubahan terhadap fixed point: [COMMIT_OR_BRANCH].
2. Periksa setiap acceptance criterion spec dan setiap task plan yang diklaim selesai.
3. Jalankan verification yang relevan; bedakan hasil yang benar-benar dijalankan dari asumsi.
4. Laporkan finding berdasarkan severity dengan file dan line yang tepat.
5. Selesaikan ketika setiap perubahan dalam diff dan setiap acceptance criterion sudah diperiksa.

Guardrails tahap ini:
[SALIN KEPUTUSAN NON-NEGOTIABLE DARI SPEC AKTIF]

Format laporan akhir:
- Mode dan tahap yang dikerjakan.
- Dokumen authority yang dibaca.
- Task atau section yang selesai.
- File yang dibuat atau diubah.
- Perintah verification yang dijalankan dan hasilnya.
- Acceptance criteria yang terbukti lulus.
- Deviation, risiko tersisa, atau keputusan user yang dibutuhkan.
- Commit yang dibuat, jika workflow mengharuskannya.
```

## Ready-to-Use Prompt: Create the Stage 1 Implementation Plan

Gunakan prompt berikut setelah specification file dianggap sudah direview dan disetujui:

```text
Anda bekerja di repository CLIPPER.

Tujuan sesi:
- Mode kerja: WRITE_PLAN.
- Tahap roadmap: Stage 1 — TikTok Single-Post Acquisition.
- Deliverable: implementation plan rinci untuk rewrite jalur single-post TikTok dari Scout TypeScript ke Python.
- Spec sudah disetujui secara tertulis: YA.
- Plan sudah disetujui: BELUM ADA.

Authority — baca penuh dan berurutan:
1. `AGENTS.md` dan seluruh instruksi yang dirujuk olehnya.
2. `docs/python-scout-migration-roadmap.md`.
3. `docs/superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md`.
4. `docs/superpowers/plans/2026-08-28-python-control-plane-migration.md` sebagai evidence implementasi control plane yang sudah selesai, bukan sebagai plan aktif Stage 1.
5. Implementasi dan test yang berhubungan langsung di `python/src/thoth_control_plane/`, `python/tests/`, dan TikTok acquisition code di `scout/`.

Urutan otoritas:
- Instruksi user dan `AGENTS.md` mengatur cara kerja.
- Spec 2026-08-31 adalah sumber kebenaran scope, architecture, behavior, dan acceptance criteria Stage 1.
- Roadmap mengatur hubungan Stage 1 dengan migrasi keseluruhan.
- Plan control-plane 2026-08-28 hanya menjelaskan seam yang sudah ada.

Gunakan skill planning yang tersedia. Buat plan di:
`docs/superpowers/plans/2026-08-31-python-tiktok-scout-rewrite.md`

Plan harus:
- Memetakan setiap requirement dan acceptance criterion spec ke task implementasi yang eksplisit.
- Menuliskan exact file paths, interface yang dikonsumsi/dihasilkan, test code yang relevan, commands, dan expected results.
- Menggunakan task kecil dengan urutan failing test, minimal implementation, verification, lalu commit checkpoint.
- Mempertahankan Scrapling headless sebagai strategi utama.
- Memanggil TikWM/CDN hanya setelah headless gagal, incomplete, atau media headless gagal dimaterialisasi.
- Menempatkan legacy Scout hanya di workflow seam dan hanya pada mode fallback eksplisit.
- Membatasi platform Stage 1 pada satu public TikTok post URL.
- Mempertahankan React dashboard TypeScript dan Rust media engine.
- Menjaga signed URL, cookies, raw HTML, raw provider response, dan absolute path dari persisted report serta workflow history.
- Mencakup dependency installation, startup capability check, safe URL validation, SSRF-safe materialization, cancellation cleanup, Temporal routing, offline fixtures, parity test, dan opt-in live smoke.
- Memasukkan full Python Ruff/pytest verification serta focused Scout regression yang melindungi legacy fallback.

Self-review plan terhadap seluruh section spec. Selesaikan hanya ketika tidak ada requirement tanpa task, placeholder, type mismatch, atau verification gap.

Jangan mengimplementasikan kode pada sesi ini. Setelah plan selesai, laporkan path plan dan minta approval sebelum eksekusi.

Format laporan akhir:
- Dokumen authority yang dibaca.
- Path plan yang dibuat.
- Daftar task plan.
- Hasil self-review coverage spec.
- Ambiguity atau keputusan user yang masih dibutuhkan.
```

## Ready-to-Use Prompt: Execute an Approved Stage 1 Plan

Gunakan prompt ini hanya setelah plan Stage 1 dibuat dan disetujui:

```text
Anda bekerja di repository CLIPPER.

Tujuan sesi:
- Mode kerja: IMPLEMENT_PLAN.
- Tahap roadmap: Stage 1 — TikTok Single-Post Acquisition.
- Deliverable: eksekusi task [TASK_RANGE] dari implementation plan aktif.
- Spec sudah disetujui secara tertulis: YA.
- Plan sudah disetujui: YA.

Baca penuh dan berurutan:
1. `AGENTS.md` dan seluruh instruksi yang dirujuk olehnya.
2. `docs/python-scout-migration-roadmap.md`.
3. `docs/superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md`.
4. `docs/superpowers/plans/2026-08-31-python-tiktok-scout-rewrite.md`.
5. File kode dan test yang disebut oleh task [TASK_RANGE].

Eksekusi task [TASK_RANGE] persis sesuai plan dengan TDD dan checkpoint verification. Pertahankan scope TikTok single-post, urutan Scrapling headless -> TikWM/CDN -> legacy fallback eksplisit, safe artifact rules, cancellation cleanup, dan typed Temporal contracts.

Jika implementasi membutuhkan perubahan architecture atau requirement di luar plan, hentikan perubahan tersebut dan minta keputusan user dengan menyebutkan section spec/plan yang terdampak.

Selesaikan ketika seluruh step task [TASK_RANGE], focused tests, lint/format yang relevan, dan artifact checks lulus.

Format laporan akhir:
- Task yang selesai.
- File yang dibuat atau diubah.
- Verification command dan hasilnya.
- Acceptance criteria yang terbukti.
- Deviation atau risiko tersisa.
- Commit checkpoint yang dibuat jika diwajibkan plan.
```

## Copy-Paste Prompt: Execute the Complete Stage 1 Plan

Prompt berikut tidak memiliki placeholder dan dapat langsung diberikan kepada agent:

```text
Anda bekerja di repository CLIPPER. Implementasikan Stage 1 migrasi Scout TypeScript ke Python sampai seluruh deterministic acceptance gate lulus.

Gunakan `superpowers:subagent-driven-development` bila tersedia; jika tidak, gunakan `superpowers:executing-plans`. Ikuti workflow skill tersebut task-by-task dengan review checkpoint. Gunakan TDD untuk setiap feature dan bugfix.

Authority — baca penuh dan berurutan sebelum mengubah kode:
1. `AGENTS.md` dan seluruh instruksi yang dirujuk olehnya.
2. `docs/python-scout-migration-roadmap.md`.
3. `docs/superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md`.
4. `docs/superpowers/plans/2026-08-31-python-tiktok-scout-rewrite.md`.
5. File kode dan test yang disebut oleh task plan yang sedang dikerjakan.

Urutan otoritas:
- Instruksi user dan `AGENTS.md` mengatur cara kerja.
- Spec 2026-08-31 mengatur scope, architecture, behavior, dan acceptance criteria.
- Plan 2026-08-31 mengatur urutan implementasi dan verification.
- Roadmap mengatur hubungan Stage 1 dengan migrasi keseluruhan.
- Kode saat ini adalah evidence implementasi; pertahankan perubahan user yang tidak terkait.

Tujuan implementasi:
- Selesaikan Task 1 sampai Task 8 dari plan secara berurutan.
- Scrapling stealthy headless selalu menjadi strategi utama.
- TikWM/CDN hanya berjalan setelah headless gagal, incomplete, blocked, timeout, atau media headless gagal dimaterialisasi.
- Legacy Scout hanya dipanggil dari workflow seam dalam mode fallback eksplisit.
- Scope Python dibatasi pada satu public TikTok post URL.
- React tetap TypeScript dan Rust tetap menjadi media engine.
- Report, Temporal history, event, dan diagnostic tidak menyimpan signed URL, cookie, raw HTML, raw provider response, browser trace, absolute path, atau exception mentah.
- Cancellation menutup browser/HTTP resource dan membersihkan `.part`.
- Ordinary test suite tetap offline dan deterministic.

Cara kerja:
1. Periksa `git status` dan catat perubahan existing sebelum edit. Jaga seluruh perubahan yang tidak termasuk task aktif.
2. Jalankan Task 1 dari failing test sampai focused verification dan checkpoint commit.
3. Review diff Task 1 terhadap spec dan plan.
4. Ulangi siklus yang sama secara berurutan untuk Task 2 sampai Task 8.
5. Prefix seluruh shell command dengan `rtk` sesuai instruksi repo.
6. Jalankan Python command dari `python/`, Scout command dari `scout/`, dan repository audit dari root.
7. Jika implementasi membutuhkan perubahan architecture atau requirement, hentikan perubahan yang terdampak, tunjukkan section spec/plan yang berkonflik, dan minta keputusan user.
8. Jika interface Scrapling 0.4.x berbeda dari contract yang didokumentasikan, kumpulkan evidence dari installed package/docs dan minta perubahan spec/plan sebelum mengubah interface module.

Verification wajib sebelum menyatakan deterministic implementation selesai:
- Dari `python/`: `rtk uv lock --check`.
- Dari `python/`: `rtk uv run ruff check .`.
- Dari `python/`: `rtk uv run ruff format --check .`.
- Dari `python/`: `rtk uv run pytest -q`.
- Dari `scout/`: `rtk bun run typecheck`.
- Dari `scout/`: `rtk bun run test:acquisition`.
- Dari `scout/`: `rtk bun run lint`.
- Dari root: jalankan retirement-seam audit yang tercantum pada Task 8.

Live gate:
- Jika `THOTH_LIVE_TIKTOK_URL` tersedia, instal extra/browser sesuai Task 8 lalu jalankan seluruh live smoke dan same-URL Python/Scout parity test.
- Jika variabel tersebut tidak tersedia, pastikan live tests skip secara eksplisit, selesaikan seluruh deterministic work, dan laporkan Stage 1 sebagai `live gate pending`; jangan klaim migrasi Stage 1 complete.

Completion criteria:
- Task 1–8 mempunyai test-first evidence dan checkpoint review.
- Seluruh deterministic verification command exit 0.
- Final Acceptance Checklist pada plan diperiksa satu per satu.
- Tidak ada produksi FastAPI/request path yang membangun atau menjalankan command Bun.
- Legacy subprocess hanya tersisa pada adapter dan test/docs yang eksplisit.
- Live gate lulus, atau dilaporkan jelas sebagai satu-satunya gate yang pending karena fixture environment tidak tersedia.

Format laporan akhir:
- Task yang selesai dan commit checkpoint masing-masing.
- File yang dibuat atau diubah.
- Verification command yang benar-benar dijalankan beserta hasilnya.
- Acceptance criteria yang terbukti lulus.
- Status live gate dan parity gate.
- Deviation dari plan, risiko tersisa, atau keputusan user yang dibutuhkan.
```
