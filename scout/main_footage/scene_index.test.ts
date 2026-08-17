import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SourceVideoV1 } from './contracts.ts';
import type { SceneIndexDeps, TranscriptSegment, VisionDescription } from './scene_index.ts';
import {
  detectScenesWithFfmpeg,
  extractFramesWithFfmpeg,
  indexSource,
  SCENE_MERGE_TOLERANCE_SEC,
  withVisionBudget,
} from './scene_index.ts';

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

/** Byte-identical across runs for the same label — lets two indexes differ only in content. */
function makeFixedFrame(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-frame-fixed-'));
  const file = path.join(dir, `${label}.jpg`);
  fs.writeFileSync(file, Buffer.from(`fixed-frame:${label}`));
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
    const index = await indexSource(source, packageRoot, deps, 'caption dari postingan asli');
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
    // Ruling J: EVERY scene keeps an embedding when Vision is down — a scene without one is
    // unrankable downstream, i.e. functionally discarded. `some` would pass on one lucky scene.
    assert.ok(
      index.scenes.every((scene) => scene.embedding_path),
      'every degraded scene must still carry an embedding',
    );
  }

  // --- Ruling J: embedding evidence is vision + transcript + caption, in that fixed order ----
  {
    const source = makeSource();
    const embedInputs: string[] = [];
    const { deps } = makeDeps({
      analyzerIdentity: 'embed-order-analyzer@1',
      detectScenes: async () => [10],
      embed: async (text) => {
        embedInputs.push(text);
        return [text.length];
      },
    });
    await indexSource(source, packageRoot, deps, 'caption asli');
    assert.equal(
      embedInputs[0],
      'street vendor pushing a cart urban sidewalk medium shot slow walk street vendor economics' +
        ' pedagang buah keliling caption asli',
      'embedding input concatenates vision, then overlapping transcript, then source caption',
    );
  }

  // --- Ruling J: caption alone keeps every scene embeddable when Vision AND transcript are gone
  {
    const source = makeSource();
    const { deps } = makeDeps({
      analyzerIdentity: 'caption-only-analyzer@1',
      transcribe: async () => [],
      describeWithVision: async () => {
        throw new Error('vision_unavailable');
      },
    });
    const index = await indexSource(source, packageRoot, deps, 'judul dan caption postingan');
    assert.equal(index.planning_mode, 'degraded');
    assert.ok(
      index.scenes.length > 0 && index.scenes.every((scene) => scene.embedding_path),
      'the source-level caption alone must keep every scene embeddable',
    );
  }

  // --- Ruling J: only an entirely empty evidence set may omit the embedding ------------------
  {
    const source = makeSource();
    const { deps } = makeDeps({
      analyzerIdentity: 'no-evidence-analyzer@1',
      transcribe: async () => [],
      describeWithVision: async () => {
        throw new Error('vision_unavailable');
      },
    });
    const index = await indexSource(source, packageRoot, deps, '');
    assert.equal(index.planning_mode, 'degraded');
    assert.ok(
      index.scenes.every((scene) => scene.embedding_path === undefined),
      'with no vision, no transcript and no caption there is nothing to embed',
    );
  }

  // --- M10: a source shorter than the merge tolerance still yields one whole-source scene ----
  {
    const source = makeSource({
      id: 'source-tiny',
      technical: { ...makeSource().technical, duration_sec: 0.5 },
    });
    fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
    const { deps } = makeDeps({
      analyzerIdentity: 'tiny-analyzer@1',
      detectScenes: async () => [],
    });
    const index = await indexSource(source, packageRoot, deps, 'caption');
    assert.deepEqual(
      index.scenes.map((scene) => [scene.start_sec, scene.end_sec]),
      [[0, 0.5]],
      'a sub-tolerance source spans one scene, never zero',
    );
  }

  // --- I4: the index checksum covers planning_mode and vision text, not just frame bytes -----
  {
    const source = makeSource({ id: 'source-checksum' });
    fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, source.path), sourceBytes);
    const fixedFrames = {
      detectScenes: async () => [10],
      extractFrames: async (_source: string, atSeconds: number[]) =>
        atSeconds.map((t) => makeFixedFrame(`t${t}`)),
      transcribe: async () => [],
      embed: async () => null,
    };
    const { deps: visionDeps } = makeDeps({
      analyzerIdentity: 'checksum-vision@1',
      ...fixedFrames,
    });
    const { deps: degradedDeps } = makeDeps({
      analyzerIdentity: 'checksum-degraded@1',
      ...fixedFrames,
      describeWithVision: async () => {
        throw new Error('vision_unavailable');
      },
    });
    const visionIndex = await indexSource(source, packageRoot, visionDeps, '');
    const degradedIndex = await indexSource(source, packageRoot, degradedDeps, '');
    assert.equal(visionIndex.planning_mode, 'vision');
    assert.equal(degradedIndex.planning_mode, 'degraded');
    assert.notEqual(
      visionIndex.checksum,
      degradedIndex.checksum,
      'identical frame bytes must not hash identically across a vision/degraded difference',
    );
  }

  // --- I4b: each of the five checksummed content fields is independently load-bearing -------
  // Builds one real index, then tampers with exactly ONE field in the persisted index.json
  // (leaving the stored `checksum` untouched, i.e. now stale) and re-runs indexSource with
  // the same source + analyzer identity. If that field is actually part of the checksum
  // input, the on-disk value no longer matches the recomputed checksum, the generation is
  // rejected as untrustworthy, and a rebuild happens (detectScenes is called again). If the
  // field were silently dropped from the checksum, the tampered generation would pass
  // verification and be served as a cache hit instead (detectScenes never called again) —
  // exactly the stale-cache failure mode the checksum exists to prevent.
  {
    const checksumFieldCases: Array<{
      label: string;
      mutate: (parsed: { planning_mode: string; scenes: any[] }) => void;
    }> = [
      {
        label: 'planning_mode',
        mutate: (parsed) => {
          parsed.planning_mode = parsed.planning_mode === 'vision' ? 'degraded' : 'vision';
        },
      },
      {
        label: 'scene boundaries',
        mutate: (parsed) => {
          parsed.scenes[0].end_sec = parsed.scenes[0].end_sec + 1;
        },
      },
      {
        label: 'transcript_evidence',
        mutate: (parsed) => {
          parsed.scenes[0].transcript_evidence = 'tampered transcript text';
        },
      },
      {
        label: 'vision_description',
        mutate: (parsed) => {
          parsed.scenes[0].vision_description = 'tampered vision description text';
        },
      },
      {
        label: 'visual_metrics',
        mutate: (parsed) => {
          parsed.scenes[0].visual_metrics = {
            ...parsed.scenes[0].visual_metrics,
            motion_score: parsed.scenes[0].visual_metrics.motion_score + 0.5,
          };
        },
      },
    ];

    for (const { label, mutate } of checksumFieldCases) {
      const source = makeSource({ id: `source-checksum-field-${label.replace(/\s+/g, '-')}` });
      fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, source.path), sourceBytes);
      const analyzerIdentity = `checksum-field-${label.replace(/\s+/g, '-')}@1`;

      const { deps: buildDeps } = makeDeps({ analyzerIdentity });
      const first = await indexSource(source, packageRoot, buildDeps, 'caption');
      assert.equal(first.planning_mode, 'vision', `${label}: baseline must not be degraded`);
      assert.ok(
        first.scenes[0]!.vision_description,
        `${label}: baseline scene must carry a vision description to tamper with`,
      );

      const indexPath = path.join(packageRoot, first.path);
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      mutate(parsed);
      fs.writeFileSync(indexPath, JSON.stringify(parsed, null, 2));

      const { deps: rerunDeps, calls: rerunCalls } = makeDeps({ analyzerIdentity });
      const second = await indexSource(source, packageRoot, rerunDeps, 'caption');
      assert.equal(
        rerunCalls.detectScenes,
        1,
        `${label}: a tampered ${label} field must invalidate the cache and force a rebuild`,
      );
      assert.notEqual(
        second.path,
        first.path,
        `${label}: an invalidated cache must publish a fresh generation, not reuse the tampered one`,
      );
    }
  }

  // --- I3 + C1: a damaged declared artifact invalidates the cache AND rebuilds successfully --
  {
    const source = makeSource({ id: 'source-repair' });
    fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, source.path), sourceBytes);

    // (a) deleting a start frame — a declared artifact the typed contract does not name —
    //     must invalidate the cache.
    const { deps: firstDeps, calls: firstCalls } = makeDeps({
      analyzerIdentity: 'repair-analyzer@1',
    });
    const first = await indexSource(source, packageRoot, firstDeps, 'caption');
    assert.equal(firstCalls.detectScenes, 1);
    const startFrame = path.join(
      packageRoot,
      first.scenes[0]!.representative_frame.replace('-mid.jpg', '-start.jpg'),
    );
    assert.ok(fs.existsSync(startFrame));
    fs.rmSync(startFrame);

    const { deps: repairDeps, calls: repairCalls } = makeDeps({
      analyzerIdentity: 'repair-analyzer@1',
    });
    const repaired = await indexSource(source, packageRoot, repairDeps, 'caption');
    assert.equal(
      repairCalls.detectScenes,
      1,
      'a missing declared artifact must force a rebuild, not serve a cache hit',
    );
    assert.notEqual(
      repaired.path,
      first.path,
      'a rebuild publishes to a fresh path; published artifacts stay immutable',
    );
    assert.ok(
      fs.existsSync(
        path.join(
          packageRoot,
          repaired.scenes[0]!.representative_frame.replace('-mid.jpg', '-start.jpg'),
        ),
      ),
      'the rebuilt generation has every declared artifact on disk',
    );

    // (b) tampering with a mid frame must also rebuild rather than throw destination_exists.
    const midFrame = path.join(packageRoot, repaired.scenes[0]!.representative_frame);
    fs.writeFileSync(midFrame, Buffer.from('tampered bytes'));
    const { deps: tamperDeps, calls: tamperCalls } = makeDeps({
      analyzerIdentity: 'repair-analyzer@1',
    });
    const rebuilt = await indexSource(source, packageRoot, tamperDeps, 'caption');
    assert.equal(tamperCalls.detectScenes, 1, 'a tampered artifact must force a rebuild');
    assert.notEqual(rebuilt.path, repaired.path);
    assert.deepEqual(
      fs.readFileSync(midFrame),
      Buffer.from('tampered bytes'),
      'the rebuild must never overwrite or delete the previously published generation',
    );
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
      checksum: `sha256:${'0'.repeat(62)}ff`,
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

  // --- I6: a failing ffmpeg is an indexing failure, never "no scenes" ------------------------
  {
    const previous = process.env.THOTH_FFMPEG;
    process.env.THOTH_FFMPEG = path.join(packageRoot, 'no-such-ffmpeg-binary.exe');
    try {
      await assert.rejects(
        () => detectScenesWithFfmpeg(sourcePath, makeSource().technical),
        /ffmpeg_scene_detect_/,
        'a missing/failing ffmpeg must not be reported as zero boundaries (one whole-video scene)',
      );
      await assert.rejects(
        () => extractFramesWithFfmpeg(sourcePath, [0]),
        /ffmpeg_extract_frame_/,
        'a missing/failing ffmpeg must not return frame paths that were never written',
      );
    } finally {
      if (previous === undefined) delete process.env.THOTH_FFMPEG;
      else process.env.THOTH_FFMPEG = previous;
    }
  }

  // --- I7: Vision spend is capped per package and a cap-exceeded scene degrades, not fails ---
  {
    const source = makeSource({ id: 'source-budget' });
    fs.mkdirSync(path.dirname(path.join(packageRoot, source.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, source.path), sourceBytes);
    const { deps } = makeDeps({
      analyzerIdentity: 'budget-analyzer@1',
      detectScenes: async () => [10],
    });
    let visionCalls = 0;
    const budgeted = withVisionBudget(
      {
        ...deps,
        describeWithVision: async () => {
          visionCalls += 1;
          return vision;
        },
      },
      1,
    );
    const index = await indexSource(source, packageRoot, budgeted.deps, 'caption');
    assert.equal(visionCalls, 1, 'the budget caps the underlying Vision calls');
    assert.equal(index.scenes.length, 2);
    assert.equal(
      index.planning_mode,
      'degraded',
      'exceeding the Vision budget degrades the index rather than failing it',
    );
    assert.ok(
      index.scenes.every((scene) => scene.embedding_path),
      'a budget-degraded scene still carries an embedding',
    );
  }

  console.log('ok scene_index');
} finally {
  fs.rmSync(packageRoot, { recursive: true, force: true });
}
