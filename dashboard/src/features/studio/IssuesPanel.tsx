import type { EditDocumentV2 } from "@/api/control-plane";
import type { EditorAction, EditorMode } from "./editor_state";
import { issueTarget, timelineIssues, type TimelineIssueCode } from "./timeline_domain";

type Props = {
  document: EditDocumentV2;
  selectedIssueId: string;
  mode: EditorMode;
  dispatch: (action: EditorAction) => void;
};

/** Plain language for each validation code, written for the person editing. */
const ISSUE_TEXT: Record<TimelineIssueCode, string> = {
  main_track_gap: "a clip starts after a gap",
  clip_overlap: "a clip overlaps the one before it",
  clip_exceeds_canvas: "a clip runs past the end of the video",
  track_empty: "the track has no clips",
};

export function IssuesPanel({ document: doc, selectedIssueId, mode, dispatch }: Props) {
  const issues = timelineIssues(doc);
  const labelOf = (trackId: string) =>
    doc.tracks.find((track) => track.track_id === trackId)?.label ?? trackId;

  return (
    <section className="border-t border-border bg-card/60 p-3" aria-label="Timeline issues">
      <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Issues
      </h2>
      {issues.length === 0 ? (
        <p className="text-xs text-muted-foreground">No issues found</p>
      ) : (
        <ul className="space-y-1">
          {issues.map((issue) => {
            const target = issueTarget(issue);
            const selected = issue.issue_id === selectedIssueId;
            return (
              <li key={issue.issue_id}>
                <button
                  type="button"
                  aria-current={selected}
                  className={`w-full rounded-md border px-2 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background/40 text-muted-foreground hover:bg-accent"
                  }`}
                  onClick={() => {
                    // Advanced mode first: the element to focus only exists there.
                    if (mode !== "advanced") dispatch({ type: "set_editor_mode", mode: "advanced" });
                    dispatch({ type: "select_issue", issueId: issue.issue_id });
                    dispatch({ type: "select_track", trackId: target.selectedTrackId });
                    if (target.selectedClipId) {
                      dispatch({ type: "select_clip", clipId: target.selectedClipId });
                    }
                    // Focus moves only on this deliberate click, never on a
                    // background revalidation that reorders the list.
                    const id = target.selectedClipId
                      ? `timeline-clip-${target.selectedClipId}`
                      : `timeline-track-${target.selectedTrackId}`;
                    window.document.getElementById(id)?.focus();
                  }}
                >
                  {labelOf(issue.target.track_id)}: {ISSUE_TEXT[issue.code]}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
