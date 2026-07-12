import type { JobStatus } from "@/api";
import { cn } from "@/lib/utils";

// Mirrors the CLI's own glyphs (src/brand.rs) so a Thoth CLI user reads
// status at a glance: · queued, ▶ running, ✓ succeeded, ✗ failed, ⊘ cancelled.
const GLYPH: Record<JobStatus, string> = {
  queued: "·",
  running: "▶",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
};

const COLOR: Record<JobStatus, string> = {
  queued: "text-status-queued border-status-queued/30 bg-status-queued/10",
  running: "text-status-running border-status-running/30 bg-status-running/10",
  succeeded: "text-status-succeeded border-status-succeeded/30 bg-status-succeeded/10",
  failed: "text-status-failed border-status-failed/30 bg-status-failed/10",
  cancelled: "text-status-cancelled border-status-cancelled/30 bg-status-cancelled/10",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        COLOR[status]
      )}
    >
      <span aria-hidden>{GLYPH[status]}</span>
      {status}
    </span>
  );
}
