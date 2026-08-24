// Preloaded by bunfig.toml for component tests. Registers a DOM (happy-dom) on
// the global scope so @testing-library/react can render into it under `bun test`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// happy-dom doesn't implement these DOM methods that base-ui primitives
// (ScrollArea, Select) call during render. Stub them so component tests render.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// happy-dom ships no EventSource. Components that subscribe to the job stream
// only ever construct one and close it, so an inert stub is enough — tests
// drive state through the fetch snapshot instead of the live stream.
// ponytail: no event dispatch; add it when a test needs to push an SseEvent.
if (!("EventSource" in globalThis)) {
  class InertEventSource {
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  (globalThis as Record<string, unknown>).EventSource = InertEventSource;
}
