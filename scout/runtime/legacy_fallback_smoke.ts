import { connect } from '../lib/cdp.ts';

const client = await connect();
try {
  await client.navigate('about:blank#legacy-fallback-smoke', 0);
  if ((await client.evaluate('6 * 7')) !== 42) process.exit(70);
} finally {
  client.close();
}

process.exit(process.argv.includes('--fail') ? 17 : 0);
