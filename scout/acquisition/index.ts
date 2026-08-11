// index.ts — the acquisition kernel's public surface. Everything else in this
// directory (cache, browser_coordinator, materialize, network_capture,
// policy) is a kernel internal: import only from here.

export type { SearchContext, SearchPlatformKey } from '../scrapers/search_social_v2.ts';
// searchPlatform() is pipeline-facing keyword search (no adapter implements
// DiscoveryRequest.kind:'query'): it takes a kernel-built SearchContext
// (browse/registerIntent/inspectPost) — re-exported here so pipeline code
// reaches it through the facade instead of importing scrapers/ directly.
export { searchPlatform } from '../scrapers/search_social_v2.ts';
// Pipeline callers of browse() need the Platform for a URL to pass as its first
// argument. Exposing the kernel's own resolver beats each stage hand-rolling a
// host-to-platform switch that drifts from the adapters'.
export { platformForUrl } from './url.ts';
export type { AcquisitionRunContext } from './service.ts';
export {
  AcquisitionService,
  createStandaloneAcquisitionContext,
  runAcquisitionCli,
} from './service.ts';
export type {
  AcquisitionIntent,
  AcquisitionOutcome,
  AcquisitionReason,
  AcquisitionSource,
  AdapterContext,
  AssetPurpose,
  CommentLimits,
  CommentRecord,
  DiscoveryRequest,
  DiscoveryResult,
  LocalAsset,
  MediaAsset,
  Platform,
  PlatformAdapter,
  PostRecord,
  SocialCardPurpose,
} from './types.ts';
export { AcquisitionError } from './types.ts';
