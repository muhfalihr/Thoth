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

/**
 * A server render's own staged asset, one flat name below the bundle's static
 * base. The renderer stages each input inside the job workspace and serves that
 * directory itself, so the composition loads the same local copy it validated.
 */
const RENDER_SOURCE = /^\/public\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function safePreviewSource(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  return PREVIEW_SOURCE.test(source) || RENDER_SOURCE.test(source) ? source : undefined;
}
