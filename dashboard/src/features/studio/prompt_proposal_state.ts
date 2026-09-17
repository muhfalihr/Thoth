import type {
  PromptLayerLock,
  PromptModelPreference,
  PromptProposalResource,
  PromptProvider,
} from "@/api/control-plane";

export type PromptProposalStatus = "loading" | "ready" | "offline";

export type GenerateBlockReason =
  | "offline"
  | "unsaved_changes"
  | "missing_saved_source"
  | "no_provider"
  | "model_not_allowed"
  | "layer_locked"
  | "proposal_in_flight"
  | "resources_unavailable";

export type ApplyBlockReason =
  | "offline"
  | "source_changed"
  | "not_succeeded"
  | "no_selection"
  | "layer_locked"
  | "resources_unavailable";

export type PromptProposalState = {
  stageId: string;
  providers: PromptProvider[];
  preference: PromptModelPreference | null;
  locks: PromptLayerLock[];
  activeProposal: PromptProposalResource | null;
  history: PromptProposalResource[];
  selectedChangeIds: string[];
  selectedProviderId: string | null;
  selectedModelId: string | null;
  savedTemplateId: string | null;
  savedTemplateRevision: number | null;
  savedBindingRevision: number | null;
  savedOverrideText: string;
  status: PromptProposalStatus;
  lastError: string | null;
  // False from the moment a stage load starts until it completes in full. Every
  // proposal mutation (generate/apply/reject/preference write/lock write) must
  // check this before treating the loaded catalog/preference/locks as authoritative,
  // so a partial or failed load can never be mistaken for "nothing is locked" or
  // "no preference exists".
  resourcesReady: boolean;
};

export type PromptProposalAction =
  | { type: "stage_selected"; stageId: string }
  | { type: "providers_loaded"; providers: PromptProvider[] }
  | { type: "preference_loaded"; preference: PromptModelPreference | null }
  | { type: "preference_saved"; preference: PromptModelPreference }
  | { type: "preference_conflict"; latest: PromptModelPreference }
  | { type: "locks_loaded"; locks: PromptLayerLock[] }
  | { type: "lock_saved"; lock: PromptLayerLock }
  | { type: "lock_conflict"; latest: PromptLayerLock }
  | { type: "proposal_loaded"; proposal: PromptProposalResource }
  | { type: "proposal_status_changed"; status: PromptProposalResource["status"] }
  | { type: "history_loaded"; proposals: PromptProposalResource[] }
  | {
      type: "stage_load_succeeded";
      providers: PromptProvider[];
      preference: PromptModelPreference | null;
      locks: PromptLayerLock[];
      history: PromptProposalResource[];
      activeProposal: PromptProposalResource | null;
    }
  | { type: "select_provider"; providerId: string; modelId: string }
  | { type: "toggle_change"; changeId: string }
  | {
      type: "saved_revisions_changed";
      templateId: string | null;
      templateRevision: number | null;
      bindingRevision: number | null;
      overrideText: string;
    }
  | { type: "went_offline" }
  | { type: "went_online" }
  | { type: "error"; code: string }
  | { type: "stage_load_failed" };

export function createPromptProposalState(input: {
  stageId: string;
  providers?: PromptProvider[];
  savedTemplateId?: string | null;
  savedTemplateRevision: number | null;
  savedBindingRevision: number | null;
  savedOverrideText: string;
}): PromptProposalState {
  return {
    stageId: input.stageId,
    providers: input.providers ?? [],
    preference: null,
    locks: [],
    activeProposal: null,
    history: [],
    selectedChangeIds: [],
    selectedProviderId: input.providers?.[0]?.provider_id ?? null,
    selectedModelId: input.providers?.[0]?.models[0]?.model_id ?? null,
    savedTemplateId: input.savedTemplateId ?? null,
    savedTemplateRevision: input.savedTemplateRevision,
    savedBindingRevision: input.savedBindingRevision,
    savedOverrideText: input.savedOverrideText,
    status: "ready",
    lastError: null,
    resourcesReady: true,
  };
}

function lockedLayers(state: PromptProposalState): Set<string> {
  return new Set(
    state.locks.filter((lock) => lock.locked).map((lock) => lock.layer),
  );
}

function selectedModel(state: PromptProposalState) {
  const provider = state.providers.find(
    (candidate) => candidate.provider_id === state.selectedProviderId,
  );
  const model = provider?.models.find(
    (candidate) => candidate.model_id === state.selectedModelId,
  );
  return { provider, model };
}

export function canGenerateProposal(
  state: PromptProposalState,
  facts: { online: boolean; formDirty: boolean },
  operation?: "improve" | "translate",
  targetLayer?: "template" | "project_override",
): { allowed: boolean; reason?: GenerateBlockReason } {
  if (!state.resourcesReady) return { allowed: false, reason: "resources_unavailable" };
  if (!facts.online) return { allowed: false, reason: "offline" };
  if (facts.formDirty) return { allowed: false, reason: "unsaved_changes" };
  if (
    state.savedTemplateId === null ||
    state.savedTemplateRevision === null ||
    state.savedBindingRevision === null
  ) {
    return { allowed: false, reason: "missing_saved_source" };
  }
  const { provider, model } = selectedModel(state);
  if (!provider || !model) return { allowed: false, reason: "no_provider" };
  if (operation && !model.capabilities.includes(operation)) {
    return { allowed: false, reason: "model_not_allowed" };
  }
  if (state.activeProposal && (state.activeProposal.status === "queued" || state.activeProposal.status === "running")) {
    return { allowed: false, reason: "proposal_in_flight" };
  }
  const locked = lockedLayers(state);
  if (operation === "improve" && targetLayer && locked.has(targetLayer)) {
    return { allowed: false, reason: "layer_locked" };
  }
  if (operation === "translate") {
    const overrideTargeted = state.savedOverrideText.trim().length > 0;
    if (locked.has("template") || (overrideTargeted && locked.has("project_override"))) {
      return { allowed: false, reason: "layer_locked" };
    }
  }
  if (!operation && locked.size > 0) return { allowed: false, reason: "layer_locked" };
  return { allowed: true };
}

export function canApplyProposal(
  state: PromptProposalState,
  facts: { online: boolean; templateRevision: number; bindingRevision: number },
): { allowed: boolean; reason?: ApplyBlockReason } {
  if (!state.resourcesReady) return { allowed: false, reason: "resources_unavailable" };
  const proposal = state.activeProposal;
  if (!proposal) return { allowed: false, reason: "not_succeeded" };
  if (!facts.online) return { allowed: false, reason: "offline" };
  if (proposal.status !== "succeeded") return { allowed: false, reason: "not_succeeded" };
  if (
    proposal.source.template_revision !== facts.templateRevision ||
    proposal.source.binding_revision !== facts.bindingRevision
  ) {
    return { allowed: false, reason: "source_changed" };
  }
  const locked = lockedLayers(state);
  for (const layer of proposal.target_layers) {
    if (locked.has(layer)) return { allowed: false, reason: "layer_locked" };
  }
  if (proposal.kind === "improve" && state.selectedChangeIds.length === 0) {
    return { allowed: false, reason: "no_selection" };
  }
  return { allowed: true };
}

export function promptProposalReducer(
  state: PromptProposalState,
  action: PromptProposalAction,
): PromptProposalState {
  switch (action.type) {
    case "stage_selected":
      return {
        ...state,
        stageId: action.stageId,
        activeProposal: null,
        history: [],
        selectedChangeIds: [],
        locks: [],
        preference: null,
        status: "ready",
        lastError: null,
        resourcesReady: false,
      };
    case "stage_load_succeeded":
      return {
        ...state,
        providers: action.providers,
        preference: action.preference,
        locks: action.locks,
        history: action.history,
        activeProposal: action.activeProposal,
        selectedChangeIds: [],
        selectedProviderId:
          action.preference?.provider_id ??
          state.selectedProviderId ??
          action.providers[0]?.provider_id ??
          null,
        selectedModelId:
          action.preference?.model_id ??
          state.selectedModelId ??
          action.providers[0]?.models[0]?.model_id ??
          null,
        lastError: null,
        resourcesReady: true,
      };
    case "providers_loaded":
      return {
        ...state,
        providers: action.providers,
        selectedProviderId:
          state.selectedProviderId ?? action.providers[0]?.provider_id ?? null,
        selectedModelId: state.selectedModelId ?? action.providers[0]?.models[0]?.model_id ?? null,
      };
    case "preference_loaded":
      return {
        ...state,
        preference: action.preference,
        selectedProviderId: action.preference?.provider_id ?? state.selectedProviderId,
        selectedModelId: action.preference?.model_id ?? state.selectedModelId,
      };
    case "preference_saved":
      return { ...state, preference: action.preference, lastError: null };
    case "preference_conflict":
      return { ...state, preference: action.latest, lastError: "preference_conflict" };
    case "locks_loaded":
      return { ...state, locks: action.locks };
    case "lock_saved": {
      const existing = state.locks.some((lock) => lock.layer === action.lock.layer);
      return {
        ...state,
        locks: existing
          ? state.locks.map((lock) => (lock.layer === action.lock.layer ? action.lock : lock))
          : [...state.locks, action.lock],
        lastError: null,
      };
    }
    case "lock_conflict": {
      const existing = state.locks.some((lock) => lock.layer === action.latest.layer);
      return {
        ...state,
        locks: existing
          ? state.locks.map((lock) => (lock.layer === action.latest.layer ? action.latest : lock))
          : [...state.locks, action.latest],
        lastError: "lock_conflict",
      };
    }
    case "proposal_loaded":
      return {
        ...state,
        activeProposal: action.proposal,
        selectedChangeIds: [],
        lastError:
          action.proposal.proposal_id !== state.activeProposal?.proposal_id
            ? null
            : state.lastError,
      };
    case "proposal_status_changed":
      return state.activeProposal
        ? {
            ...state,
            activeProposal: { ...state.activeProposal, status: action.status },
            lastError: null,
          }
        : state;
    case "history_loaded":
      return { ...state, history: action.proposals };
    case "select_provider": {
      const provider = state.providers.find((candidate) => candidate.provider_id === action.providerId);
      if (!provider) return state;
      const modelExists = provider.models.some((model) => model.model_id === action.modelId);
      return {
        ...state,
        selectedProviderId: action.providerId,
        selectedModelId: modelExists ? action.modelId : provider.models[0]?.model_id ?? null,
      };
    }
    case "toggle_change": {
      const selected = state.selectedChangeIds.includes(action.changeId)
        ? state.selectedChangeIds.filter((id) => id !== action.changeId)
        : [...state.selectedChangeIds, action.changeId];
      return { ...state, selectedChangeIds: selected };
    }
    case "saved_revisions_changed":
      return {
        ...state,
        savedTemplateId: action.templateId,
        savedTemplateRevision: action.templateRevision,
        savedBindingRevision: action.bindingRevision,
        savedOverrideText: action.overrideText,
      };
    case "went_offline":
      return { ...state, status: "offline" };
    case "went_online":
      return { ...state, status: "ready" };
    case "error":
      return { ...state, lastError: action.code };
    case "stage_load_failed":
      return { ...state, lastError: "stage_load_failed", resourcesReady: false };
    default:
      return state;
  }
}
