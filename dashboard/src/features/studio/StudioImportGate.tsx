import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import {
  StudioImportRequestError,
  type ControlPlaneClient,
  type EditorAsset,
  type ResolveStudioImportItem,
  type StudioImportInventory,
  type StudioImportItem,
  type StudioSourceInspection,
  type StudioSourceProjection,
} from "@/api/control-plane";
import "./studio.css";

export type StudioImportClient = Pick<
  ControlPlaneClient,
  | "inspectStudioImport"
  | "createStudioImport"
  | "listStudioImportDrafts"
  | "getStudioImportInventory"
  | "resolveStudioImportItem"
  | "uploadEditorAsset"
  | "listEditorAssets"
>;

type StudioImportGateProps = {
  client: StudioImportClient;
  projectId: string;
  source: StudioSourceProjection;
  /** Reopened from Studio: show this draft's inventory first instead of the draft choice. */
  resumeDocumentId?: string;
  onOpen: (documentId: string) => void;
  onClose: () => void;
};

const ROLE_LABELS = { main: "Main", main_footage: "Main footage", footage: "Footage", comment: "Comment" } as const;
const UPLOAD_TYPES = { video: "video/mp4,video/webm", image: "image/jpeg,image/png,image/webp" } as const;

// Fixed words for each known failure; the server's own text never reaches the page.
const MESSAGES: Record<string, string> = {
  upload_too_large: "That file is too large to upload.",
  unsupported_media_type: "That file type is not supported.",
  asset_unavailable: "That asset is not ready to use.",
  asset_kind_mismatch: "That asset is the wrong kind for this item.",
  attach_rejected: "Studio could not place that asset in its scene.",
  item_not_attachable: "This item has no media to attach.",
  trim_exceeds_asset: "This item's trim starts after that asset ends. Choose a longer asset or exclude the item.",
  asset_duration_unknown: "The length of that asset is unknown, so its source range cannot be kept.",
};

function failure(error: unknown, fallback: string): string {
  if (!(error instanceof StudioImportRequestError)) return fallback;
  if (error.status === null) return "Offline — reconnect and try again.";
  return (error.code && MESSAGES[error.code]) || fallback;
}

const buttonClass =
  "min-h-11 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const sectionLabel = "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground";

/**
 * The choice behind Open in Studio: resume a draft made from this source or
 * create a new one, then attach or exclude each source item the draft cannot
 * play yet. Inspecting never writes; every decision is saved on the draft.
 */
export function StudioImportGate({ client, projectId, source, resumeDocumentId, onOpen, onClose }: StudioImportGateProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const inventoryHeading = useRef<HTMLHeadingElement>(null);
  const placedFocus = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [inspection, setInspection] = useState<StudioSourceInspection>();
  const [listFailure, setListFailure] = useState<string>();
  const [selected, setSelected] = useState<string>();
  // A create that failed keeps its key, so an explicit retry can never make a second draft.
  const [pendingKey, setPendingKey] = useState<string>();
  const [inventory, setInventory] = useState<StudioImportInventory>();
  const [assets, setAssets] = useState<EditorAsset[] | "failed">();
  const [attaching, setAttaching] = useState<string>();
  const [choice, setChoice] = useState<string>();
  const [alert, setAlert] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setListFailure(undefined);
    client.inspectStudioImport(projectId, source).then(
      (result) => {
        if (alive) setInspection(result);
      },
      (error: unknown) => {
        if (!alive) return;
        setListFailure(
          error instanceof StudioImportRequestError && error.status === null
            ? "Offline — reconnect to list drafts."
            : "Drafts could not be listed. Try again.",
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [client, projectId, source, attempt]);

  useEffect(() => {
    const trigger = globalThis.document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => trigger?.focus?.();
  }, []);

  useEffect(() => {
    if (placedFocus.current || !inspection) return;
    placedFocus.current = true;
    panel.current?.querySelector<HTMLElement>('input[type="radio"], [data-create]')?.focus();
  }, [inspection]);

  const documentId = inventory?.document_id;
  useEffect(() => {
    if (documentId) inventoryHeading.current?.focus();
  }, [documentId]);

  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [
      ...panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)"),
    ];
    const active = globalThis.document.activeElement;
    if (event.shiftKey && (active === focusable[0] || active === panel.current)) {
      event.preventDefault();
      focusable.at(-1)?.focus();
    } else if (!event.shiftKey && active === focusable.at(-1)) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  };

  const openDraft = async (draftId: string, sourceKey: string) => {
    setBusy(true);
    setAlert(undefined);
    try {
      setInventory(await client.getStudioImportInventory(projectId, draftId));
    } catch (error) {
      if (!(error instanceof StudioImportRequestError && error.status === 404)) {
        setAlert(failure(error, "The draft could not be opened. Try again."));
        return;
      }
      // A draft that is gone is never replaced silently: the list is refreshed and the creator chooses again.
      setAlert("That draft is no longer available. The draft list has been refreshed.");
      setSelected(undefined);
      if (!sourceKey) return; // reopened before the list loaded: the inspect under way refreshes it
      try {
        const list = await client.listStudioImportDrafts(projectId, sourceKey);
        setInspection((current) => current && { ...current, drafts: list.drafts, more_drafts: list.more_drafts });
      } catch {
        // The alert already says what happened; the stale row stays until the next refresh.
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (resumeDocumentId) void openDraft(resumeDocumentId, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the draft the gate was reopened with.
  }, []);

  const create = async () => {
    if (!inspection) return;
    const key = pendingKey ?? crypto.randomUUID();
    setPendingKey(key);
    setBusy(true);
    setAlert(undefined);
    let draftId: string;
    try {
      const draft = await client.createStudioImport(projectId, { source, source_key: inspection.source_key }, key);
      draftId = draft.document_id;
      setInspection((current) =>
        current && {
          ...current,
          drafts: [draft, ...(current.drafts ?? []).filter((entry) => entry.document_id !== draft.document_id)],
        },
      );
    } catch (error) {
      if (error instanceof StudioImportRequestError && error.status === 409) {
        // The source moved since it was inspected: inspect again rather than create blind.
        setPendingKey(undefined);
        setInspection(undefined);
        setAttempt((count) => count + 1);
        setAlert("This source changed since it was inspected. Choose again.");
      } else {
        setAlert(failure(error, "The draft could not be created. Try again."));
      }
      setBusy(false);
      return;
    }
    setPendingKey(undefined);
    setSelected(draftId);
    await openDraft(draftId, inspection.source_key);
  };

  const resolve = async (item: StudioImportItem, decision: ResolveStudioImportItem["decision"]) => {
    if (!inventory) return;
    setBusy(true);
    setAlert(undefined);
    try {
      setInventory(
        await client.resolveStudioImportItem(projectId, inventory.document_id, item.item_id, {
          base_revision: inventory.revision,
          decision,
        }),
      );
      setAttaching(undefined);
    } catch (error) {
      if (!(error instanceof StudioImportRequestError && error.status === 409)) {
        setAlert(failure(error, "The decision could not be saved. Try again."));
        return;
      }
      setAlert(
        (error.code && MESSAGES[error.code]) ||
          "This draft changed elsewhere. The inventory has been refreshed; choose again.",
      );
      try {
        setInventory(await client.getStudioImportInventory(projectId, inventory.document_id));
      } catch {
        // Keep the inventory on screen; the next decision reports its own conflict.
      }
    } finally {
      setBusy(false);
    }
  };

  const upload = async (item: StudioImportItem, file: File) => {
    setBusy(true);
    setAlert(undefined);
    let uploaded: EditorAsset;
    try {
      uploaded = await client.uploadEditorAsset(projectId, file);
    } catch (error) {
      setAlert(failure(error, "The upload failed. Try again."));
      setBusy(false);
      return;
    }
    setAssets((current) => (Array.isArray(current) ? [uploaded, ...current] : current));
    await resolve(item, { kind: "attach_asset", asset_id: uploaded.asset_id });
  };

  const toggleAttach = (itemId: string) => {
    setAttaching((current) => (current === itemId ? undefined : itemId));
    setChoice(undefined);
    if (Array.isArray(assets)) return;
    // ponytail: first page of 50 assets only; page through when projects hold more.
    client.listEditorAssets(projectId, undefined, 50).then(
      (page) => setAssets(page.assets),
      () => setAssets("failed"),
    );
  };

  const main = source.items[0];
  const title = main?.title ? `Open in Studio — ${main.title}` : "Open in Studio";
  const drafts = inspection?.drafts ?? [];
  const textScenes = source.items.filter(
    (item, index) => index > 0 && item.role !== "main_footage" && item.media_kind === "none" && (item.title || item.text),
  ).length;

  const attachPanel = (item: StudioImportItem) => {
    const kind = item.media_kind === "image" ? "image" : "video";
    const ready = Array.isArray(assets)
      ? assets.filter((asset) => asset.validation_state === "ready" && asset.kind === kind)
      : [];
    const chosen = choice ?? ready[0]?.asset_id;
    return (
      <div className="col-span-full mt-2 space-y-2 rounded-md border border-border bg-background/60 p-3 text-sm">
        <label className={`${buttonClass} inline-flex cursor-pointer items-center focus-within:ring-2 focus-within:ring-ring`}>
          Upload file
          <input
            type="file"
            className="sr-only"
            accept={UPLOAD_TYPES[kind]}
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(item, file);
            }}
          />
        </label>
        {chosen ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor={`${id}-${item.item_id}-asset`} className="block text-xs text-muted-foreground">
                Ready asset
              </label>
              <select
                id={`${id}-${item.item_id}-asset`}
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={chosen}
                disabled={busy}
                onChange={(event) => setChoice(event.target.value)}
              >
                {ready.map((asset) => (
                  <option key={asset.asset_id} value={asset.asset_id}>
                    {asset.asset_id}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void resolve(item, { kind: "attach_asset", asset_id: chosen })}
            >
              Attach selected asset
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {assets === undefined
              ? "Loading ready assets…"
              : assets === "failed"
                ? "Ready assets could not be loaded. Close and reopen Attach to try again."
                : `No ready ${kind} in this project yet.`}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="studio-shell flex h-full w-full flex-col overflow-hidden bg-card text-foreground outline-none sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:rounded-lg sm:border sm:border-border"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 truncate text-base font-semibold">
            {title}
          </h2>
          <button type="button" className={buttonClass} onClick={onClose}>
            Close
          </button>
        </header>
        {alert ? (
          <p
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="mx-4 mt-3 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm outline-none"
          >
            {alert}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {inventory ? (
            <>
              <h3 ref={inventoryHeading} tabIndex={-1} className={`${sectionLabel} outline-none`}>
                Source inventory — what this Studio edit contains
              </h3>
              <ol aria-label="Source inventory" className="mt-2">
                {inventory.items.map((item, index) => {
                  const excluded = item.disposition === "excluded";
                  return (
                    <li
                      key={item.item_id}
                      aria-label={item.label}
                      className="grid grid-cols-[2rem_1fr] items-center gap-x-3 gap-y-1 border-b border-border py-3 sm:grid-cols-[2rem_7rem_1fr_auto]"
                    >
                      <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
                      <span className="text-xs text-muted-foreground">{item.role ? ROLE_LABELS[item.role] : "Source"}</span>
                      <span className="col-start-2 min-w-0 sm:col-start-auto">
                        <span className={`block truncate text-sm ${excluded ? "text-muted-foreground line-through" : ""}`}>
                          {item.label}
                        </span>
                        {item.reason ? <span className="block text-xs text-muted-foreground">{item.reason}</span> : null}
                      </span>
                      <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-auto">
                        <span className="flex items-center gap-1.5 text-xs">
                          <span
                            aria-hidden
                            className={`size-2 rounded-full ${
                              item.disposition === "unresolved" ? "bg-destructive" : "bg-muted-foreground"
                            }`}
                          />
                          <span>
                            {item.disposition === "attached"
                              ? `Attached · ${item.asset_id}`
                              : excluded
                                ? "Excluded"
                                : "Unresolved"}
                          </span>
                        </span>
                        {item.disposition === "unresolved" ? (
                          <>
                            {item.media_kind !== "none" ? (
                              <button
                                type="button"
                                className={buttonClass}
                                aria-expanded={attaching === item.item_id}
                                disabled={busy}
                                onClick={() => toggleAttach(item.item_id)}
                              >
                                Attach…
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={busy}
                              onClick={() => void resolve(item, { kind: "exclude" })}
                            >
                              Exclude from Studio edit
                            </button>
                          </>
                        ) : null}
                      </span>
                      {attaching === item.item_id && item.disposition === "unresolved" ? attachPanel(item) : null}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                {main?.media_kind === "none" ? <p>The main post has no media. It opens as a text scene.</p> : null}
                {textScenes ? (
                  <p>{`${textScenes} more ${textScenes === 1 ? "item opens" : "items open"} as a text scene.`}</p>
                ) : null}
              </div>
            </>
          ) : (
            <fieldset disabled={busy}>
              <legend className={sectionLabel}>Drafts for this source</legend>
              {!inspection ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  <p>{listFailure ?? "Listing drafts…"}</p>
                  {listFailure ? (
                    <button type="button" className={buttonClass} onClick={() => setAttempt((count) => count + 1)}>
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : drafts.length ? (
                <div className="mt-2 space-y-1">
                  {drafts.map((draft) => (
                    <label
                      key={draft.document_id}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent has-[:checked]:bg-accent"
                    >
                      <input
                        type="radio"
                        name={`${id}-draft`}
                        value={draft.document_id}
                        checked={selected === draft.document_id}
                        onChange={() => setSelected(draft.document_id)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          setSelected(draft.document_id);
                          void openDraft(draft.document_id, inspection.source_key);
                        }}
                      />
                      <span>
                        {`Draft · revision ${draft.revision} · created `}
                        <span className="text-muted-foreground">
                          {new Date(draft.created_at).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </span>
                      </span>
                    </label>
                  ))}
                  {inspection.more_drafts ? (
                    <p className="px-3 text-xs text-muted-foreground">{`Showing the newest ${drafts.length} drafts.`}</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No drafts for this source yet.</p>
              )}
            </fieldset>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-4 py-3">
          {inventory ? (
            <>
              <p className="mr-auto text-sm">
                {inventory.items.length
                  ? `${inventory.items.filter((item) => item.disposition === "unresolved").length} of ${inventory.items.length} items unresolved`
                  : "Nothing to resolve."}
              </p>
              <button
                type="button"
                className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
                onClick={() => onOpen(inventory.document_id)}
              >
                Continue in Studio
              </button>
            </>
          ) : (
            <>
              {drafts.length ? (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || !selected}
                  onClick={() => selected && inspection && void openDraft(selected, inspection.source_key)}
                >
                  Resume
                </button>
              ) : null}
              <button
                type="button"
                data-create
                className={`${buttonClass} border-primary text-primary`}
                disabled={busy || !inspection}
                onClick={() => void create()}
              >
                {pendingKey && !busy ? "Retry create" : "Create new draft"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
