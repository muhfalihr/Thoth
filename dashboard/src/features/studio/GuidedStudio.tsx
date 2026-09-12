import { useEffect, useId, useReducer, useState, type CSSProperties } from "react";

import type { ControlPlaneClient, EditDocument } from "@/api/control-plane";
import { editorReducer, createEditorState, toEditDocumentPatch, type EditorState } from "./editor_state";
import { Inspector } from "./Inspector";
import { PromptLab, type PromptLabClient } from "./PromptLab";
import { SceneBoard } from "./SceneBoard";
import { StudioPreview } from "./StudioPreview";

type Props = {
  client: Pick<
    ControlPlaneClient,
    | "getEditDocument"
    | "patchEditDocument"
    | "listPromptStages"
    | "listPromptTemplates"
    | "savePromptTemplate"
    | "getPromptBinding"
    | "savePromptBinding"
    | "getResolvedPrompt"
  >;
  projectId: string;
  documentId: string;
  onBack: () => void;
};

type StudioWorkspace = "scenes" | "prompts";

const toolbarButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

function validDraft(document: EditDocument) {
  return document.clips.every(
    (clip) => clip.heading.trim().length > 0 && clip.heading.length <= 300 && clip.body.length <= 2_000,
  );
}

function Editor({ client, projectId, documentId, onBack, document }: Props & { document: EditDocument }) {
  const [state, dispatch] = useReducer(editorReducer, document, createEditorState);
  const [workspace, setWorkspace] = useState<StudioWorkspace>("scenes");
  const [promptLabVisited, setPromptLabVisited] = useState(false);
  const backDescriptionId = useId();
  const sceneWidthId = useId();
  const inspectorWidthId = useId();
  const [sceneBoardWidth, setSceneBoardWidth] = useState(14);
  const [inspectorWidth, setInspectorWidth] = useState(19);
  const selectedScene = state.draft.scenes.find((scene) => scene.scene_id === state.selectedSceneId);
  const selectedClip = state.draft.clips.find((clip) => clip.clip_id === selectedScene?.clip_ids[0]);
  const { base, draft, pendingOperations, saveStatus } = state;
  const backDisabled = saveStatus !== "saved";
  const workstationStyle = {
    "--scene-board-width": `${sceneBoardWidth}rem`,
    "--inspector-width": `${inspectorWidth}rem`,
  } as CSSProperties;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOffline = () => dispatch({ type: "went_offline" });
    const handleOnline = () => dispatch({ type: "went_online" });
    if (window.navigator.onLine === false) dispatch({ type: "went_offline" });
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    if (saveStatus !== "dirty" || !pendingOperations.length || !validDraft(draft)) return;
    const patch = toEditDocumentPatch({ base, pendingOperations });
    const operationIds = patch.operations.map((operation) => operation.operation_id);
    const timeoutId = setTimeout(() => {
      dispatch({ type: "save_started", operationIds });
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

  const makeOperationId = () => `op_${crypto.randomUUID()}`;
  const statusLabel: Record<EditorState["saveStatus"], string> = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving",
    failed: "Failed",
    conflict: "Conflict",
    offline: "Offline",
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Guided Studio">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
        <button
          type="button"
          className={toolbarButton}
          onClick={onBack}
          disabled={backDisabled}
          aria-describedby={backDisabled ? backDescriptionId : undefined}
        >
          Back
        </button>
        <span id={backDescriptionId} className="sr-only">
          Back is available after changes are saved and Studio is online.
        </span>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          className={toolbarButton}
          disabled={!state.history.length || state.inFlightOperationIds.length > 0}
          onClick={() => dispatch({ type: "undo" })}
        >
          Undo
        </button>
        <button
          type="button"
          className={toolbarButton}
          disabled={!state.future.length || state.inFlightOperationIds.length > 0}
          onClick={() => dispatch({ type: "redo" })}
        >
          Redo
        </button>
        <div className="flex flex-wrap items-center gap-3 px-2 text-xs text-muted-foreground" aria-label="Workspace layout">
          <label htmlFor={sceneWidthId}>Scene board width</label>
          <input
            id={sceneWidthId}
            type="range"
            min={12}
            max={22}
            step={1}
            value={sceneBoardWidth}
            onChange={(event) => setSceneBoardWidth(event.target.valueAsNumber)}
            className="h-2 w-24 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <label htmlFor={inspectorWidthId}>Inspector width</label>
          <input
            id={inspectorWidthId}
            type="range"
            min={16}
            max={28}
            step={1}
            value={inspectorWidth}
            onChange={(event) => setInspectorWidth(event.target.valueAsNumber)}
            className="h-2 w-24 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
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
          <button
            type="button"
            className={toolbarButton}
            onClick={() => dispatch({
              type: "keep_editing_locally",
              operationIdPrefix: `op_rebase_${makeOperationId()}`,
            })}
          >
            Keep Editing Locally
          </button>
        </div>
      )}
      {state.saveStatus === "offline" && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm">
          <p>Offline. Your edits are still here and will save when connection returns.</p>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Studio workspace"
        className="flex gap-2 border-b border-border bg-card px-4 py-1"
      >
        <button
          type="button"
          role="tab"
          id="studio-tab-scenes"
          aria-selected={workspace === "scenes"}
          aria-controls="studio-panel-scenes"
          className={`${toolbarButton} ${workspace === "scenes" ? "bg-accent" : ""}`}
          onClick={() => setWorkspace("scenes")}
        >
          Scenes
        </button>
        <button
          type="button"
          role="tab"
          id="studio-tab-prompts"
          aria-selected={workspace === "prompts"}
          aria-controls="studio-panel-prompts"
          className={`${toolbarButton} ${workspace === "prompts" ? "bg-accent" : ""}`}
          onClick={() => {
            setPromptLabVisited(true);
            setWorkspace("prompts");
          }}
        >
          Prompt Lab
        </button>
      </div>

      <div
        role="tabpanel"
        id="studio-panel-scenes"
        aria-label="Scenes"
        hidden={workspace !== "scenes"}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          aria-label="Guided editing workstation"
          style={workstationStyle}
          className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[var(--scene-board-width)_minmax(0,1fr)_var(--inspector-width)] lg:overflow-hidden"
        >
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
      </div>

      <div
        role="tabpanel"
        id="studio-panel-prompts"
        aria-label="Prompt Lab"
        hidden={workspace !== "prompts"}
        className="flex min-h-0 flex-1 flex-col"
      >
        {promptLabVisited ? <PromptLab client={client as PromptLabClient} projectId={projectId} /> : null}
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
