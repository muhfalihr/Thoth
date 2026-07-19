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
