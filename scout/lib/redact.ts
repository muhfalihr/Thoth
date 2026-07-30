// redact.ts — leaf module (imports nothing) holding the resolver-output scrubber.
// Lives apart from media_resolution.ts because verify.ts needs it too, and media_resolution.ts
// already imports verify.ts — keeping it here avoids an import cycle between the two.

export function sanitizeResolverDetail(value: string): string {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/gi, 'Authorization: [redacted]')
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/--cookies(?:-from-browser)?\s+\S+/gi, '--cookies [redacted]')
    .replace(
      /--(?:session(?:id)?|csrftoken|cookie|token|authorization|password|passwd|credential|secret|(?:client|private)[_-]?(?:secret|key)|(?:api|access|refresh|auth)[_-]?(?:key|token))\s+(?:"[^"]*"|'[^']*'|\S+)/gi,
      '--secret [redacted]',
    )
    .replace(
      /(["']?)(session(?:id)?|csrftoken|cookie|token|authorization|password|passwd|credential|secret|(?:client|private)[_-]?(?:secret|key)|(?:api|access|refresh|auth)[_-]?(?:key|token))\1\s*([=:])\s*(?:(["'])[^"'\r\n]*\4|[^\s,;&}]+)/gi,
      '$1$2$1$3$4[redacted]$4',
    )
    .replace(/(["'])[A-Za-z]:[\\/][^\r\n]*?\1/g, '$1[path]$1')
    .replace(/[A-Za-z]:[\\/](?:[^\r\n]*?[\\/])?Temp[\\/][^\r\n]*/gi, '[path]')
    .replace(/[A-Za-z]:[\\/][^\s"'`,;)]+/g, '[path]')
    .replace(/(["'])(?:\/tmp|\/var\/tmp|\/private\/tmp)\/[^\r\n]*?\1/g, '$1[path]$1')
    .replace(/(^|[\s"'=(:])(?:\/tmp|\/var\/tmp|\/private\/tmp)\/[^\r\n]*/g, '$1[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
