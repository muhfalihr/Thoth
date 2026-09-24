import { useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";

import type { ControlPlaneClient, EditDocument, EditorAsset } from "@/api/control-plane";
import type { PreviewSources } from "./AdvancedTimelineComposition";
import { AssetLibrary } from "./AssetLibrary";
import { CaptionTextInspector } from "./CaptionTextInspector";
import { CompactStudioNav } from "./CompactStudioNav";
import {
  canStartUpgrade,
  createEditorState,
  editorReducer,
  findTextClip,
  hasValidText,
  toEditDocumentPatch,
  type EditorState,
} from "./editor_state";
import { Inspector } from "./Inspector";
import { IssuesPanel } from "./IssuesPanel";
import { PromptLab, type PromptLabClient } from "./PromptLab";
import { RenderPanel, type RenderPanelClient } from "./RenderPanel";
import { SceneBoard } from "./SceneBoard";
import { Timeline } from "./Timeline";
import { TimelineInspector } from "./TimelineInspector";
import {
  createAddClipFromAssetOperation,
  isTimelineDocument,
  timelineIssues,
} from "./timeline_domain";
import { StudioPreview } from "./StudioPreview";
import { useStudioViewport, type StudioPane } from "./studio_viewport";
import { usePlayerTimeline, type PlayerTimelineRef } from "./usePlayerTimeline";

type Props = {
  client: PromptLabClient &
    Pick<ControlPlaneClient, "getEditDocument" | "patchEditDocument"> &
    // Advanced editing degrades to guided editing wherever these are absent.
    Partial<
      Pick<
        ControlPlaneClient,
        | "upgradeEditDocument"
        | "listEditorAssets"
        | "createEditorPreviewCapability"
        | "getRenderCapability"
        | "createRenderJob"
        | "listRenderJobs"
        | "getRenderJob"
        | "cancelRenderJob"
        | "retryRenderJob"
        | "downloadRenderOutput"
        | "cleanupRenderArtifacts"
      >
    >;
  projectId: string;
  documentId: string;
  onBack: () => void;
};

const toolbarButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

function Editor({ client, projectId, documentId, onBack, document }: Props & { document: EditDocument }) {
  const [state, dispatch] = useReducer(editorReducer, document, createEditorState);
  // One pane choice serves every surface: desktop shows Prompt Lab or the
  // workstation, compact screens show exactly the chosen pane.
  const [pane, setPane] = useState<StudioPane>("preview");
  const [promptLabVisited, setPromptLabVisited] = useState(false);
  const viewport = useStudioViewport();
  const compact = viewport === "phone" || viewport === "tablet";
  const [sceneBoardOpen, setSceneBoardOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const collapsible = viewport === "compact_desktop";
  const sceneRegionOpen = !collapsible || sceneBoardOpen;
  const inspectorRegionOpen = !collapsible || inspectorOpen;
  const backDescriptionId = useId();
  const sceneWidthId = useId();
  const inspectorWidthId = useId();
  const [sceneBoardWidth, setSceneBoardWidth] = useState(14);
  const [inspectorWidth, setInspectorWidth] = useState(19);
  const selectedScene = state.draft.scenes.find((scene) => scene.scene_id === state.selectedSceneId);
  const timeline = isTimelineDocument(state.draft) ? state.draft : undefined;
  // Both modes project the same draft; only version 2 can show the advanced one.
  // A compact screen presents Simple without touching the stored mode, so a
  // wider screen brings the Advanced workspace back.
  const effectiveMode = compact ? "simple" : state.mode;
  const advanced = Boolean(timeline) && effectiveMode === "advanced";
  const selectedClip = findTextClip(state.draft, selectedScene?.clip_ids[0]);
  const [previewSources, setPreviewSources] = useState<PreviewSources>({});
  const upgradeReasonId = useId();
  const modeGroupId = useId();
  // The Player lives in state, so replacing it re-binds the timeline listeners.
  const [attachedPlayer, setAttachedPlayer] = useState<PlayerTimelineRef | null>(null);
  const player = usePlayerTimeline(
    attachedPlayer,
    (frame) => dispatch({ type: "set_playhead", frame }),
    (playing) => dispatch({ type: "set_playing", playing }),
  );
  /** Bumped on upgrade and unmount so a response that outlives this document is dropped. */
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current += 1;
  }, []);
  const { base, draft, pendingOperations, saveStatus } = state;
  const backDisabled = saveStatus !== "saved";
  // An upgrade replaces the document, so nothing may edit it until it settles.
  const upgrading = state.upgradeStatus === "running";
  const workstationStyle = compact
    ? undefined
    : ({
        "--scene-board-width": `${sceneBoardWidth}rem`,
        "--inspector-width": `${inspectorWidth}rem`,
        gridTemplateColumns: [
          sceneRegionOpen && "var(--scene-board-width)",
          "minmax(0,1fr)",
          inspectorRegionOpen && "var(--inspector-width)",
        ]
          .filter(Boolean)
          .join(" "),
      } as CSSProperties);
  const reviewing = compact && pane === "review";
  const previewVisible = compact ? pane === "preview" || pane === "review" : pane !== "prompts";
  const { pause } = player;

  // A hidden preview must not keep playing; showing it again never resumes it.
  useEffect(() => {
    if (!previewVisible) pause();
  }, [pause, previewVisible]);

  const selectPane = (next: StudioPane) => {
    if (next === "prompts") setPromptLabVisited(true);
    setPane(next);
  };

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
    if (saveStatus !== "dirty" || !pendingOperations.length || !hasValidText(draft)) return;
    const patch = toEditDocumentPatch({ base, pendingOperations });
    const operationIds = patch.operations.map((operation) => operation.operation_id);
    const timeoutId = setTimeout(() => {
      const requestGeneration = generation.current;
      dispatch({ type: "save_started", operationIds });
      void client
        .patchEditDocument(projectId, documentId, patch)
        .then((result) => {
          if (requestGeneration !== generation.current) return;
          dispatch(
            result.kind === "saved"
              ? { type: "save_succeeded", document: result.document, operationIds }
              : { type: "save_conflicted", latest: result.latest },
          );
        })
        .catch(() => {
          if (requestGeneration === generation.current) dispatch({ type: "save_failed" });
        });
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [base, client, documentId, draft, pendingOperations, projectId, saveStatus]);

  const makeOperationId = () => `op_${crypto.randomUUID()}`;

  const { listEditorAssets, createEditorPreviewCapability } = client;
  // A stable slice: a fresh object per render would restart the library's paged load.
  const assetClient = useMemo(
    () =>
      listEditorAssets && createEditorPreviewCapability
        ? { listEditorAssets, createEditorPreviewCapability }
        : undefined,
    [listEditorAssets, createEditorPreviewCapability],
  );

  const {
    getRenderCapability,
    createRenderJob,
    listRenderJobs,
    getRenderJob,
    cancelRenderJob,
    retryRenderJob,
    downloadRenderOutput,
    cleanupRenderArtifacts,
  } = client;
  // Rendering appears only where the whole render API is present, and the slice
  // is stable so the panel does not reload on every keystroke in the draft.
  const renderClient = useMemo<RenderPanelClient | undefined>(
    () =>
      getRenderCapability &&
      createRenderJob &&
      listRenderJobs &&
      getRenderJob &&
      cancelRenderJob &&
      retryRenderJob &&
      downloadRenderOutput &&
      cleanupRenderArtifacts
        ? {
            getRenderCapability,
            createRenderJob,
            listRenderJobs,
            getRenderJob,
            cancelRenderJob,
            retryRenderJob,
            downloadRenderOutput,
            cleanupRenderArtifacts,
          }
        : undefined,
    [
      getRenderCapability,
      createRenderJob,
      listRenderJobs,
      getRenderJob,
      cancelRenderJob,
      retryRenderJob,
      downloadRenderOutput,
      cleanupRenderArtifacts,
    ],
  );

  const addAsset = (asset: EditorAsset) => {
    if (!timeline) return;
    const operation = createAddClipFromAssetOperation(timeline, asset, state.playheadFrame, {
      operationId: makeOperationId(),
      clipId: `clip_${crypto.randomUUID()}`,
    });
    if (operation) dispatch({ type: "commit_timeline_operation", operation });
  };

  const upgradeDocument = () => {
    const upgrade = client.upgradeEditDocument;
    if (!upgrade || !canStartUpgrade(state)) return;
    // A replacement invalidates every response owned by the document it replaces.
    generation.current += 1;
    const requestGeneration = generation.current;
    dispatch({ type: "upgrade_started" });
    void upgrade(projectId, documentId, { base_revision: draft.revision }, makeOperationId())
      .then((result) => {
        if (requestGeneration !== generation.current) return;
        dispatch(
          result.kind === "conflict"
            ? { type: "upgrade_conflicted", latest: result.latest }
            : { type: "upgrade_succeeded", document: result.document },
        );
      })
      .catch(() => {
        if (requestGeneration === generation.current) dispatch({ type: "upgrade_failed" });
      });
  };

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
          disabled={!state.history.length || state.inFlightOperationIds.length > 0 || upgrading}
          onClick={() => dispatch({ type: "undo" })}
        >
          Undo
        </button>
        <button
          type="button"
          className={toolbarButton}
          disabled={!state.future.length || state.inFlightOperationIds.length > 0 || upgrading}
          onClick={() => dispatch({ type: "redo" })}
        >
          Redo
        </button>
        {!compact && !timeline && client.upgradeEditDocument ? (
          <>
            <button
              type="button"
              className={toolbarButton}
              disabled={!canStartUpgrade(state)}
              aria-describedby={canStartUpgrade(state) ? undefined : upgradeReasonId}
              onClick={upgradeDocument}
            >
              Enable advanced timeline
            </button>
            <span id={upgradeReasonId} className="sr-only">
              Enabling the advanced timeline is available once your changes are saved and Studio is online.
            </span>
            <span className="text-xs text-muted-foreground">
              Your scenes, text, and history stay as they are.
            </span>
          </>
        ) : null}
        {!compact && timeline ? (
          <div role="group" aria-label="Editor mode" id={modeGroupId} className="flex gap-1">
            {(["simple", "advanced"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`${toolbarButton} ${state.mode === mode ? "bg-accent" : ""}`}
                aria-pressed={state.mode === mode}
                onClick={() => dispatch({ type: "set_editor_mode", mode })}
              >
                {mode === "simple" ? "Simple" : "Advanced"}
              </button>
            ))}
          </div>
        ) : null}
        {compact && ((timeline && state.mode === "advanced") || (!timeline && client.upgradeEditDocument)) ? (
          <p className="text-xs text-muted-foreground">
            {timeline
              ? "Advanced timeline editing needs a desktop-width screen. Your Advanced workspace returns on a wider screen."
              : "Enabling the advanced timeline needs a desktop-width screen."}
          </p>
        ) : null}
        {compact ? null : (
          <div className="flex flex-wrap items-center gap-3 px-2 text-xs text-muted-foreground" aria-label="Workspace layout">
            {collapsible ? (
              <button
                type="button"
                className={toolbarButton}
                aria-expanded={sceneBoardOpen}
                aria-controls="studio-region-scenes"
                onClick={() => setSceneBoardOpen((open) => !open)}
              >
                Scene board panel
              </button>
            ) : null}
            {sceneRegionOpen ? (
              <>
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
              </>
            ) : null}
            {collapsible ? (
              <button
                type="button"
                className={toolbarButton}
                aria-expanded={inspectorOpen}
                aria-controls="studio-region-inspector"
                onClick={() => setInspectorOpen((open) => !open)}
              >
                Inspector panel
              </button>
            ) : null}
            {inspectorRegionOpen ? (
              <>
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
              </>
            ) : null}
          </div>
        )}
        <div className="ml-auto font-mono text-xs text-muted-foreground" aria-live="polite">
          {statusLabel[state.saveStatus]}
        </div>
      </header>

      {state.upgradeStatus === "failed" && (
        <div role="alert" className="border-b border-destructive/50 bg-destructive/10 px-4 py-2 text-sm">
          <p>Could not enable the advanced timeline. Your document is unchanged.</p>
        </div>
      )}
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

      {compact ? (
        <CompactStudioNav
          panes={[
            { id: "scenes", label: "Scenes" },
            { id: "preview", label: "Preview" },
            { id: "edit", label: "Edit" },
            { id: "prompts", label: "Prompt Lab" },
            { id: "review", label: "Review" },
            ...(renderClient ? [{ id: "renders" as const, label: "Renders" }] : []),
          ]}
          selected={pane}
          onSelect={selectPane}
        />
      ) : (
        <div
          role="tablist"
          aria-label="Studio workspace"
          className="flex gap-2 border-b border-border bg-card px-4 py-1"
        >
          <button
            type="button"
            role="tab"
            id="studio-tab-scenes"
            aria-selected={pane !== "prompts"}
            aria-controls="studio-panel-scenes"
            className={`${toolbarButton} ${pane !== "prompts" ? "bg-accent" : ""}`}
            onClick={() => {
              if (pane === "prompts") setPane("preview");
            }}
          >
            Scenes
          </button>
          <button
            type="button"
            role="tab"
            id="studio-tab-prompts"
            aria-selected={pane === "prompts"}
            aria-controls="studio-panel-prompts"
            className={`${toolbarButton} ${pane === "prompts" ? "bg-accent" : ""}`}
            onClick={() => selectPane("prompts")}
          >
            Prompt Lab
          </button>
        </div>
      )}

      <div
        role={compact ? undefined : "tabpanel"}
        id="studio-panel-scenes"
        aria-label="Scenes"
        hidden={pane === "prompts"}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          aria-label="Guided editing workstation"
          // The Renders pane shows nothing from the workstation, so it yields the space.
          hidden={compact && pane === "renders"}
          style={workstationStyle}
          className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1 overflow-auto" : "overflow-hidden"}`}
        >
          <div
            id="studio-region-scenes"
            className="contents"
            hidden={compact ? pane !== "scenes" : !sceneRegionOpen}
          >
            {advanced ? (
              assetClient ? (
                <AssetLibrary
                  client={assetClient}
                  projectId={projectId}
                  generationRef={generation}
                  onAssets={(assets, replace) => dispatch({ type: "assets_loaded", assets, replace })}
                  onAdd={addAsset}
                  onPreviewSource={(assetId, previewUrl) =>
                    setPreviewSources((current) => ({ ...current, [assetId]: previewUrl }))
                  }
                />
              ) : null
            ) : (
              <SceneBoard
                document={state.draft}
                selectedSceneId={state.selectedSceneId}
                onSelect={(sceneId) => dispatch({ type: "select_scene", sceneId })}
              />
            )}
          </div>
          <main
            hidden={compact && !previewVisible}
            className={`flex min-w-0 flex-col gap-3 bg-black/40 p-4 ${compact ? "min-h-[28rem]" : "min-h-0"}`}
          >
            {reviewing ? (
              <p className="text-sm text-muted-foreground">Reviewing saved revision {base.revision}</p>
            ) : null}
            <StudioPreview
              // Review shows what was saved; every other pane shows the draft.
              document={reviewing ? base : state.draft}
              onPlayer={setAttachedPlayer}
              embedded
              previewSources={previewSources}
              onPreviewUnavailable={(assetId) =>
                // Same reference when the asset is already gone, so the player
                // reporting an unusable source cannot loop the editor.
                setPreviewSources((current) => {
                  if (!(assetId in current)) return current;
                  const { [assetId]: _dropped, ...rest } = current;
                  return rest;
                })
              }
            />
            {advanced && timeline ? (
              <>
                <Timeline
                  state={state}
                  dispatch={dispatch}
                  onSeek={player.seekTo}
                  onPlay={player.play}
                  onPause={player.pause}
                />
                <IssuesPanel
                  document={timeline}
                  selectedIssueId={state.selectedIssueId}
                  mode={state.mode}
                  dispatch={dispatch}
                />
              </>
            ) : null}
          </main>
          <div
            id="studio-region-inspector"
            className="contents"
            hidden={compact ? pane !== "edit" : !inspectorRegionOpen}
          >
            {advanced && timeline ? (
              <TimelineInspector
                document={timeline}
                selectedClipId={state.selectedClipId}
                selectedTrackId={state.selectedTrackId}
                onOperation={(operation) => dispatch({ type: "commit_timeline_operation", operation })}
              />
            ) : (
              // One grid cell: the caption editor stacks under the copy inspector.
              <div className="flex min-h-0 flex-col overflow-auto">
                <Inspector
                  scene={selectedScene}
                  clip={selectedClip}
                  disabled={upgrading}
                  textOnly={viewport === "phone"}
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
                {timeline && viewport !== "phone" ? (
                  <CaptionTextInspector
                    document={timeline}
                    selectedSceneId={state.selectedSceneId}
                    disabled={upgrading}
                    onOperation={(operation) => dispatch({ type: "commit_timeline_operation", operation })}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>
        {renderClient ? (
          <div className="contents" hidden={compact && pane !== "renders"}>
            <RenderPanel
              client={renderClient}
              projectId={projectId}
              documentId={documentId}
              // The saved revision, never the draft: an unsaved or conflicted
              // document cannot be rendered, and the panel's gate explains why.
              documentRevision={base.revision}
              // The template the saved document carries, not one the UI assumes.
              templateId={base.template.template_id}
              templateVersion={base.template.version}
              facts={{ saveStatus, online: !state.isOffline }}
              monitorOnly={viewport === "phone"}
              // The saved revision is what a render reads, so its text and its
              // structure are what decide whether it can be rendered at all.
              validation={{
                textValid: hasValidText(base),
                blockingIssues: isTimelineDocument(base) ? timelineIssues(base).length : 0,
              }}
            />
          </div>
        ) : null}
      </div>

      <div
        role={compact ? undefined : "tabpanel"}
        id="studio-panel-prompts"
        aria-label="Prompt Lab"
        hidden={pane !== "prompts"}
        className="flex min-h-0 flex-1 flex-col"
      >
        {promptLabVisited ? (
          <PromptLab client={client} projectId={projectId} compactTextOnly={viewport === "phone"} />
        ) : null}
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
