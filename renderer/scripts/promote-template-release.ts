/**
 * Promote one verified candidate into the release's approved golden set.
 *
 * This is the operator's action, run against the repository after looking at a
 * candidate's contact sheet. It takes the allowlisted release identity and the
 * run that produced the candidate, and it takes no path: the capsule is the
 * tracked one, and the candidate is read from the configured artifact root.
 *
 * Run with:
 *   bun run scripts/promote-template-release.ts vertical_text_story-v1 --run-id run_...
 */

import { RendererArtifactRoot, probeWithFfprobe } from "../src/artifact-root";
import { loadArtifactRoot } from "../src/config";
import { loadReleaseCapsule, releaseIdentityOf } from "../src/release-capsule";
import { PromotionRefused, promoteRelease } from "../src/template-release";

const [requested, flag, runId, ...extra] = process.argv.slice(2);

if (requested === undefined || flag !== "--run-id" || runId === undefined || extra.length > 0) {
  console.error("usage: promote-template-release <release-identity> --run-id <run-id>");
  process.exit(2);
}

const identity = releaseIdentityOf(requested);
const artifacts = new RendererArtifactRoot(loadArtifactRoot(process.env), {
  probe: probeWithFfprobe,
});

try {
  await promoteRelease(identity, artifacts, runId);
} catch (error) {
  // A refusal is the expected outcome of a candidate that does not check out,
  // and it says only that: what it refused is in the candidate's own report.
  if (error instanceof PromotionRefused) {
    console.error("promotion refused");
    process.exit(1);
  }
  throw error;
}

const capsule = await loadReleaseCapsule(identity);
console.log(JSON.stringify({ release: identity, golden_set: capsule.goldens?.golden_set ?? null }));
