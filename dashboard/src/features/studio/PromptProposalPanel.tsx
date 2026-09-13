import { useCallback, useEffect, useReducer } from "react";

import type { ControlPlaneClient } from "@/api/control-plane";
import {
  canApplyProposal,
  canGenerateProposal,
  createPromptProposalState,
  promptProposalReducer,
} from "./prompt_proposal_state";

export type PromptProposalPanelClient = Pick<
  ControlPlaneClient,
  | "listPromptProviders"
  | "getPromptStarter"
  | "getPromptPreference"
  | "savePromptPreference"
  | "getPromptLocks"
  | "savePromptLock"
  | "createPromptProposal"
  | "listPromptProposals"
  | "getPromptProposal"
  | "applyPromptProposal"
  | "rejectPromptProposal"
  | "getPromptBinding"
>;

type Props = {
  client: PromptProposalPanelClient;
  projectId: string;
  stageId: string;
  savedTemplateId: string | null;
  savedTemplateRevision: number | null;
  savedBindingRevision: number | null;
  savedOverrideText: string;
  formDirty: boolean;
  online: boolean;
  hasBinding: boolean;
  onApplied: () => void;
  onUseStarter: (body: string, language: string) => void;
  onCreateScratch: () => void;
};

const toolbarButton =
  "rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

const POLL_INTERVAL_MS = 1_500;

export function PromptProposalPanel(props: Props) {
  const { client, projectId, stageId, formDirty, online, onApplied, onUseStarter, onCreateScratch } =
    props;
  const [state, dispatch] = useReducer(
    promptProposalReducer,
    undefined,
    () =>
      createPromptProposalState({
        stageId,
        savedTemplateId: props.savedTemplateId,
        savedTemplateRevision: props.savedTemplateRevision,
        savedBindingRevision: props.savedBindingRevision,
        savedOverrideText: props.savedOverrideText,
      }),
  );
  void useCallback(() => undefined, []);

  useEffect(() => {
    dispatch({
      type: "saved_revisions_changed",
      templateId: props.savedTemplateId,
      templateRevision: props.savedTemplateRevision,
      bindingRevision: props.savedBindingRevision,
      overrideText: props.savedOverrideText,
    });
  }, [
    props.savedTemplateId,
    props.savedTemplateRevision,
    props.savedBindingRevision,
    props.savedOverrideText,
  ]);

  useEffect(() => {
    let active = true;
    void client
      .listPromptProviders()
      .then((providers) => active && dispatch({ type: "providers_loaded", providers }))
      .catch(() => undefined);
    void client
      .getPromptLocks(projectId, stageId)
      .then((locks) => active && dispatch({ type: "locks_loaded", locks }))
      .catch(() => undefined);
    void client
      .getPromptPreference(projectId, stageId)
      .then((preference) => active && dispatch({ type: "preference_loaded", preference }))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, projectId, stageId]);

  useEffect(() => {
    let active = true;
    void client
      .listPromptProposals(projectId, stageId, undefined, 5)
      .then(async (page) => {
        if (!active) return;
        dispatch({ type: "history_loaded", proposals: page.proposals });
        const activeOne = page.proposals.find(
          (proposal) => proposal.status === "queued" || proposal.status === "running",
        );
        if (activeOne) {
          dispatch({ type: "proposal_loaded", proposal: activeOne });
        } else {
          const latest = page.proposals[0];
          if (latest) dispatch({ type: "proposal_loaded", proposal: latest });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, projectId, stageId]);

  useEffect(() => {
    if (!online) return;
    if (!state.activeProposal) return;
    if (state.activeProposal.status !== "queued" && state.activeProposal.status !== "running") {
      return;
    }
    const proposalId = state.activeProposal.proposal_id;
    const timer = setTimeout(() => {
      void client
        .getPromptProposal(projectId, proposalId)
        .then((proposal) => {
          if (!activeGuard()) return;
          dispatch({ type: "proposal_loaded", proposal });
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    let cancelled = false;
    const activeGuard = () => !cancelled;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, projectId, state.activeProposal, online]);

  const generate = (kind: "improve" | "translate") => {
    if (
      props.savedTemplateId === null ||
      props.savedTemplateRevision === null ||
      props.savedBindingRevision === null
    ) {
      return;
    }
    const idempotencyKey = `poll_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sourceIdentity = {
      source_template_id: props.savedTemplateId,
      source_template_revision: props.savedTemplateRevision,
      source_binding_revision: props.savedBindingRevision,
    };
    void client
      .createPromptProposal(
        projectId,
        idempotencyKey,
        kind === "improve"
          ? {
              kind,
              stage_id: stageId,
              provider_id: state.selectedProviderId ?? "",
              model_id: state.selectedModelId ?? "",
              target_layer: "template",
              ...sourceIdentity,
            }
          : {
              kind,
              stage_id: stageId,
              provider_id: state.selectedProviderId ?? "",
              model_id: state.selectedModelId ?? "",
              target_language: "en-US",
              ...sourceIdentity,
            },
      )
      .then((proposal) => dispatch({ type: "proposal_loaded", proposal }))
      .catch(() => dispatch({ type: "error", code: "store_unavailable" }));
  };

  const apply = () => {
    const proposal = state.activeProposal;
    if (!proposal || proposal.status !== "succeeded") return;
    void client
      .applyPromptProposal(projectId, proposal.proposal_id, {
        source_template_revision: proposal.source.template_revision,
        source_binding_revision: proposal.source.binding_revision,
        change_ids:
          proposal.kind === "improve"
            ? state.selectedChangeIds
            : [],
      })
      .then(() => {
        dispatch({ type: "proposal_status_changed", status: "applied" });
        onApplied();
      })
      .catch(() => dispatch({ type: "error", code: "store_unavailable" }));
  };

  const reject = () => {
    const proposal = state.activeProposal;
    if (!proposal) return;
    void client
      .rejectPromptProposal(projectId, proposal.proposal_id)
      .then((updated) => dispatch({ type: "proposal_status_changed", status: updated.status }))
      .catch(() => dispatch({ type: "error", code: "store_unavailable" }));
  };

  const generateCheck = canGenerateProposal(state, { online, formDirty });
  const identityMissing =
    props.savedTemplateId === null ||
    props.savedTemplateRevision === null ||
    props.savedBindingRevision === null;
  const proposal = state.activeProposal;
  const applyCheck =
    proposal && props.savedTemplateRevision !== null && props.savedBindingRevision !== null
      ? canApplyProposal(state, {
          online,
          templateRevision: props.savedTemplateRevision,
          bindingRevision: props.savedBindingRevision,
        })
      : { allowed: false as const, reason: "not_succeeded" as const };
  const provider = state.providers.find((item) => item.provider_id === state.selectedProviderId);
  const lockedTemplate = state.locks.some((lock) => lock.layer === "template" && lock.locked);
  const lockedOverride = state.locks.some(
    (lock) => lock.layer === "project_override" && lock.locked,
  );

  const useStarter = () => {
    void client
      .getPromptStarter(stageId)
      .then((starter) => onUseStarter(starter.body, starter.language))
      .catch(() => undefined);
  };

  return (
    <section aria-label="AI proposals" className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-semibold">AI proposals</h3>

      {!props.hasBinding && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={toolbarButton} onClick={useStarter}>
            Use starter
          </button>
          <button type="button" className={toolbarButton} onClick={onCreateScratch}>
            Create scratch
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="pp-provider">Provider</label>
        <select
          id="pp-provider"
          className="rounded-md border border-border bg-background px-2 py-1"
          value={state.selectedProviderId ?? ""}
          onChange={(event) => {
            const nextProvider = state.providers.find(
              (item) => item.provider_id === event.target.value,
            );
            dispatch({
              type: "select_provider",
              providerId: event.target.value,
              modelId: nextProvider?.models[0]?.model_id ?? "",
            });
          }}
        >
          {state.providers.map((item) => (
            <option key={item.provider_id} value={item.provider_id}>
              {item.label}
            </option>
          ))}
        </select>
        <label htmlFor="pp-model">Model</label>
        <select
          id="pp-model"
          className="rounded-md border border-border bg-background px-2 py-1"
          value={state.selectedModelId ?? ""}
          onChange={(event) =>
            state.selectedProviderId &&
            dispatch({
              type: "select_provider",
              providerId: state.selectedProviderId,
              modelId: event.target.value,
            })
          }
        >
          {(provider?.models ?? []).map((model) => (
            <option key={model.model_id} value={model.model_id}>
              {model.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={toolbarButton}
          disabled={!online}
          onClick={() => {
            if (state.selectedProviderId && state.selectedModelId) {
              void client
                .savePromptPreference(projectId, stageId, {
                  provider_id: state.selectedProviderId,
                  model_id: state.selectedModelId,
                  base_revision: state.preference?.revision ?? null,
                })
                .then((preference) => dispatch({ type: "preference_saved", preference }))
                .catch(() => dispatch({ type: "error", code: "store_unavailable" }));
            }
          }}
        >
          Save preference
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          className={toolbarButton}
          disabled={lockedTemplate}
          onClick={() =>
            void client
              .savePromptLock(projectId, stageId, "template", {
                locked: !lockedTemplate,
              })
              .then((lock) => dispatch({ type: "lock_saved", lock }))
              .catch(() => dispatch({ type: "error", code: "store_unavailable" }))
          }
        >
          {lockedTemplate ? "Unlock template" : "Lock template"}
        </button>
        <button
          type="button"
          className={toolbarButton}
          disabled={lockedOverride}
          onClick={() =>
            void client
              .savePromptLock(projectId, stageId, "project_override", {
                locked: !lockedOverride,
              })
              .then((lock) => dispatch({ type: "lock_saved", lock }))
              .catch(() => dispatch({ type: "error", code: "store_unavailable" }))
          }
        >
          {lockedOverride ? "Unlock project override" : "Lock project override"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          className={toolbarButton}
          disabled={!generateCheck.allowed || identityMissing}
          onClick={() => generate("improve")}
        >
          Improve with AI
        </button>
        <button
          type="button"
          className={toolbarButton}
          disabled={!generateCheck.allowed || identityMissing}
          onClick={() => generate("translate")}
        >
          Translate with AI
        </button>
        {!generateCheck.allowed && generateCheck.reason && (
          <p className="text-xs text-muted-foreground">
            {generateCheck.reason === "unsaved_changes" || generateCheck.reason === "missing_saved_source"
              ? "Save changes first"
              : generateCheck.reason === "offline"
                ? "Offline"
                : generateCheck.reason === "layer_locked"
                  ? "Unlock the target layer first"
                  : generateCheck.reason === "proposal_in_flight"
                    ? "A proposal is already in flight"
                    : "Select a provider and model"}
          </p>
        )}
      </div>

      {proposal && (
        <div className="flex flex-col gap-2 text-sm" aria-label="Proposal review">
          <div role="status" aria-atomic="true">
            {proposal.status === "queued" || proposal.status === "running"
              ? "Proposal running"
              : proposal.status === "succeeded"
                ? "Proposal ready for review"
                : proposal.status === "failed"
                  ? `Proposal failed (${proposal.failure_code ?? "unknown"})`
                  : `Proposal ${proposal.status}`}
          </div>
          {proposal.kind === "translate" && proposal.translated_template_body && (
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-card p-2 text-xs">
              {proposal.translated_template_body}
            </pre>
          )}
          {proposal.kind === "improve" &&
            proposal.changes.map((change) => (
              <label key={change.change_id} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={state.selectedChangeIds.includes(change.change_id)}
                  onChange={() =>
                    dispatch({ type: "toggle_change", changeId: change.change_id })
                  }
                />
                <span>
                  {change.before_text} → {change.after_text}
                </span>
              </label>
            ))}
          <div className="flex flex-wrap gap-2">
            {proposal.kind === "improve" && (
              <button
                type="button"
                className={toolbarButton}
                disabled={!applyCheck.allowed}
                onClick={apply}
              >
                Apply selected
              </button>
            )}
            {proposal.kind === "translate" && (
              <button
                type="button"
                className={toolbarButton}
                disabled={!applyCheck.allowed}
                onClick={apply}
              >
                Apply translation
              </button>
            )}
            <button
              type="button"
              className={toolbarButton}
              disabled={!online || proposal.status !== "succeeded"}
              onClick={reject}
            >
              Reject proposal
            </button>
            <button
              type="button"
              className={toolbarButton}
              disabled={!generateCheck.allowed}
              onClick={() => generate(proposal.kind)}
            >
              Regenerate
            </button>
          </div>
          {!applyCheck.allowed && applyCheck.reason === "source_changed" && (
            <p className="text-xs text-destructive">Source changed</p>
          )}
          {props.hasBinding === false && formDirty && <p className="sr-only">draft</p>}
        </div>
      )}

      {formDirty && !proposal && (
        <p className="text-xs text-muted-foreground">Save changes first</p>
      )}
    </section>
  );
}
