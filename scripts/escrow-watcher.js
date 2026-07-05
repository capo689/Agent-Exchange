#!/usr/bin/env node

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN;

function optionalNumberEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

if (!adminToken) {
  console.error(JSON.stringify({
    ok: false,
    error: 'ADMIN_TOKEN is required.'
  }, null, 2));
  process.exit(1);
}

const body = {
  fromBlock: optionalNumberEnv('ESCROW_WATCHER_FROM_BLOCK'),
  toBlock: optionalNumberEnv('ESCROW_WATCHER_TO_BLOCK'),
  lookbackBlocks: optionalNumberEnv('ESCROW_WATCHER_LOOKBACK_BLOCKS')
};

const response = await fetch(`${baseUrl}/v1/admin/escrow-watcher/run`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-admin-token': adminToken
  },
  body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)))
});
const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload.watcherRun?.ok === false) process.exitCode = 1;
