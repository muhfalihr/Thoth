import type { StudioJob } from "./studio_viewport";

const jobs: readonly { id: StudioJob; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "prompt", label: "Prompt" },
  { id: "review", label: "Review" },
  { id: "render", label: "Render" },
];

export function StudioJobNav({ selected, onSelect }: { selected: StudioJob; onSelect: (job: StudioJob) => void }) {
  return (
    <nav aria-label="Studio jobs" className="flex flex-wrap gap-1">
      {jobs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-current={selected === id ? "page" : undefined}
          onClick={() => onSelect(id)}
          className="min-h-11 rounded-md px-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-semibold"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
