import { useEffect, useId, useReducer, useRef, useState } from "react";

import type { ControlPlaneClient, SavePromptTemplateRequest } from "@/api/control-plane";
import {
  createPromptLabState,
  promptLabReducer,
  type PromptLabSaveKind,
  type PromptLabState,
} from "./prompt_lab_state";

export type PromptLabClient = Pick<
  ControlPlaneClient,
  | "listPromptStages"
  | "listPromptTemplates"
  | "savePromptTemplate"
  | "getPromptBinding"
  | "savePromptBinding"
  | "getResolvedPrompt"
>;

type Props = {
  client: PromptLabClient;
  projectId: string;
};

const toolbarButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

const LANGUAGE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const PROMPT_TEXT_MAX_LENGTH = 12_000;

const statusLabel: Record<PromptLabState["saveStatus"], string> = {
  loading: "Loading",
  ready: "Ready",
  dirty: "Unsaved changes",
  saving: "Saving",
  saved: "Saved",
  failed: "Failed",
  conflict: "Conflict",
  recovering: "Reconnecting",
  offline: "Offline",
};

export function PromptLab({ client, projectId }: Props) {
  const [state, dispatch] = useReducer(
    promptLabReducer,
    undefined,
    () => createPromptLabState({ selectedStageId: "" }),
  );
  const [attempt, setAttempt] = useState(0);
  const languageId = useId();
  const bodyId = useId();
  const overrideId = useId();
  const selectedStageIdRef = useRef(state.selectedStageId);
  const isOfflineRef = useRef(state.isOffline);
  const recoveryStageIdRef = useRef<string | null>(null);
  selectedStageIdRef.current = state.selectedStageId;
  isOfflineRef.current = state.isOffline;
  const isRecovering = state.saveStatus === "recovering";

  useEffect(() => {
    let active = true;
    void client
      .listPromptStages()
      .then((stages) => {
        if (!active) return;
        dispatch({ type: "stages_loaded", stages });
      })
      .catch(() => {
        if (active) dispatch({ type: "went_offline" });
      });
    return () => {
      active = false;
    };
  }, [client, projectId]);

  useEffect(() => {
    if (!state.selectedStageId) return;
    if (isRecovering) return;
    if (recoveryStageIdRef.current === state.selectedStageId) {
      recoveryStageIdRef.current = null;
      return;
    }
    let active = true;
    void Promise.all([
      client.listPromptTemplates(projectId, state.selectedStageId),
      client.getPromptBinding(projectId, state.selectedStageId),
    ])
      .then(([templates, binding]) => {
        if (!active) return;
        dispatch({ type: "stage_data_loaded", templates, binding });
      })
      .then(async () => {
        if (!active) return;
        try {
          const resolved = await client.getResolvedPrompt(projectId, state.selectedStageId);
          if (active) dispatch({ type: "resolved_loaded", resolved });
        } catch {
          if (active) dispatch({ type: "resolved_loaded", resolved: null });
        }
      })
      .catch(() => {
        if (active) dispatch({ type: "went_offline" });
      });
    return () => {
      active = false;
    };
  }, [client, isRecovering, projectId, state.selectedStageId]);

  useEffect(() => {
    if (attempt === 0) return;
    let active = true;
    dispatch({ type: "recovery_started" });
    recoveryStageIdRef.current = selectedStageIdRef.current || null;

    void (async () => {
      try {
        const stages = await client.listPromptStages();
        if (!active) return;
        const selectedStageId = stages.some(
          (stage) => stage.stage_id === selectedStageIdRef.current,
        )
          ? selectedStageIdRef.current
          : (stages[0]?.stage_id ?? "");
        recoveryStageIdRef.current = selectedStageId || null;
        dispatch({ type: "stages_loaded", stages });

        if (!selectedStageId) {
          dispatch({ type: "went_online" });
          return;
        }

        const [templates, binding] = await Promise.all([
          client.listPromptTemplates(projectId, selectedStageId),
          client.getPromptBinding(projectId, selectedStageId),
        ]);
        if (!active) return;

        let resolved = null;
        try {
          resolved = await client.getResolvedPrompt(projectId, selectedStageId);
        } catch {
          // A missing resolved preview is an expected empty state, not a connectivity failure.
        }
        if (!active) return;

        dispatch({ type: "stage_data_loaded", templates, binding });
        dispatch({ type: "resolved_loaded", resolved });
        dispatch({ type: "went_online" });
      } catch {
        if (active) dispatch({ type: "went_offline" });
      }
    })();

    return () => {
      active = false;
    };
  }, [attempt, client, projectId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOffline = () => dispatch({ type: "went_offline" });
    const handleOnline = () => {
      if (isOfflineRef.current) setAttempt((value) => value + 1);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const recover = () => {
    setAttempt((value) => value + 1);
  };

  const languageValid = LANGUAGE_PATTERN.test(state.languageDraft);
  const bodyValid =
    state.templateBodyDraft.trim().length > 0 &&
    state.templateBodyDraft.length <= PROMPT_TEXT_MAX_LENGTH;
  const templateSavable =
    languageValid && bodyValid && !state.isOffline && state.saveStatus !== "loading";
  const bindingSavable =
    templateSavable &&
    state.bindingTemplateIdDraft !== null &&
    state.bindingTemplateRevisionDraft !== null;

  const refreshResolved = async () => {
    if (!state.selectedStageId) return;
    try {
      const resolved = await client.getResolvedPrompt(projectId, state.selectedStageId);
      dispatch({ type: "resolved_loaded", resolved });
    } catch {
      dispatch({ type: "resolved_loaded", resolved: null });
    }
  };

  const saveTemplate = async () => {
    dispatch({ type: "save_started", kind: "template" });
    try {
      const result = await client.savePromptTemplate(projectId, {
        stage_id: state.selectedStageId as SavePromptTemplateRequest["stage_id"],
        language: state.languageDraft,
        body: state.templateBodyDraft,
        template_id: state.templateIdDraft,
        base_revision: state.templateBaseRevision,
      });
      if (result.kind === "saved") {
        dispatch({ type: "template_save_succeeded", saved: result.value });
      } else {
        dispatch({ type: "template_save_conflicted", latest: result.latest });
      }
    } catch {
      dispatch({ type: "template_save_failed" });
    }
  };

  const saveBinding = async () => {
    if (state.bindingTemplateIdDraft === null || state.bindingTemplateRevisionDraft === null) return;
    dispatch({ type: "save_started", kind: "binding" });
    try {
      const result = await client.savePromptBinding(projectId, state.selectedStageId, {
        template_id: state.bindingTemplateIdDraft,
        template_revision: state.bindingTemplateRevisionDraft,
        project_override: state.projectOverrideDraft.trim() ? state.projectOverrideDraft : null,
        base_revision: state.bindingBaseRevision,
      });
      if (result.kind === "saved") {
        dispatch({ type: "binding_save_succeeded", saved: result.value });
        await refreshResolved();
      } else {
        dispatch({ type: "binding_save_conflicted", latest: result.latest });
        await refreshResolved();
      }
    } catch {
      dispatch({ type: "binding_save_failed" });
    }
  };

  const retry = () => {
    const kind: PromptLabSaveKind = state.lastFailedSave ?? "template";
    dispatch({ type: "retry_save" });
    void (kind === "template" ? saveTemplate() : saveBinding());
  };

  const reloadLatest = () => {
    dispatch({ type: "reload_latest" });
    void refreshResolved();
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Prompt Lab">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
        <h2 className="text-sm font-semibold">Prompt Lab</h2>
        <div className="ml-auto font-mono text-xs text-muted-foreground" aria-live="polite">
          {statusLabel[state.saveStatus]}
        </div>
      </header>

      {state.saveStatus === "failed" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-destructive/50 bg-destructive/10 px-4 py-2 text-sm"
        >
          <p>Your prompt text is still here. Check your connection and retry saving.</p>
          <button type="button" className={toolbarButton} onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {state.saveStatus === "conflict" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-primary/40 bg-primary/10 px-4 py-2 text-sm"
        >
          <p>A newer version exists. Reload it to continue from the latest revision.</p>
          <button type="button" className={toolbarButton} onClick={reloadLatest}>
            Reload Latest
          </button>
        </div>
      )}
      {state.isOffline && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm"
        >
          <p>
            {state.saveStatus === "recovering"
              ? "Reconnecting to Prompt Lab."
              : "Offline. Your prompt drafts are still here and will save when the connection returns."}
          </p>
          <button
            type="button"
            className={toolbarButton}
            disabled={state.saveStatus === "recovering"}
            onClick={recover}
          >
            {state.saveStatus === "recovering" ? "Retrying" : "Retry"}
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-[16rem_minmax(0,1fr)_24rem] lg:overflow-hidden">
        <nav aria-label="Prompt stages" className="flex flex-col gap-2">
          {state.stages.map((stage) => (
            <button
              key={stage.stage_id}
              type="button"
              className={toolbarButton}
              disabled={state.saveStatus === "recovering"}
              aria-pressed={state.selectedStageId === stage.stage_id}
              onClick={() => dispatch({ type: "select_stage", stageId: stage.stage_id })}
            >
              {stage.label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <nav aria-label="Prompt templates" className="flex flex-wrap gap-2">
            {state.templates.map((template) => (
              <button
                key={template.template_id}
                type="button"
                className={toolbarButton}
                aria-pressed={state.templateIdDraft === template.template_id}
                onClick={() =>
                  dispatch({ type: "select_template", templateId: template.template_id })
                }
              >
                {`${template.template_id} (revision ${template.revision})`}
              </button>
            ))}
            <button
              type="button"
              className={toolbarButton}
              onClick={() => dispatch({ type: "new_template" })}
            >
              New template
            </button>
          </nav>

          <div className="flex flex-col gap-2">
            <label htmlFor={languageId}>Language</label>
            <input
              id={languageId}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={state.languageDraft}
              onChange={(event) => dispatch({ type: "edit_language", value: event.target.value })}
            />
            <label htmlFor={bodyId}>Template body</label>
            <textarea
              id={bodyId}
              className="min-h-32 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={PROMPT_TEXT_MAX_LENGTH}
              value={state.templateBodyDraft}
              onChange={(event) => dispatch({ type: "edit_template_body", value: event.target.value })}
            />
            <button
              type="button"
              className={toolbarButton}
              disabled={!templateSavable}
              onClick={() => void saveTemplate()}
            >
              Save template
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={overrideId}>Project override</label>
            <textarea
              id={overrideId}
              className="min-h-24 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={PROMPT_TEXT_MAX_LENGTH}
              value={state.projectOverrideDraft}
              onChange={(event) =>
                dispatch({ type: "edit_project_override", value: event.target.value })
              }
            />
            <button
              type="button"
              className={toolbarButton}
              disabled={!bindingSavable}
              onClick={() => void saveBinding()}
            >
              {state.binding === null ? "Create binding" : "Save binding"}
            </button>
            {state.binding === null && (
              <p className="text-xs text-muted-foreground">No binding for this stage yet.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" className={toolbarButton} disabled>
              Improve
            </button>
            <button type="button" className={toolbarButton} disabled>
              Translate
            </button>
            <p className="text-xs text-muted-foreground">
              Provider-backed proposals are not available yet.
            </p>
          </div>
        </div>

        <aside className="flex min-h-0 min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">Resolved prompt preview</h3>
          {state.resolved === null ? (
            <p className="text-xs text-muted-foreground">
              No resolved preview yet. Save a binding to see the resolved draft.
            </p>
          ) : (
            <pre
              aria-label="Resolved prompt preview"
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-sm"
            >
              {state.resolved.visible_text}
            </pre>
          )}
        </aside>
      </div>
    </section>
  );
}
