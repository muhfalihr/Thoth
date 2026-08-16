import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SourceVideoV1 } from './contracts.ts';
import type { SceneIndexDeps, TranscriptSegment, VisionDescription } from './scene_index.ts';
import { indexSource, SCENE_MERGE_TOLERANCE_SEC } from './scene_index.ts';

const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-index-'));
const sourceBytes = Buffer.from('immutable published source bytes');
const sourcePath = path.join(packageRoot, 'sources', 'source-1.mp4');
fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
fs.writeFileSync(sourcePath, sourceBytes);

function makeSource(overrides: Partial<SourceVideoV1> = {}): SourceVideoV1 {
  return {
    id: 'source-1',
    media_index: 0,
    path: 'sources/source-1.mp4',
    checksum: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
    technical: {
      container: 'mp4',
      video_codec: 'h264',
      duration_sec: 30,
      width: 1080,
      height: 1920,
      has_audio: true,
    },
    ...overrides,
  };
}

function makeFrame(label: string, tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-frame-fixture-'));
  const file = path.join(dir, `${label}.jpg`);
  fs.writeFileSync(file, Buffer.from(`frame:${tag}:${label}:${Math.random()}`));
  return file;
}

const transcript: TranscriptSegment[] = [
  { text: 'pedagang buah keliling', start_sec: 1, end_sec: 4 },
  { text: 'harga naik drastis', start_sec: 20, end_sec: 23 },
];

const vision: VisionDescription = {
  subject: 'street vendor',
  action: 'pushing a cart',
  setting: 'urban sidewalk',
  composition: 'medium shot',
  motion: 'slow walk',
  topic: 'street vendor economics',
};

function makeDeps(overrides: Partial<SceneIndexDeps> & { calls?: Record<string, number> } = {}) {
  const calls = overrides.calls ?? {
    detectScenes: 0,
    extractFrames: 0,
    transcribe: 0,
    describeWithVision: 0,
    embed: 0,
    measureVisuals: 0,
  };
  const deps: SceneIndexDeps = {
    analyzerIdentity: 'test-analyzer@1',
    detectScenes: async () => {
      calls.detectScenes += 1;
      return [5, 25];
    },
    extractFrames: async (_source, atSeconds) => {
      calls.extractFrames += 1;
      return atSeconds.map((t) => makeFrame(`t${t}`, 'frame'));
    },
    transcribe: async () => {
      calls.transcribe += 1;
      return transcript;
    },
    describeWithVision: async () => {
      calls.describeWithVision += 1;
      return vision;
    },
    embed: async (text) => {
      calls.embed += 1;
      return text ? [text.length, 0.5, 0.25] : null;
    },
    measureVisuals: async () => {
      calls.measureVisuals += 1;
      return { motion_score: 0.4, brightness: 0.6, scene_change_score: 0.4 };
    },
    ...overrides,
  };
  return { deps, calls };
}

try {
  // --- boundaries ordered, within duration, short gaps merged -------------------------------
  {
    const source = makeSource();
    const { deps } = makeDeps({
      detectScenes: async () => [5, 5.4, 12, 12.3, 29.5], // 5.4/12.3 too close to a neighbor; 29.5 too close to duration(30)
    });
    const index = await indexSource(source, packageRoot, deps);
    const bounds = [0, ...index.scenes.map((s) => s.end_sec)];
    for (let i = 1; i < bounds.length; i += 1)
      assert.ok(bounds[i]! > bounds[i - 1]!, 'boundaries must be strictly ordered');
    assert.ok(
      index.scenes.every((s) => s.start_sec >= 0 && s.end_sec <= 30),
      'scenes must stay within source duration',
    );
    assert.deepEqual(
      index.scenes.map((s) => [s.start_sec, s.end_sec]),
      [
        [0, 5],
        [5, 12],
        [12, 30],
      ],
      'scenes shorter than the merge tolerance fold into a neighbor, including a trailing short scene',
    );
    assert.ok(
      30 - 12 >= SCENE_MERGE_TOLERANCE_SEC,
      'sanity: the surviving final scene is not itself sub-tolerance',
    );
  }

  // --- start/middle/end frames are relative package paths + representative_frame is the mid one
  {
    const source = makeSource();
    const { deps } = makeDeps({ analyzerIdentity: 'frames-analyzer@1' });
    const index = await indexSource(source, packageRoot, deps);
    for (const scene of index.scenes) {
      assert.ok(!path.isAbsolute(scene.representative_frame));
      assert.ok(scene.representative_frame.startsWith('scene-index/'));
      assert.ok(fs.existsSync(path.join(packageRoot, scene.representative_frame)));
      assert.ok(scene.representative_frame.endsWith('-mid.jpg'));
      const startFrame = scene.representative_frame.replace('-mid.jpg', '-start.jpg');
      const endFrame = scene.representative_frame.replace('-mid.jpg', '-end.jpg');
      assert.ok(!path.isAbsolute(startFrame) && !path.isAbsolute(endFrame));
      assert.ok(
        fs.existsSync(path.join(packageRoot, startFrame)),
        'start frame must be persisted too',
      );
      assert.ok(fs.existsSync(path.join(packageRoot, endFrame)), 'end frame must be persisted too');
    }
  }

  // --- transcript spans associate by temporal overlap ---------------------------------------
  {
    const source = makeSource();
    const { deps } = makeDeps({
      analyzerIdentity: 'transcript-analyzer@1',
      detectScenes: async () => [10],
    });
    const index = await indexSource(source, packageRoot, deps);
    assert.equal(index.scenes.length, 2);
    assert.ok(index.scenes[0]!.transcript_evidence.includes('pedagang buah keliling'));
    assert.ok(!index.scenes[0]!.transcript_evidence.includes('harga naik'));
    assert.ok(index.scenes[1]!.transcript_evidence.includes('harga naik drastis'));
  }

  // --- Vision success stores subject/action/setting/composition/motion/topic ----------------
  {
    const source = makeSource();
    const { deps } = makeDeps({ analyzerIdentity: 'vision-success-analyzer@1' });
    const index = await indexSource(source, packageRoot, deps);
    assert.equal(index.planning_mode, 'vision');
    for (const scene of index.scenes) {
      assert.ok(scene.vision_description, 'vision_description must be present on success');
      const parsed = JSON.parse(scene.vision_description!);
      for (const key of ['subject', 'action', 'setting', 'composition', 'motion', 'topic']) {
        assert.equal(typeof parsed[key], 'string');
        assert.ok(parsed[key].length > 0);
      }
      assert.ok(scene.embedding_path, 'evidence embedding must be persisted');
      assert.ok(!path.isAbsolute(scene.embedding_path!));
      assert.ok(fs.existsSync(path.join(packageRoot, scene.embedding_path!)));
    }
  }

  // --- Vision exception degrades the index but keeps every other analysis -------------------
  {
    const source = makeSource();
    let visionCalls = 0;
    const { deps } = makeDeps({
      analyzerIdentity: 'vision-degraded-analyzer@1',
      describeWithVision: async () => {
        visionCalls += 1;
        throw new Error('vision_unavailable');
      },
    });
    const index = await indexSource(source, packageRoot, deps);
    assert.equal(
      index.planning_mode,
      'degraded',
      'a Vision failure degrades planning_mode, never discards the source',
    );
    assert.ok(visionCalls > 0);
    assert.equal(index.scenes.length, 3, 'every scene is still produced');
    for (const scene of index.scenes) {
      assert.equal(scene.vision_description, undefined);
      assert.ok(scene.transcript_evidence.length > 0, 'transcript/caption evidence still persists');
      assert.ok(
        scene.visual_metrics.motion_score >= 0 &&
          scene.visual_metrics.brightness >= 0 &&
          scene.visual_metrics.scene_change_score >= 0,
        'local visual metrics (luminance/color/sharpness/optical-flow proxy) still persist',
      );
    }
    // At least the scene overlapping real transcript text still gets an evidence embedding
    // even though its Vision topic is unavailable.
    assert.ok(index.scenes.some((scene) => scene.embedding_path));
  }

  // --- unchanged fingerprint reuses the index; changed bytes or analyzer identity rebuilds it
  {
    const source = makeSource({
      id: 'source-cache',
      checksum: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
    });
    fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, source.path), sourceBytes);

    const { deps, calls } = makeDeps({ analyzerIdentity: 'cache-analyzer@1' });
    const first = await indexSource(source, packageRoot, deps);
    assert.equal(calls.detectScenes, 1);

    const second = await indexSource(source, packageRoot, deps);
    assert.deepEqual(
      second,
      first,
      'an unchanged fingerprint returns the exact same persisted index',
    );
    assert.equal(calls.detectScenes, 1, 'a cache hit must not call detectScenes again');
    assert.equal(calls.describeWithVision, 3, 'a cache hit must not call Vision again');

    const rebuiltBytesSource = makeSource({
      id: 'source-cache',
      checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000ff',
    });
    const { deps: depsForBytes, calls: callsForBytes } = makeDeps({
      analyzerIdentity: 'cache-analyzer@1',
    });
    await indexSource(rebuiltBytesSource, packageRoot, depsForBytes);
    assert.equal(callsForBytes.detectScenes, 1, 'a changed source checksum forces a rebuild');

    const { deps: depsForIdentity, calls: callsForIdentity } = makeDeps({
      analyzerIdentity: 'cache-analyzer@2',
    });
    await indexSource(source, packageRoot, depsForIdentity);
    assert.equal(callsForIdentity.detectScenes, 1, 'a changed analyzer identity forces a rebuild');
  }

  console.log('ok scene_index');
} finally {
  fs.rmSync(packageRoot, { recursive: true, force: true });
}
