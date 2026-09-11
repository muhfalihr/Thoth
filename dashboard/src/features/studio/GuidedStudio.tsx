import { useEffect, useReducer, useState } from "react";

import type { ControlPlaneClient, EditDocument } from "@/api/control-plane";
import { editorReducer, createEditorState, toEditDocumentPatch, type EditorState } from "./editor_state";
import { Inspector } from "./Inspector";
import { SceneBoard } from "./SceneBoard";
import { StudioPreview } from "./StudioPreview";

type Props = {
  client: Pick<ControlPlaneClient, "getEditDocument" | "patchEditDocument">;
  projectId: string;
  documentId: string;
  onBack: () => void;
};

const toolbarButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

function validDraft(document: EditDocument) {
  return document.clips.every(
    (clip) => clip.heading.trim().length > 0 && clip.heading.length <= 300 && clip.body.length <= 2_000,
  );
}

function Editor({ client, projectId, documentId, onBack, document }: Props & { document: EditDocument }) {
  const [state, dispatch] = useReducer(editorReducer, document, createEditorState);
  const selectedScene = state.draft.scenes.find((scene) => scene.scene_id === state.selectedSceneId);
  const selectedClip = state.draft.clips.find((clip) => clip.clip_id === selectedScene?.clip_ids[0]);
  const { base, draft, pendingOperations, saveStatus } = state;

  useEffect(() => {
    if (saveStatus !== "dirty" || !pendingOperations.length || !validDraft(draft)) return;
    const patch = toEditDocumentPatch({ base, pendingOperations });
    const operationIds = patch.operations.map((operation) => operation.operation_id);
    const timeoutId = setTimeout(() => {
      dispatch({ type: "save_started" });
      void client
        .patchEditDocument(projectId, documentId, patch)
        .then((result) => {
          dispatch(
            result.kind === "saved"
              ? { type: "save_succeeded", document: result.document, operationIds }
              : { type: "save_conflicted", latest: result.latest },
          );
        })
        .catch(() => dispatch({ type: "save_failed" }));
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [base, client, documentId, draft, pendingOperations, projectId, saveStatus]);

  const makeOperationId = () => crypto.randomUUID();
  const statusLabel: Record<EditorState["saveStatus"], string> = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving",
    failed: "Failed",
    conflict: "Conflict",
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Guided Studio">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
        <button type="button" className={toolbarButton} onClick={onBack}>Back</button>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          className={toolbarButton}
          disabled={!state.history.length || state.saveStatus === "saving"}
          onClick={() => dispatch({ type: "undo" })}
        >
          Undo
        </button>
        <button
          type="button"
          className={toolbarButton}
          disabled={!state.future.length || state.saveStatus === "saving"}
          onClick={() => dispatch({ type: "redo" })}
        >
          Redo
        </button>
        <div className="ml-auto font-mono text-xs text-muted-foreground" aria-live="polite">
          {statusLabel[state.saveStatus]}
        </div>
      </header>

      {state.saveStatus === "failed" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-destructive/50 bg-destructive/10 px-4 py-2 text-sm">
          <p>Your edits are still here. Check your connection and retry saving.</p>
          <button type="button" className={toolbarButton} onClick={() => dispatch({ type: "retry_save" })}>
            Retry
          </button>
        </div>
      )}
      {state.saveStatus === "conflict" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-primary/40 bg-primary/10 px-4 py-2 text-sm">
          <p>A newer version exists. Choose which work to continue with.</p>
          <button type="button" className={toolbarButton} onClick={() => dispatch({ type: "reload_latest" })}>
            Reload Latest
          </button>
          <button type="button" className={toolbarButton} onClick={() => dispatch({ type: "keep_editing_locally" })}>
            Keep Editing Locally
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[14rem_minmax(0,1fr)_19rem] lg:overflow-hidden">
        <SceneBoard
          document={state.draft}
          selectedSceneId={state.selectedSceneId}
          onSelect={(sceneId) => dispatch({ type: "select_scene", sceneId })}
        />
        <main className="min-h-[28rem] min-w-0 bg-black/40 p-4 lg:min-h-0">
          <StudioPreview document={state.draft} embedded />
        </main>
        <Inspector
          scene={selectedScene}
          clip={selectedClip}
          onTextChange={(clipId, field, value) =>
            dispatch({ type: "edit_text", clipId, field, value, operationId: makeOperationId() })
          }
          onOwnershipChange={(clipId, ownership) =>
            dispatch({ type: "edit_ownership", clipId, ownership, operationId: makeOperationId() })
          }
          onDurationChange={(sceneId, durationInFrames) =>
            dispatch({ type: "edit_duration", sceneId, durationInFrames, operationId: makeOperationId() })
          }
        />
      </div>
    </section>
  );
}

export function GuidedStudio(props: Props) {
  const { client, projectId, documentId } = props;
  const [document, setDocument] = useState<EditDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setFailed(false);
    void client
      .getEditDocument(projectId, documentId)
      .then((value) => active && setDocument(value))
      .catch(() => active && setFailed(true));
    return () => { active = false; };
  }, [attempt, client, documentId, projectId]);

  if (failed) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6" aria-label="Guided Studio">
        <div role="alert" className="text-center text-sm">
          <p>Could not load Studio. Check your connection and try again.</p>
        </div>
        <button type="button" className={toolbarButton} onClick={() => setAttempt((value) => value + 1)}>Retry</button>
        <button type="button" className={toolbarButton} onClick={props.onBack}>Back</button>
      </section>
    );
  }
  if (!document) return <p className="p-6 text-sm text-muted-foreground">Loading Studio…</p>;
  return <Editor key={document.revision} {...props} document={document} />;
}
