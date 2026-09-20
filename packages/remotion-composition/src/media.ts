/**
 * The only media locations the composition will load.
 *
 * Anything with a scheme, host, query, fragment, or traversal is dropped, so a
 * document or an API response can never steer a media element off-origin or
 * smuggle a capability through the URL.
 */

/** A same-origin capability-cookie preview path the browser may load. */
const PREVIEW_SOURCE =
  /^\/api\/v1\/projects\/[A-Za-z0-9_-]+\/editor-assets\/[A-Za-z0-9_-]+\/preview$/;

export function safePreviewSource(source: string | undefined): string | undefined {
  return source && PREVIEW_SOURCE.test(source) ? source : undefined;
}
