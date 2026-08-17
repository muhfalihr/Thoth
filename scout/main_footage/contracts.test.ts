import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  decodeMainFootageDescriptor,
  decodeMainFootagePlan,
  decodeNarrationTimeline,
  decodeSourcePackage,
  fingerprintCanonical,
} from './contracts.ts';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures/main-footage/contracts');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
}

{
  assert.equal(decodeSourcePackage(fixture('source-package.v1.json')).sources[0]?.id, 'source-0');
  assert.equal(decodeNarrationTimeline(fixture('narration-timeline.v1.json')).words.length, 2);
  assert.equal(decodeMainFootagePlan(fixture('main-footage-plan.v1.json')).timeline.length, 1);
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
      coverage_target: 0.6,
    }),
    {
      mode: 'forced_url_pool',
      package_manifest: 'packages/source-package.json',
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
