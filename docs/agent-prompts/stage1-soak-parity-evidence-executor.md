# Stage 1 Parity Evidence Executor

Read `AGENTS.md` and its references, `docs/operations/stage1-local-docker.md`,
`docs/operations/stage1-parity-sampling.md`, the Contract parity section of
`docs/superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md`, and the observation and
evaluator contracts in `docs/superpowers/specs/2026-09-02-python-tiktok-stage1-cutover-design.md`.
Inspect `python/tests/live/test_tiktok_acquisition_live.py` and
`python/src/thoth_control_plane/operations/tiktok_soak.py` before implementation.

Resolve the operational parity evidence gap using the existing same-URL Python/Scout definition.
The nine normalized fields are authoritative. Checksums validate each local artifact independently;
cross-provider byte equality is not required. Do not redesign the retirement criteria.

First record current Git state. Verify the active window's digest and evaluated implementation
commit from restricted release evidence without printing secrets. Preserve that deployment.
Historical reports mention `c9188900...` and `e1ecf07`; these are pointers to verify, not complete
identifiers to invent or substitute into commands. A newer host HEAD is not the deployed release.

Implement an offline host-side comparison helper if no equivalent already exists. It must consume
the actual Python workflow report and a separately captured Scout report with explicit artifact
roots. Reuse or faithfully extract the established normalization contract. Validate schema and
artifact containment, MP4 signature/size, byte count, and checksum independently. Reject missing
evidence. Produce safe per-field booleans and a pass/fail result without metadata, URLs, checksums,
paths, payloads, or raw exception text in console output. Test matches, mismatches, malformed
reports, missing files, path escapes, invalid integrity, and differing valid media encodings offline.
Do not run acquisition, edit observations, or label samples through that comparison command.

Document exact commands for invoking the helper and capturing an isolated Scout reference with
the pinned image on the existing private Docker network. Inspect the real image/CLI contracts
before writing commands. Keep the current worker mode and deployed services intact. Validate
command construction without contacting TikTok. Do not run the latest checkout's direct-activity
pytest test and claim it produced durable soak observations.

Return a concrete operator handoff for five fresh, separately identified pairs, with a restricted
pairing record that binds actual workflow, reference, timestamps, digest, evaluated commit, and
artifact-validation evidence. Explain how to update one existing observation only after the paired
evidence is verified. Preserve failures and originals; do not double-count reference runs or rewrite
routes. Report sample counts as pending until actual acquisition evidence exists.

This implementation task authorizes local helper code, offline tests, and documentation. Live
reference acquisition and restricted dataset updates remain explicit operator steps. Do not
redeploy, push, restart the active window, upload to S3, run a rollback drill, record human approval,
or execute Task 10. Report changed files, checks actually run, remaining operational steps, and any
missing evidence. A helper passing tests does not mean the five parity samples have passed.
