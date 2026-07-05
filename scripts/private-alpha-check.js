const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN ?? '';

async function request(path, { admin = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(admin && adminToken ? { 'x-admin-token': adminToken } : {})
    }
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

function line(name, passed, detail = '') {
  return {
    name,
    passed,
    detail
  };
}

const checks = [];

const health = await request('/v1/health');
checks.push(line('health', health.ok && health.body?.ok === true, health.body?.runtime?.storageBackend));
checks.push(line(
  'database',
  Boolean(health.body?.runtime?.databaseConfigured),
  health.body?.runtime?.databaseConnection?.host ?? 'not configured'
));
checks.push(line(
  'x402 config',
  Boolean(health.body?.runtime?.payment?.x402?.configured),
  health.body?.runtime?.payment?.x402?.network ?? 'not configured'
));

const policy = await request('/v1/policy');
checks.push(line('policy', policy.ok && Array.isArray(policy.body?.assuranceTiers), 'assurance tiers available'));

const search = await request('/v1/search?limit=5');
checks.push(line('search', search.ok && Array.isArray(search.body?.results), `${search.body?.results?.length ?? 0} results`));

const manual = await request('/v1/payments/manual-usdc/instructions?amountUsdc=0.01');
checks.push(line(
  'manual usdc instructions',
  Boolean(manual.ok && manual.body?.instructions?.payTo),
  manual.body?.instructions?.network ?? manual.body?.error
));

const paidGate = await request('/v1/paid/market-snapshot');
checks.push(line('paid gate', paidGate.status === 402, paidGate.body?.error ?? `status ${paidGate.status}`));

if (adminToken) {
  const audit = await request('/v1/admin/audit', { admin: true });
  checks.push(line('admin dashboard api', audit.ok && audit.body?.totals, `payments ${audit.body?.totals?.paymentIntents ?? '-'}`));
} else {
  checks.push(line('admin dashboard api', true, 'skipped: ADMIN_TOKEN not set'));
}

const passed = checks.filter((check) => check.passed).length;
console.log(JSON.stringify({
  event: 'private_alpha_check',
  baseUrl,
  passed,
  total: checks.length,
  ok: passed === checks.length,
  checks
}, null, 2));

if (passed !== checks.length) {
  process.exit(1);
}
