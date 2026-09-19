import { useEffect, useRef, useState, type RefObject } from "react";

import type { ControlPlaneClient, EditorAsset } from "@/api/control-plane";

/** One page at a time: the library never pulls a whole project into memory. */
export const ASSET_PAGE_LIMIT = 20;

type Props = {
  client: Pick<ControlPlaneClient, "listEditorAssets" | "createEditorPreviewCapability">;
  projectId: string;
  /**
   * The editor's document generation. Every response compares against it, so a
   * page or capability that arrives after a document switch is dropped.
   */
  generationRef: RefObject<number>;
  onAssets: (assets: EditorAsset[], replace: boolean) => void;
  onAdd: (asset: EditorAsset) => void;
  onPreviewSource: (assetId: string, previewUrl: string) => void;
};

const action =
  "rounded border border-border px-2 py-0.5 text-[0.7rem] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

export function AssetLibrary({
  client,
  projectId,
  generationRef,
  onAssets,
  onAdd,
  onPreviewSource,
}: Props) {
  const [assets, setAssets] = useState<EditorAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Callbacks are read through a ref so a fresh inline handler never re-runs the load.
  const callbacks = useRef({ onAssets, onPreviewSource });
  callbacks.current = { onAssets, onPreviewSource };

  const load = (from?: string) => {
    const generation = generationRef.current;
    setLoading(true);
    void client
      .listEditorAssets(projectId, from, ASSET_PAGE_LIMIT)
      .then((page) => {
        if (generation !== generationRef.current) return;
        setAssets((current) => (from ? [...current, ...page.assets] : page.assets));
        setCursor(page.next_cursor ?? null);
        setFailed(false);
        callbacks.current.onAssets(page.assets, !from);
      })
      .catch(() => generation === generationRef.current && setFailed(true))
      .finally(() => generation === generationRef.current && setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per project or retry.
  }, [attempt, client, projectId]);

  const preview = (assetId: string) => {
    const generation = generationRef.current;
    void client
      .createEditorPreviewCapability(projectId, assetId)
      .then((capability) => {
        if (generation !== generationRef.current) return;
        // The locator goes straight to the player; it is never rendered or stored.
        callbacks.current.onPreviewSource(assetId, capability.preview_url);
      })
      .catch(() => undefined);
  };

  const ready = assets.filter((asset) => asset.validation_state === "ready");

  return (
    <section className="min-h-0 overflow-auto border-r border-border bg-card/60 p-3" aria-label="Asset library">
      <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Assets
      </h2>
      {failed ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>Assets are unavailable. Check your connection and try again.</p>
          <button
            type="button"
            className={action}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry loading assets
          </button>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {ready.map((asset) => (
              <li
                key={asset.asset_id}
                className="rounded border border-border bg-background/40 p-2 text-xs"
              >
                <span className="block truncate font-medium text-foreground">{asset.asset_id}</span>
                <span className="block text-muted-foreground">
                  {asset.kind}
                  {asset.duration_in_frames ? ` · ${asset.duration_in_frames}f` : ""}
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    className={action}
                    aria-label={`Add ${asset.asset_id} to timeline`}
                    onClick={() => onAdd(asset)}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={action}
                    aria-label={`Preview ${asset.asset_id}`}
                    onClick={() => preview(asset.asset_id)}
                  >
                    Preview
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {ready.length === 0 && !loading ? (
            <p className="text-xs text-muted-foreground">No ready assets yet</p>
          ) : null}
          {cursor ? (
            <button
              type="button"
              className={`${action} mt-2`}
              disabled={loading}
              onClick={() => load(cursor)}
            >
              Load more assets
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
