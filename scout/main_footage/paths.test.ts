import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-paths-'));
  try {
    assert.throws(() => resolveContained(root, '../escape.mp4'), /path_outside_root/);
    assert.throws(() => resolveContained(root, 'https://cdn.test/a.mp4'), /artifact_path_must_be_relative/);
    assert.throws(() => resolveContained(root, 'C:\\escape.mp4'), /artifact_path_must_be_relative/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'linked-outside'), 'junction');
    assert.throws(
      () => resolveContained(root, 'linked-outside/future-cut.mp4'),
      /path_outside_root/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-publish-'));
  try {
    const first = path.join(root, 'first.tmp');
    const destination = path.join(root, 'cuts', 'v001', 'cut.mp4');
    fs.writeFileSync(first, 'first');
    atomicPublish(first, destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'first');

    const second = path.join(root, 'second.tmp');
    fs.writeFileSync(second, 'second');
    assert.throws(() => atomicPublish(second, destination), /destination_exists/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'first');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-versions-'));
  try {
    fs.mkdirSync(path.join(root, 'v001'));
    fs.mkdirSync(path.join(root, 'v009'));
    fs.mkdirSync(path.join(root, 'other'));
    assert.equal(nextVersion(root), 'v010');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
