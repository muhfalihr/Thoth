import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalAsset, MediaAsset, PostRecord } from '../acquisition/types.ts';
import type { ContentResult, ContentSet } from '../lib/types.ts';
import { OUTPUT_DIR } from '../lib/paths.ts';
import {
  MAIN_FOOTAGE_SCHEMA_VERSION,
  decodeExternalSources,
  fingerprintCanonical,
  type ExternalSourcesV1,
  type SourceTechnicalMetadata,
} from './contracts.ts';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';
import { probeSourceVideo } from './source_package.ts';

export interface PackageExternalFootageOptions {
  contentSetPath: string;
  excludedMediaIds?: readonly string[];
}

export interface PackageExternalFootageDeps {
  scoutOutputRoot?: string;
  inspectPost(url: string): Promise<PostRecord>;
  materialize(asset: MediaAsset): Promise<LocalAsset>;
  probe(file: string): Promise<SourceTechnicalMetadata>;
  now?: () => number;
}

export interface ExternalSourcesResult {
  manifestPath: string;
  descriptorPath: string;
}

function checksum(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function stableSourceId(asset: MediaAsset): string {
  const digest = createHash('sha256').update(asset.id).digest('hex').slice(0, 16);
  return `external-${digest}`;
}

function extension(local: LocalAsset): string {
  const ext = path.extname(local.path).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.mp4';
}

function copyToTemp(original: string, temp: string): void {
  try {
    fs.linkSync(original, temp);
  } catch {
    fs.copyFileSync(original, temp, fs.constants.COPYFILE_EXCL);
  }
}

function sourceUrl(entry: ContentResult): string {
  return typeof entry.source_url === 'string' && entry.source_url.trim()
    ? entry.source_url
    : entry.url;
}

function selectAsset(
  entry: ContentResult,
  post: PostRecord,
  excluded: ReadonlySet<string>,
): MediaAsset | null {
  const videos = post.media.filter(
    (asset) => asset.kind === 'video' && !excluded.has(asset.id),
  );
  const direct = videos.find((asset) => asset.ephemeral_url === entry.url);
  if (direct) return direct;
  return videos.length === 1 ? videos[0]! : null;
}

function relativeManifest(contentSetPath: string, manifestPath: string): string {
  return path
    .relative(path.dirname(path.resolve(contentSetPath)), manifestPath)
    .split(path.sep)
    .join('/');
}

/**
 * Materializes accepted forced-run enrichment videos into a write-once Scout package.
 * The mutable Content Set receives only the manifest pointer; neither remote URLs nor
 * acquisition-cache paths cross the Rust planning boundary.
 */
export async function packageExternalFootage(
  options: PackageExternalFootageOptions,
  deps: PackageExternalFootageDeps,
): Promise<ExternalSourcesResult | null> {
  const contentSetPath = path.resolve(options.contentSetPath);
  const set = JSON.parse(fs.readFileSync(contentSetPath, 'utf8')) as ContentSet;
  const excluded = new Set(options.excludedMediaIds ?? []);
  const outputRoot = path.resolve(deps.scoutOutputRoot ?? OUTPUT_DIR);
  fs.mkdirSync(outputRoot, { recursive: true });
  const generationsRoot = resolveContained(outputRoot, 'main-footage/external-footage');
  fs.mkdirSync(generationsRoot, { recursive: true });
  const version = nextVersion(generationsRoot);
  const generationRoot = resolveContained(generationsRoot, version);
  const sourcesRoot = path.join(generationRoot, 'sources');
  const tempRoot = path.join(generationRoot, '.tmp');
  fs.mkdirSync(sourcesRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  const sources: ExternalSourcesV1['sources'] = [];
  const seen = new Set<string>();
  for (const entry of set.footage ?? []) {
    if (!entry.is_video || !entry.url) continue;
    let temp = '';
    try {
      const post = await deps.inspectPost(sourceUrl(entry));
      const asset = selectAsset(entry, post, excluded);
      if (!asset || seen.has(asset.id)) continue;
      seen.add(asset.id);
      const local = await deps.materialize(asset);
      const canonicalLocal = fs.realpathSync.native(path.resolve(local.path));
      const canonicalOutput = fs.realpathSync.native(outputRoot);
      if (
        canonicalLocal !== canonicalOutput &&
        !canonicalLocal.startsWith(`${canonicalOutput}${path.sep}`)
      ) {
        throw new Error('external_source_outside_scout_output');
      }
      const id = stableSourceId(asset);
      const ext = extension(local);
      const relative = path.posix.join('sources', `${id}${ext}`);
      const destination = resolveContained(generationRoot, relative);
      temp = path.join(tempRoot, `${id}${ext}.tmp`);
      copyToTemp(canonicalLocal, temp);
      const technical = await deps.probe(temp);
      const digest = checksum(temp);
      atomicPublish(temp, destination);
      temp = '';
      sources.push({
        id,
        path: relative,
        checksum: digest,
        technical,
        query: typeof entry.query === 'string' ? entry.query : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        trim_start_sec:
          typeof entry.trim_start === 'number' && Number.isFinite(entry.trim_start)
            ? Math.max(0, entry.trim_start)
            : 0,
      });
    } catch {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  if (!sources.length) {
    fs.rmSync(generationRoot, { recursive: true, force: true });
    return null;
  }
  sources.sort((left, right) => left.id.localeCompare(right.id));
  const unsigned: ExternalSourcesV1 = {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    sources,
    created_at: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  const manifest: ExternalSourcesV1 = {
    ...unsigned,
    fingerprint: fingerprintCanonical(unsigned),
  };
  decodeExternalSources(manifest);
  const manifestPath = path.join(generationRoot, 'manifest.json');
  const manifestTemp = path.join(tempRoot, 'manifest.json.tmp');
  fs.writeFileSync(manifestTemp, JSON.stringify(manifest, null, 2), 'utf8');
  atomicPublish(manifestTemp, manifestPath);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const descriptorPath = relativeManifest(contentSetPath, manifestPath);
  if (!set.main_footage) throw new Error('forced_main_descriptor_missing');
  set.main_footage.external_sources_manifest = descriptorPath;
  fs.writeFileSync(contentSetPath, JSON.stringify(set, null, 2), 'utf8');
  return { manifestPath, descriptorPath };
}

export function productionExternalFootageDeps(
  inspectPost: PackageExternalFootageDeps['inspectPost'],
  materialize: PackageExternalFootageDeps['materialize'],
): PackageExternalFootageDeps {
  return {
    scoutOutputRoot: OUTPUT_DIR,
    inspectPost,
    materialize,
    probe: probeSourceVideo,
  };
}
