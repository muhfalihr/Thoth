import type { StudioPane } from "./studio_viewport";

type CompactStudioNavProps = {
  panes: readonly { id: StudioPane; label: string }[];
  selected: StudioPane;
  onSelect: (pane: StudioPane) => void;
};

export function CompactStudioNav({ panes, selected, onSelect }: CompactStudioNavProps) {
  return (
    <nav aria-label="Studio panes" className="flex flex-wrap gap-1 border-b border-border bg-card px-2 py-1">
      {panes.map((pane) => (
        <button
          key={pane.id}
          type="button"
          aria-current={pane.id === selected ? "page" : undefined}
          onClick={() => onSelect(pane.id)}
          className="min-h-11 rounded-md px-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-semibold"
        >
          {pane.label}
        </button>
      ))}
    </nav>
  );
}
