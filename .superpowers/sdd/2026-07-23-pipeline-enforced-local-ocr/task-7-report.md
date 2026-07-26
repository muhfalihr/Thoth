# Task 7 implementer report

## Status

Complete. The pipeline now requires a current local OCR result after ingest and
before transcription, persists OCR resume identity in `state.json`, invalidates
completed edit output after an OCR rerun, and validates the main context plus all
renderable enrichment videos before narration/edit.

## RED

Tests were added before production changes for:

- legacy state without `stages.ocr`;
- matching and mismatched state/context freshness;
- missing/failed/stale main context;
- edit invalidation after rerun;
- direct-URL default sidecar creation;
- combined main/enrichment preflight.

Command:

```text
rtk cargo test -p thoth-core ocr_is_fresh --no-run
```

Observed failure: exit 1 with 20 compiler errors for the deliberately missing
`OcrStageResult`, `StageResults::ocr`, `ocr_is_fresh`,
`invalidate_after_ocr_rerun`, `persist_ocr_analysis`, and
`preflight_edit_ocr` APIs. This was the expected feature-missing RED.

## GREEN

Implemented:

- serializable `OcrStageResult` and defaulted optional OCR stage state;
- pure state/context freshness checking against source fingerprint, schema,
  configured model, analyzer, analyzed status, coverage, and directives;
- required supervised OCR immediately after ingest;
- atomic application/persistence into an existing or default main context;
- completed edit invalidation only when OCR reruns;
- failed OCR propagation under `local OCR stage failed`, without completed state;
- strict main plus enrichment OCR preflight before narration/edit;
- consistent six-stage progress headers and skip/failure counts.

Fresh focused verification:

```text
rtk cargo test -p thoth-core ocr_state_tests
5 passed, 204 filtered out

rtk cargo test -p thoth-core ocr_pipeline_tests
3 passed, 206 filtered out

rtk cargo test -p thoth-core enrichment::tests::ocr_metadata_preflight
4 passed, 205 filtered out
```

Full verification:

```text
rtk cargo test -p thoth-core
209 passed

rtk git diff --check
exit 0
```

No test invokes Novita, Bun, ingest, transcription, or FFmpeg.

## Self-review

- Reuse is fail-closed: both completed state identity and the persisted main
  context must validate; legacy, missing, malformed, failed, and stale data rerun.
- The adapter only returns analyzed results, and state is assigned only after the
  analyzed context has been atomically saved, so failed attempts are not recorded
  as completed.
- A rerun clears `stages.edit` before the state save; a reused analysis leaves it
  intact.
- Preflight runs before narration can fetch enrichment subtitles and before edit.
  Missing enrichment and image-only enrichment remain valid through the existing
  strict enrichment validator.
- Error messages use stage/context and safe footage index/platform information;
  the unsafe-URL regression confirms private URLs are not surfaced.
- Direct-URL context creation retains default non-OCR grounding fields rather
  than inventing metadata.
- No Task 8 documentation, live smoke, or external service call was added.

## Concerns

None.
