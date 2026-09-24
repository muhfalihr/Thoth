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
  sceneTextClip,
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
import { StudioJobNav } from "./StudioJobNav";
import { StudioReviewPanel, type StudioReviewClient } from "./StudioReviewPanel";
import { useStudioViewport, type StudioEditPane, type StudioJob } from "./studio_viewport";
import { usePlayerTimeline, type PlayerTimelineRef } from "./usePlayerTimeline";
import "./studio.css";

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
        | "listStudioReviewComments"
        | "createStudioReviewComment"
        | "listStudioReviewDecisions"
        | "createStudioReviewDecision"
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
  // The job is the destination at every width; compact screens also pick one
  // Edit pane at a time.
  const [job, setJob] = useState<StudioJob>("edit");
  const [editPane, setEditPane] = useState<StudioEditPane>("preview");
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
  const selectedClip = sceneTextClip(state.draft, selectedScene);
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
  const editing = job === "edit";
  // Simple desktop editing lays the scenes out as a strip under the preview.
  const stripLayout = !compact && !advanced;
  const workstationStyle = compact
    ? undefined
    : ({
        "--scene-board-width": `${sceneBoardWidth}rem`,
        "--inspector-width": `${inspectorWidth}rem`,
        gridTemplateRows: stripLayout ? "minmax(0,1fr) auto" : undefined,
        gridTemplateColumns: [
          editing && sceneRegionOpen && !stripLayout && "var(--scene-board-width)",
          "minmax(0,1fr)",
          editing && inspectorRegionOpen && "var(--inspector-width)",
        ]
          .filter(Boolean)
          .join(" "),
      } as CSSProperties);
  const reviewing = job === "review";
  const previewVisible = reviewing || (editing && (!compact || editPane === "preview"));
  const { pause } = player;

  // A hidden preview must not keep playing; showing it again never resumes it.
  useEffect(() => {
    if (!previewVisible) pause();
  }, [pause, previewVisible]);

  const selectJob = (next: StudioJob) => {
    if (next === "prompt") setPromptLabVisited(true);
    setJob(next);
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

  const {
    listStudioReviewComments,
    createStudioReviewComment,
    listStudioReviewDecisions,
    createStudioReviewDecision,
  } = client;
  // Review appears only where the whole review API is present, as a stable slice.
  const reviewClient = useMemo<StudioReviewClient | undefined>(
    () =>
      listStudioReviewComments && createStudioReviewComment && listStudioReviewDecisions && createStudioReviewDecision
        ? { listStudioReviewComments, createStudioReviewComment, listStudioReviewDecisions, createStudioReviewDecision }
        : undefined,
    [listStudioReviewComments, createStudioReviewComment, listStudioReviewDecisions, createStudioReviewDecision],
  );

  // A stale review write names a newer saved revision; fetching it hands the
  // choice to the existing conflict banner, so no local draft is ever dropped.
  const loadNewerRevision = () => {
    const requestGeneration = generation.current;
    void client
      .getEditDocument(projectId, documentId)
      .then((latest) => {
        if (requestGeneration === generation.current && latest.revision > base.revision) {
          dispatch({ type: "save_conflicted", latest });
        }
      })
      .catch(() => {});
  };

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
    <section className="studio-shell flex min-h-0 flex-1 flex-col bg-background text-foreground" aria-label="Guided Studio">
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
        <StudioJobNav selected={job} onSelect={selectJob} />
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
        {compact || !editing ? null : (
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
            {sceneRegionOpen && !stripLayout ? (
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
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
          {/* The document's own project, which the global project switcher may no longer show. */}
          <span className="break-all">Project {base.project_id}</span>
          <span>Saved revision {base.revision}</span>
          <span aria-live="polite">{statusLabel[state.saveStatus]}</span>
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

      {compact && editing ? (
        <CompactStudioNav
          panes={[
            { id: "scenes", label: "Scenes" },
            { id: "preview", label: "Preview" },
            { id: "controls", label: "Controls" },
          ]}
          selected={editPane}
          onSelect={setEditPane}
        />
      ) : null}

      <div id="studio-panel-scenes" hidden={job === "prompt"} className="flex min-h-0 flex-1 flex-col">
        <div
          aria-label="Guided editing workstation"
          // Render shows nothing from the workstation, so it yields the space.
          hidden={job === "render"}
          style={workstationStyle}
          className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1 overflow-auto" : "overflow-hidden"}`}
        >
          <div
            id="studio-region-scenes"
            className={stripLayout ? "col-start-1 row-start-2 min-w-0" : "contents"}
            hidden={!editing || (compact ? editPane !== "scenes" : !sceneRegionOpen)}
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
                onMove={
                  timeline
                    ? (sceneId, toIndex) =>
                        dispatch({
                          type: "commit_timeline_operation",
                          operation: { kind: "reorder_scene", operation_id: makeOperationId(), scene_id: sceneId, to_index: toIndex },
                        })
                    : undefined
                }
                moveDisabled={upgrading}
              />
            )}
          </div>
          <main
            hidden={!previewVisible}
            className={`flex min-w-0 flex-col gap-3 bg-black/40 p-4 ${
              // A compact column keeps the preview watchable above the review panel.
              compact ? "min-h-[28rem] [&>section]:min-h-72" : "min-h-0"
            } ${
              stripLayout ? "col-start-1 row-start-1" : ""
            }`}
          >
            {reviewing ? (
              <p className="text-sm text-muted-foreground">Reviewing saved revision {base.revision}</p>
            ) : null}
            <StudioPreview
              // Review shows what was saved; Edit shows the draft.
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
              <div className="contents" hidden={reviewing}>
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
              </div>
            ) : null}
            {reviewClient ? (
              // Beside the one shared preview; other jobs hide it without unmounting unsent text.
              <div hidden={!reviewing} className={compact ? undefined : "max-h-[40%] shrink-0 overflow-y-auto"}>
                <StudioReviewPanel
                  client={reviewClient}
                  projectId={projectId}
                  documentId={documentId}
                  savedDocument={base}
                  saveStatus={saveStatus}
                  isOffline={state.isOffline}
                  // The saved revision's own validity, the same facts the server checks.
                  blockingIssues={(isTimelineDocument(base) ? timelineIssues(base).length : 0) + (hasValidText(base) ? 0 : 1)}
                  currentFrame={state.playheadFrame}
                  onLoadRevision={loadNewerRevision}
                />
              </div>
            ) : (
              <p role="status" hidden={!reviewing} className="text-sm text-muted-foreground">
                Review is not available in this Studio session. Your draft is unaffected.
              </p>
            )}
          </main>
          <div
            id="studio-region-inspector"
            className="contents"
            hidden={!editing || (compact ? editPane !== "controls" : !inspectorRegionOpen)}
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
              <div
                className={`flex min-h-0 flex-col overflow-auto ${stripLayout ? "col-start-2 row-span-2 row-start-1" : ""}`}
              >
                <Inspector
                  scene={selectedScene}
                  clip={selectedClip}
                  fps={state.draft.canvas.fps}
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
          <div className="contents" hidden={job !== "render"}>
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
        ) : (
          <p role="status" hidden={job !== "render"} className="px-4 py-3 text-sm text-muted-foreground">
            Rendering is not available in this Studio session. Your draft is unaffected.
          </p>
        )}
      </div>

      <div id="studio-panel-prompts" hidden={job !== "prompt"} className="flex min-h-0 flex-1 flex-col">
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
