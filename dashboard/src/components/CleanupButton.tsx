import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeCode, formatBytes, type CleanupReport } from "@/api";

/**
 * The confirmation IS the feature. Deleting an artifact tree is irreversible, so
 * the control opens a panel, refuses to arm until the operator has typed the
 * exact id back, says plainly that it cannot be undone, and re-reads the facts
 * afterwards. Cancelling closes without touching the server.
 */
export function CleanupButton({
  id,
  trigger,
  disabled,
  disabledReason,
  onCleanup,
  onDone,
}: {
  id: string;
  /** Label of the closed control, e.g. "Delete package". */
  trigger: string;
  disabled?: boolean;
  disabledReason?: string;
  onCleanup: (id: string) => Promise<CleanupReport>;
  /** Re-read whatever facts the deletion invalidated. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const run = async () => {
    if (typed !== id || busy) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await onCleanup(id));
      close();
      onDone?.();
    } catch (e) {
      setError(describeCode(String(e).replace(/^Error:\s*\w+:\s*/, "")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {!open && (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => setOpen(true)}
        >
          {trigger}
        </Button>
      )}
      {open && (
        <div className="space-y-2 rounded border border-destructive/50 p-2">
          <p className="text-xs text-destructive">
            This permanently deletes the files on disk. It cannot be undone.
          </p>
          <label className="block text-xs text-muted-foreground" htmlFor={`confirm-${id}`}>
            Type {id} to confirm
          </label>
          <Input
            id={`confirm-${id}`}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={typed !== id || busy}
              onClick={run}
            >
              Delete forever
            </Button>
            <Button variant="outline" size="sm" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {report && (
        <p className="text-xs text-muted-foreground" data-testid="cleanup-result">
          Removed {report.removed_files} files ({formatBytes(report.removed_bytes)}). This cannot be
          undone.
        </p>
      )}
    </div>
  );
}
