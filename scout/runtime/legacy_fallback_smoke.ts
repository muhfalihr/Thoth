import { connect } from '../lib/cdp.ts';

const client = await connect();
try {
  await client.navigate('about:blank#legacy-fallback-smoke', 0);
  if ((await client.evaluate('6 * 7')) !== 42) process.exit(70);
  const requestedHold = Number(process.env.THOTH_LEGACY_FALLBACK_SMOKE_HOLD_MS ?? '0');
  const hold = Number.isFinite(requestedHold) ? Math.max(0, Math.min(requestedHold, 2_000)) : 0;
  if (hold > 0) await Bun.sleep(hold);
} finally {
  client.close();
}

process.exit(process.argv.includes('--fail') ? 17 : 0);
