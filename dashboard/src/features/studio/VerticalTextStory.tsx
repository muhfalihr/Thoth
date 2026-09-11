import { AbsoluteFill, Sequence } from "remotion";

import type { EditDocument } from "@/api/control-plane";
import { getOrderedTextClips } from "./preview";

export function VerticalTextStory({ document }: { document: EditDocument }) {
  return (
    <AbsoluteFill className="bg-zinc-950 p-16 text-white">
      {getOrderedTextClips(document).map((clip) => (
        <Sequence key={clip.clip_id} from={clip.start_frame} durationInFrames={clip.duration_in_frames}>
          <AbsoluteFill className="items-center justify-center gap-6 text-center">
            <h1 className="max-w-[80%] text-6xl font-bold leading-tight">{clip.heading}</h1>
            {clip.body && <p className="max-w-[72%] text-3xl text-zinc-300">{clip.body}</p>}
          </AbsoluteFill>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
