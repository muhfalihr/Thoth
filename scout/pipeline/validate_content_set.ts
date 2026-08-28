// validate_content_set.js — lint a content-set BEFORE `thoth run --content`.
//
// Catches the failure modes that produce 404 / off-topic / "video ngawur" hand-offs:
//   - main.url missing or wrong URL shape per platform
//   - footage URLs with fabricated/handle-as-shortcode shapes (IG/Twitter)
//   - is_video:false entries without a real image_path on disk
//   - main.description missing (narration hallucination risk — contract: WAJIB)
//
//   bun validate_content_set.js <content_set.json>
//
// Exit 0 = safe to hand off (errors=0). Exit 1 = has errors → fix before thoth run.

import fs from 'node:fs';
import { lintContentSet } from '../lib/validate.ts';
import { OUTPUT_DIR } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import type { AcquisitionRunContext } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';
import { decodeMainFootageDescriptor, decodeSourcePackage } from '../main_footage/contracts.ts';
import { resolveDescriptorManifest } from '../main_footage/paths.ts';
import type { ContentSet } from '../lib/types.ts';

export interface FileStageOptions {
  file: string;
}

export function validateMainFootageDescriptor(
  contentSetPath: string,
  set: ContentSet,
  scoutOutputRoot: string,
) {
  if (set.main_footage === undefined) return undefined;
  try {
    const descriptor = decodeMainFootageDescriptor(set.main_footage);
    const packagePath = resolveDescriptorManifest(contentSetPath, descriptor.package_manifest, scoutOutputRoot);
    const sourcePackage = decodeSourcePackage(JSON.parse(fs.readFileSync(packagePath, 'utf8')));
    if (sourcePackage.post.canonical_url !== set.main.url) throw new Error('canonical_url_mismatch');
    return sourcePackage;
  } catch (cause) {
    // The stable code is what cli.ts whitelists, so it stays the message — but PipelineStepError
    // sanitizes a failure down to message+stack, so an attached cause never reaches the operator.
    // Print it here or a decoder rejection ("sources[0].acquisition.attempts must be a finite
    // number") is indistinguishable from a missing manifest file.
    console.warn(
      `[main-footage] source package rejected: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    throw new Error('source_package_invalid', { cause });
  }
}

// Returns true when the content-set is safe to hand off (errors=0). Throws only on a
// malformed-JSON read (a genuine failure, distinct from a normal lint FAIL result).
export async function runValidateContentSet(
  options: FileStageOptions,
  context: AcquisitionRunContext,
): Promise<boolean> {
  void context;
  const { file } = options;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`JSON tidak valid: ${e.message}`);
  }

  validateMainFootageDescriptor(file, data, OUTPUT_DIR);

  const { errors, warnings, info, ok } = lintContentSet(data);

  console.log(ui.rule());
  console.log('  Content-set lint:', file);
  console.log(ui.rule());
  if (info.length) {
    console.log('\nℹ️  Info');
    info.forEach((m) => console.log('   - ' + m));
  }
  if (warnings.length) {
    console.log(ui.amber(`\n${ui.WARN}  Warning (boleh lanjut, tapi cek)`));
    warnings.forEach((m) => console.log('   - ' + m));
  }
  if (errors.length) {
    console.log(ui.red(`\n${ui.ERR} Error (WAJIB diperbaiki sebelum thoth run)`));
    errors.forEach((m) => console.log('   - ' + m));
  }

  console.log('\n' + ui.rule('thin'));
  console.log(
    `Result: ${ok ? ui.gold(`${ui.OK} PASS`) : ui.red(`${ui.ERR} FAIL`)}  (errors=${errors.length}, warnings=${warnings.length})`,
  );
  if (ok) console.log(`Aman: thoth run --content "${file}"`);
  return ok;
}

export function parseValidateContentSetArgs(argv: string[]): FileStageOptions {
  const file = argv[0];
  if (!file) {
    console.log('Usage: bun validate_content_set.ts <content_set.json>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(ui.red(`${ui.ERR} File tidak ada: ${file}`));
    process.exit(1);
  }
  return { file };
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseValidateContentSetArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    const ok = await runValidateContentSet(options, context);
    if (!ok) process.exit(1);
  });
}
