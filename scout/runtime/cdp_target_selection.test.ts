import { describe, expect, test } from 'bun:test';

import { selectCdpTarget, type CdpTarget } from '../lib/cdp.ts';
import { isCdpTargetId, parseDevtoolsTargetPath } from '../lib/cdp_target.ts';

describe('CDP target identifiers', () => {
  test.each(['page-1', 'A_b.9', 'a', 'x'.repeat(128)])('accepts %s', (value) => {
    expect(isCdpTargetId(value)).toBe(true);
  });

  test.each(['', 'page/1', 'page?1', 'page 1', 'x'.repeat(129), null, 7])(
    'rejects %p',
    (value) => {
      expect(isCdpTargetId(value)).toBe(false);
    },
  );

  test('parses only page and browser DevTools paths', () => {
    expect(parseDevtoolsTargetPath('/devtools/page/page-1')).toEqual({
      kind: 'page',
      targetId: 'page-1',
    });
    expect(parseDevtoolsTargetPath('/devtools/browser/browser_1')).toEqual({
      kind: 'browser',
      targetId: 'browser_1',
    });
    expect(parseDevtoolsTargetPath('/devtools/worker/page-1')).toBeNull();
    expect(parseDevtoolsTargetPath('/devtools/page/page-1/extra')).toBeNull();
    expect(parseDevtoolsTargetPath('/devtools/page/page?1')).toBeNull();
  });
});

describe('selectCdpTarget', () => {
  const targets: CdpTarget[] = [
    {
      id: 'health-1',
      type: 'page',
      url: 'https://www.tiktok.com/',
      webSocketDebuggerUrl: 'ws://relay/devtools/page/health-1',
    },
    {
      id: 'leased-2',
      type: 'page',
      url: 'about:blank',
      webSocketDebuggerUrl: 'ws://relay/devtools/page/leased-2',
    },
  ];

  test('an owned target wins over hostname matching and discovery order', () => {
    expect(selectCdpTarget(targets, { match: 'tiktok.com' }, 'leased-2').id).toBe('leased-2');
  });

  test('an unavailable owned target never falls back to the health page', () => {
    expect(() => selectCdpTarget(targets, { match: 'tiktok.com' }, 'missing')).toThrow(
      'owned_cdp_target_unavailable',
    );
  });

  test('a malformed owned target is rejected without quoting it', () => {
    expect(() => selectCdpTarget(targets, {}, '../bad')).toThrow('owned_cdp_target_invalid');
  });

  test('normal callers retain hostname selection when no target is owned', () => {
    expect(selectCdpTarget(targets, { match: 'tiktok.com' }).id).toBe('health-1');
  });

  test('normal callers retain first-page fallback when matching is optional', () => {
    expect(selectCdpTarget(targets, { match: 'example.test' }).id).toBe('health-1');
  });

  test('normal callers retain requireMatch failure', () => {
    expect(() => selectCdpTarget(targets, { match: 'example.test', requireMatch: true })).toThrow();
  });
});
