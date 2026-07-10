import { spawnSync } from 'node:child_process';

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const runReferenceBot = process.argv.includes('--bot') || process.env.RUN_REFERENCE_BOT === '1';

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${payload?.message ?? payload?.error ?? text}`);
  }

  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await request('/v1/health');
assert(health.ok === true, 'health.ok was not true');
assert(health.runtime?.storageBackend === 'postgres', `expected postgres backend, got ${health.runtime?.storageBackend}`);
assert(health.runtime?.databaseConfigured === true, 'database is not configured');
assert(health.runtime?.databaseConnection?.parseable === true, 'DATABASE_URL is not parseable');

const search = await request('/v1/search?limit=5');
assert(Array.isArray(search.results), 'GET /v1/search did not return a results array');

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  storageBackend: health.runtime.storageBackend,
  databaseHost: health.runtime.databaseConnection.host,
  adminConfigured: health.runtime.adminConfigured,
  marketplaceMode: health.runtime.marketplace?.mode,
  paymentsEnabled: health.runtime.payment?.enabled,
  escrowEnabled: health.runtime.payment?.escrowEnabled,
  searchResults: search.results.length
}, null, 2));

if (runReferenceBot) {
  const result = spawnSync(process.execPath, ['examples/reference-bots.js'], {
    env: { ...process.env, AGENT_EXCHANGE_URL: baseUrl },
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`reference bot failed with exit code ${result.status}`);
  }
}
