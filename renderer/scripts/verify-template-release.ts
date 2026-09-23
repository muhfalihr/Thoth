/**
 * Verify one released template inside the F1 reference environment.
 *
 * This is the machine gate: it captures the release's frames on both surfaces,
 * compares them to each other and to the approved goldens, and exits zero only
 * for `pass`. Every other outcome still leaves a complete candidate and a
 * report for an operator to look at.
 *
 * It takes one argument, the allowlisted release identity. It accepts no path:
 * the capsule comes from the repository, and the output root comes from the
 * container's existing artifact-root setting.
 *
 * Run with `bun run scripts/verify-template-release.ts vertical_text_story-v1`.
 */

import { RendererArtifactRoot, probeWithFfprobe } from "../src/artifact-root";
import { loadArtifactRoot } from "../src/config";
import { releaseIdentityOf } from "../src/release-capsule";
import { underStopSignals, verifyRelease } from "../src/template-release";

const [requested, ...extra] = process.argv.slice(2);

if (requested === undefined || extra.length > 0) {
  console.error("usage: verify-template-release <release-identity>");
  process.exit(2);
}

const identity = releaseIdentityOf(requested);
const artifacts = new RendererArtifactRoot(loadArtifactRoot(process.env), {
  probe: probeWithFfprobe,
});

// An operator's Ctrl-C reaches the browser through the same abort a deadline
// uses, so a stopped run still closes itself instead of leaving Chrome behind.
const report = await underStopSignals((signal) =>
  verifyRelease(identity, artifacts, { signal }),
);

// The report is the only output: it is already safe to publish, and it names
// the run whose candidate an operator can then inspect.
console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === "pass" ? 0 : 1);
