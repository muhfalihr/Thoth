import fs from 'node:fs';
import path from 'node:path';

const REMOTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function assertArtifactPath(relative: string): void {
  if (
    !relative
    || path.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || REMOTE_SCHEME.test(relative)
    || relative.includes('\\')
  ) {
    throw new Error('artifact_path_must_be_relative');
  }
  if (relative.split('/').some((part) => part === '..')) {
    throw new Error('path_outside_root');
  }
}

/**
 * A Content Set can be outside Scout output, so its package descriptor may need
 * lexical `..` segments. This deliberately does not establish containment: callers
 * must resolve it with resolveDescriptorManifest(), which does that against output.
 */
export function assertDescriptorManifestPath(relative: string): void {
  if (
    !relative
    || path.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || REMOTE_SCHEME.test(relative)
    || relative.includes('\\')
  ) {
    throw new Error('artifact_path_must_be_relative');
  }
}

export function resolveDescriptorManifest(
  contentSetPath: string,
  manifest: string,
  scoutOutputRoot: string,
): string {
  assertDescriptorManifestPath(manifest);
  const resolved = path.resolve(path.dirname(path.resolve(contentSetPath)), manifest);
  const outputRoot = path.resolve(scoutOutputRoot);
  const relativeToOutput = path.relative(outputRoot, resolved).split(path.sep).join('/');
  // Convert back to the strict package-root-relative form before resolving so
  // canonical ancestor/symlink validation remains centralized in resolveContained.
  return resolveContained(outputRoot, relativeToOutput);
}

export function resolveContained(root: string, relative: string): string {
  assertArtifactPath(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const prefix = resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error('path_outside_root');
  }
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error('path_outside_root');
    existingAncestor = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(existingAncestor);
  const canonicalPrefix = canonicalRoot + path.sep;
  if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(canonicalPrefix)) {
    throw new Error('path_outside_root');
  }
  return resolved;
}

/** Atomically makes `temp` visible at `destination`, refusing to replace any artifact. */
export function atomicPublish(temp: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    // link() is an atomic create-if-absent operation. Removing the temporary name after
    // linking leaves the same immutable file at its published destination.
    fs.linkSync(temp, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('destination_exists');
    }
    throw error;
  }
  fs.unlinkSync(temp);
}

export function nextVersion(root: string): `v${string}` {
  if (!fs.existsSync(root)) return 'v001';
  let highest = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^v(\d{3,})$/.exec(entry.name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `v${String(highest + 1).padStart(3, '0')}`;
}
