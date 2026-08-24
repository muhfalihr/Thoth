import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decodeMainFootageDescriptor,
  decodeMainFootageActive,
  decodeMainFootagePlan,
  decodeNarrationTimeline,
  decodeSourcePackage,
  fingerprintCanonical,
} from './contracts.ts';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures/main-footage/contracts');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
}

// Production mutation caught: accepting an unversioned, unverified, or escaping active
// pointer would let resume select a partial plan or a path outside the job root.
{
  const active = decodeMainFootageActive({
    schema_version: 1,
    status: 'verified',
    version: 'v001',
    plan_path: 'plans/v001/main-footage-plan.json',
    source_package_fingerprint: 'sha256:package',
    narration_fingerprint: 'sha256:narration',
    plan_fingerprint: 'sha256:plan',
  });
  assert.equal(active.version, 'v001');
  assert.throws(
    () => decodeMainFootageActive({ ...active, status: 'pending' }),
    /status is invalid/,
  );
  assert.throws(
    () => decodeMainFootageActive({ ...active, plan_path: '../partial.json' }),
    /path_outside_root/,
  );
  assert.throws(
    () => decodeMainFootageActive({ ...active, plan_path: 'plans/v002/main-footage-plan.json' }),
    /plan_path does not match version/,
  );
  assert.throws(
    () => decodeMainFootageActive({ ...active, plan_fingerprint: 'md5:not-sha256' }),
    /SHA-256 identity/,
  );
}

// Production mutation caught: omitting or weakening the verified status on a plan would
// allow Task 11 to mistake a structurally decoded partial plan for a durable artifact.
{
  const plan = fixture('main-footage-plan.v1.json') as Record<string, unknown>;
  assert.equal(decodeMainFootagePlan({ ...plan, status: 'verified' }).status, 'verified');
  const { status: _status, ...withoutStatus } = plan;
  assert.throws(() => decodeMainFootagePlan(withoutStatus), /status is invalid/);
  assert.throws(() => decodeMainFootagePlan({ ...plan, status: 'pending' }), /status is invalid/);
}

{
  assert.equal(decodeSourcePackage(fixture('source-package.v1.json')).sources[0]?.id, 'source-0');
  assert.equal(decodeNarrationTimeline(fixture('narration-timeline.v1.json')).words.length, 2);
  assert.equal(decodeMainFootagePlan(fixture('main-footage-plan.v1.json')).timeline.length, 1);
}

// External b-roll is part of the primary planned timeline, but it must remain
// distinguishable from forced-post footage so both runtimes compute coverage identically.
{
  const base = fixture('main-footage-plan.v1.json') as Record<string, any>;
  const decoded = decodeMainFootagePlan({
    ...base,
    timeline: [{ ...base.timeline[0], asset_kind: 'external_cut' }],
  });
  assert.equal(decoded.timeline[0]?.asset_kind, 'external_cut');
  assert.throws(
    () => decodeMainFootagePlan({
      ...base,
      timeline: [{ ...base.timeline[0], asset_kind: 'remote_cut' }],
    }),
    /asset_kind is invalid/,
  );
}

// External cuts are durable only when the plan binds both halves of the immutable
// registry identity; accepting one without the other makes resume ambiguous.
{
  const base = fixture('main-footage-plan.v1.json') as Record<string, unknown>;
  const decoded = decodeMainFootagePlan({
    ...base,
    external_sources_path: 'main-footage/external-footage/v001/manifest.json',
    external_sources_fingerprint: 'sha256:external-manifest',
  });
  assert.equal(decoded.external_sources_path, 'main-footage/external-footage/v001/manifest.json');
  assert.equal(decoded.external_sources_fingerprint, 'sha256:external-manifest');
  assert.throws(
    () => decodeMainFootagePlan({
      ...base,
      external_sources_path: 'main-footage/external-footage/v001/manifest.json',
    }),
    /external sources identity is incomplete/,
  );
}

{
  assert.throws(() => decodeMainFootagePlan({ schema_version: 2 }), /unsupported schema_version/);
  assert.throws(
    () => decodeMainFootagePlan({ ...fixture('main-footage-plan.v1.json') as object, main_coverage_target: 0.59 }),
    /main_coverage_target/,
  );
  assert.throws(
    () => decodeNarrationTimeline({ ...fixture('narration-timeline.v1.json') as object, duration_sec: Number.NaN }),
    /duration_sec/,
  );
  assert.throws(
    () => decodeSourcePackage({ ...fixture('source-package.v1.json') as object, sources: [
      { ...((fixture('source-package.v1.json') as any).sources[0]) },
      { ...((fixture('source-package.v1.json') as any).sources[0]) },
    ] }),
    /duplicate source id/,
  );
}

{
  assert.deepEqual(
    decodeMainFootageDescriptor({
      mode: 'forced_url_pool',
      package_manifest: 'packages/source-package.json',
      external_sources_manifest: 'external-footage/v001/manifest.json',
      coverage_target: 0.6,
    }),
    {
      mode: 'forced_url_pool',
      package_manifest: 'packages/source-package.json',
      external_sources_manifest: 'external-footage/v001/manifest.json',
      coverage_target: 0.6,
    },
  );
  assert.throws(
    () => decodeMainFootageDescriptor({
      mode: 'forced', package_manifest: 'packages/source-package.json', coverage_target: 0.6,
    }),
    /mode is invalid/,
  );
  assert.throws(
    () => decodeMainFootageDescriptor({
      mode: 'forced_url_pool',
      package_manifest: 'packages/source-package.json',
      coverage_target: 0.6,
      source_package_path: 'sources.json',
    }),
    /unexpected main_footage field/,
  );
}

{
  assert.equal(fingerprintCanonical({ b: 2, a: 1 }), fingerprintCanonical({ a: 1, b: 2 }));
  assert.notEqual(fingerprintCanonical({ a: [1, 2] }), fingerprintCanonical({ a: [2, 1] }));
}

// Narration beats mirror crates/thoth-types/src/main_footage.rs: contiguous, unique ids,
// starting at 0, and deliberately excluded from the narration fingerprint projection.
{
  const base = fixture('narration-timeline.v1.json') as Record<string, unknown>;
  const beats = [
    { id: 'beat-1', start_sec: 0, end_sec: 0.5, text: 'Hello' },
    { id: 'beat-2', start_sec: 0.5, end_sec: 1, text: 'world' },
  ];

  const decoded = decodeNarrationTimeline({ ...base, beats });
  assert.deepEqual(decoded.beats, beats);
  assert.equal(decodeNarrationTimeline(base).beats, undefined);
  assert.equal(
    fingerprintCanonical({ ...base, beats }),
    fingerprintCanonical(base),
    'beats must not change the narration fingerprint',
  );

  assert.throws(
    () => decodeNarrationTimeline({ ...base, beats: [beats[0], { ...beats[1], id: 'beat-1' }] }),
    /duplicate beat id/,
  );

  // beat.text mirrors Rust's `String`: empty is legal, absent or non-string is not.
  const silent = [beats[0], { ...beats[1], text: '' }];
  assert.deepEqual(decodeNarrationTimeline({ ...base, beats: silent }).beats, silent);
  assert.throws(
    () => decodeNarrationTimeline({ ...base, beats: [beats[0], { ...beats[1], text: 7 }] }),
    /beat.text must be a string/,
  );
  assert.throws(
    () => decodeNarrationTimeline({ ...base, beats: [{ ...beats[0], start_sec: 0.1 }] }),
    /beats must start at 0/,
  );
  assert.throws(
    () => decodeNarrationTimeline({ ...base, beats: [beats[0], { ...beats[1], start_sec: 0.7 }] }),
    /beats must be contiguous/,
  );
  assert.throws(
    () => decodeNarrationTimeline({ ...base, beats: [{ ...beats[0], end_sec: 0 }] }),
    /beat has an invalid time range/,
  );
}

// Production mutation caught: the Rust decoder is `deny_unknown_fields`, so a field Scout
// starts (or stops) emitting is a silent cross-runtime break. The Rust suite decodes this
// exact file; this block pins the other half of the contract — that the committed bytes are
// still what Scout itself accepts, and that both runtimes derive the same fingerprint from
// them. If Scout's package shape moves, re-capture the fixture instead of editing it by hand.
{
  const shared = path.resolve(
    import.meta.dirname,
    '../../crates/thoth-core/tests/fixtures/scout_package/main-footage/v001/package.json',
  );
  const raw = JSON.parse(readFileSync(shared, 'utf8')) as Record<string, unknown>;
  const pkg = decodeSourcePackage(raw);
  assert.equal(
    pkg.fingerprint,
    fingerprintCanonical(raw),
    'the captured package must still fingerprint to its own declared value',
  );
  assert.ok(pkg.sources.length > 0, 'the shared fixture must carry a usable source');
  assert.ok(pkg.scene_indexes.length > 0, 'the shared fixture must carry a scene index');
  assert.ok(pkg.ignored.length > 0, 'the shared fixture must keep a non-video outcome');
}

// Cross-runtime mutation caught: dropping NFC normalization in either runtime
// makes canonically equivalent narration words disagree at the planner gate.
{
  const unicode = fixture('narration-unicode-equivalence.v1.json') as {
    composed: unknown;
    decomposed: unknown;
  };
  assert.equal(
    fingerprintCanonical(unicode.composed),
    fingerprintCanonical(unicode.decomposed),
    'composed and decomposed narration text must share one fingerprint',
  );
}
