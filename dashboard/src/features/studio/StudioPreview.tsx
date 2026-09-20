import { Player } from "@remotion/player";
import { useEffect, useState, type ComponentProps } from "react";

import type { ControlPlaneClient, EditDocument } from "@/api/control-plane";
import type { PreviewSources } from "./AdvancedTimelineComposition";
import { getPlayerConfig, previewComposition } from "./preview";
import type { PlayerTimelineRef } from "./usePlayerTimeline";

type Props = {
  document?: EditDocument;
  embedded?: boolean;
  client?: Pick<ControlPlaneClient, "getEditDocument">;
  projectId?: string;
  documentId?: string;
  onBack?: () => void;
  /** Same-origin preview paths, kept out of the document so they never persist. */
  previewSources?: PreviewSources;
  /** Receives the Player React commits, and null when it goes away. */
  onPlayer?: (player: PlayerTimelineRef | null) => void;
  onPreviewUnavailable?: (assetId: string) => void;
};

export function StudioPreview({
  document,
  embedded = false,
  client,
  projectId,
  documentId,
  onBack,
  previewSources,
  onPlayer,
  onPreviewUnavailable,
}: Props) {
  const [loadedDocument, setLoadedDocument] = useState<EditDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (document || !client || !projectId || !documentId) return;
    let active = true;
    setLoadedDocument(null);
    setFailed(false);
    void client
      .getEditDocument(projectId, documentId)
      .then((value) => active && setLoadedDocument(value))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [attempt, client, document, documentId, projectId]);

  const currentDocument = document ?? loadedDocument;

  // Remotion types the Player ref by its own PlayerRef; this view only drives the
  // timeline subset of it. A callback ref reports the instance React committed.
  const ref = onPlayer as unknown as ComponentProps<typeof Player>["ref"];

  const preview = currentDocument ? (
    <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-black p-4">
      <Player
        ref={ref}
        // The Player ties component and inputProps together through one generic;
        // previewComposition already pairs them correctly.
        {...(previewComposition(currentDocument, previewSources, onPreviewUnavailable) as {
          component: never;
          inputProps: never;
        })}
        controls
        spaceKeyToPlayOrPause
        className="mx-auto max-h-full max-w-full"
        {...getPlayerConfig(currentDocument)}
      />
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">Loading Studio preview…</p>
  );

  if (embedded) return <section className="flex h-full min-h-0 flex-col" aria-label="Studio preview">{preview}</section>;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-4" aria-label="Studio preview">
      <div className="flex items-center justify-between">
        <button type="button" className="text-sm text-muted-foreground underline" onClick={onBack}>
          Back to Content Set
        </button>
        <span className="font-mono text-xs text-muted-foreground">Read-only preview</span>
      </div>
      {failed ? (
        <div role="alert" className="space-y-3 text-sm text-destructive">
          <p>Could not load Studio preview.</p>
          <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : (
        preview
      )}
    </section>
  );
}
