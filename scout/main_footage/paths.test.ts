import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'bun:test';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';

test('rejects escaped and remote artifact paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-paths-'));
  try {
    assert.throws(() => resolveContained(root, '../escape.mp4'), /path_outside_root/);
    assert.throws(() => resolveContained(root, 'https://cdn.test/a.mp4'), /artifact_path_must_be_relative/);
    assert.throws(() => resolveContained(root, 'C:\\escape.mp4'), /artifact_path_must_be_relative/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomically publishes a new file without overwriting a destination', () => {
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
});

test('allocates monotonically increasing three-digit versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-footage-versions-'));
  try {
    fs.mkdirSync(path.join(root, 'v001'));
    fs.mkdirSync(path.join(root, 'v009'));
    fs.mkdirSync(path.join(root, 'other'));
    assert.equal(nextVersion(root), 'v010');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
