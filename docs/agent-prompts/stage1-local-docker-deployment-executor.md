# Stage 1 Local Docker Deployment Executor Prompt

Gunakan prompt berikut setelah implementation plan disetujui. Prompt ini tidak memerlukan
placeholder dan dapat langsung diberikan kepada executor agent.

```text
Anda bekerja di repository CLIPPER pada branch yang memuat spec dan plan Stage 1 local Docker
deployment. Mode kerja: IMPLEMENT_PLAN. Plan sudah disetujui: YA.

Gunakan `superpowers:executing-plans` untuk mengeksekusi plan task-by-task dengan checkpoint review.
Jika environment mendukung subagent dan Anda memilih mendelegasikan task independen, gunakan
`superpowers:subagent-driven-development`; controller tetap wajib memverifikasi setiap hasil sendiri.
Gunakan TDD untuk setiap perubahan behavior atau contract: tulis test, jalankan dan saksikan RED,
buat implementasi minimal, lalu jalankan dan saksikan GREEN.

Authority — baca penuh dan berurutan sebelum mengubah file:

1. `AGENTS.md` dan seluruh instruksi yang dirujuk olehnya.
2. `docs/python-scout-migration-roadmap.md` untuk posisi Stage 1 dan retirement gates.
3. `docs/superpowers/specs/2026-09-03-stage1-local-docker-deployment-design.md` sebagai sumber
   kebenaran architecture, scope, security, persistence, dan acceptance criteria.
4. `docs/superpowers/plans/2026-09-03-stage1-local-docker-deployment.md` sebagai urutan implementasi.
5. `docs/superpowers/specs/2026-09-03-stage1-container-image-ci-design.md` untuk kontrak image yang
   sudah diterbitkan.
6. File kode, workflow, test, dan dokumentasi yang disebut oleh task plan aktif.

Urutan otoritas:

- Instruksi user dan `AGENTS.md` mengatur cara kerja.
- Spec local Docker mengatur hasil yang harus dibangun.
- Implementation plan mengatur urutan TDD, file, commands, dan commits.
- Roadmap mengatur hubungan pekerjaan ini dengan Stage 1 soak dan migrasi Scout.
- Kode saat ini adalah evidence; pertahankan seluruh perubahan user yang tidak terkait.

Preflight wajib:

- Catat branch, HEAD, upstream, dan `git status --short --branch`.
- Jangan lanjut jika ada perubahan user yang bertabrakan dengan file plan; laporkan konflik.
- Pastikan seluruh command dan dokumentasi container lokal menggunakan Docker/Docker Compose.
- Baca plan lengkap sebelum memulai Task 1.
- Jalankan hanya Task 1 sampai Task 4 secara berurutan. Satu task harus mencapai GREEN, focused
  verification, review checkpoint, dan commit sebelum Task berikutnya dimulai.

Deliverable:

- `compose.stage1.local.yml` dengan PostgreSQL, Temporal Server, Temporal UI, API, worker, dan
  private legacy CDP sidecar.
- `.env.stage1.local.example` yang aman dan tanpa secret nyata.
- Git ignore boundary untuk env/evidence lokal.
- Contract tests deployment.
- Offline GitHub Actions `docker compose config` gate.
- `docs/operations/stage1-local-docker.md`.
- `BLUEPRINT.md` dengan status activation/live smoke/soak yang tetap pending.

Non-negotiable runtime contract:

- API, worker, dan CDP memakai satu required `THOTH_IMAGE` dengan format
  `ghcr.io/muhfalihr/thoth@sha256:<64 lowercase hex>`.
- PostgreSQL, Temporal, dan Temporal UI memakai tag-plus-digest persis dari spec.
- API hanya bind `127.0.0.1:8000`; Temporal UI hanya bind `127.0.0.1:8080`.
- PostgreSQL 5432, Temporal 7233, dan CDP 18800 tidak mempunyai host port mapping.
- API, worker, dan CDP berjalan sebagai UID/GID `10001:10001`.
- Worker memakai `temporal:7233`, namespace `thoth-stage1`, private
  `http://legacy-cdp:18800`, dan mode `python_tiktok_with_legacy_fallback`.
- Data root adalah absolute host path di luar repository. Artifacts, browser profile, observations,
  reports, dan PostgreSQL persistence dipisahkan.
- Browser profile tidak pernah masuk evidence, S3, logs, Git, atau laporan akhir.
- Secret dan fixture nyata hanya berada pada `.env.stage1.local` milik operator; jangan membuat,
  membaca, menampilkan, atau meng-commit nilainya selama implementation session.

Hard stop implementation session:

- Jangan menjalankan normal-mode `/opt/thoth/bin/start-legacy-cdp`; launcher membuka TikTok.
- Jangan menjalankan service `legacy-cdp` atau `worker` melalui `docker compose up`.
- Jangan menjalankan fixture TikTok live atau controlled fallback smoke.
- Jangan mengunggah observations/reports ke S3.
- Jangan memulai operational soak, rollback drill, human approval, Task 10, atau perubahan default
  ke mode `python`.
- Jangan push commit, publish image, membuat deployment final, atau mengubah mutable GHCR tag.
- Boleh menjalankan `docker compose config --quiet`; command ini harus memakai
  `.env.stage1.local.example` dan tidak memulai container.

Verification wajib setelah Task 4:

- Deployment contract tests lama dan baru.
- Seluruh Python non-live tests.
- Ruff check dan format check seluruh `python/`.
- `bun --cwd=scout run test:acquisition` dengan bentuk equals persis.
- `docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet`.
- `git diff --check`.
- `graphify update .` jika tersedia.
- Worktree bersih setelah planned commits.

Project instruction meminta prefix `rtk`. Jika `rtk` tidak tersedia di PATH, buktikan sekali lewat
`rtk --version`, lalu jalankan underlying commands secara langsung dan catat fallback tersebut.
Jangan menulis command yang diam-diam tidak menjalankan test.

Review gate:

1. Review fixed-point diff dari HEAD preflight ke final implementation commit terhadap setiap
   acceptance criterion spec.
2. Minta independent standards review untuk Compose security, health semantics, digest pinning,
   persistence, secret boundaries, dan hard stop live.
3. Perbaiki blocking finding melalui TDD dan ulangi review sampai GO.
4. Jangan sebut image sebagai soak candidate. Setelah implementation commit kelak dipush oleh
   operator, GitHub Actions harus menerbitkan digest baru dari exact commit tersebut.

Format laporan akhir:

- Baseline dan final commit.
- Task 1–4 beserta commit checkpoint masing-masing.
- File yang dibuat atau diubah.
- RED/GREEN evidence untuk setiap task.
- Semua verification command yang benar-benar dijalankan dan exit code.
- Acceptance criteria yang terbukti.
- Independent review verdict dan finding tersisa.
- Daftar hard-stop action yang tidak dijalankan.
- Next operator checkpoint: review, push implementation commit, tunggu CI publish, lalu record
  digest baru sebelum deployment lokal atau live gate.
```
