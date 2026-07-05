const baseUrl = process.env.AGENT_EXCHANGE_URL ?? 'http://localhost:8787';
const adminToken = process.env.ADMIN_TOKEN;

if (!adminToken) {
  console.error('ADMIN_TOKEN is required to run reconciliation.');
  process.exit(2);
}

const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/admin/reconciliation`, {
  headers: {
    'x-admin-token': adminToken
  }
});

const body = await response.json().catch(() => null);
console.log(JSON.stringify({
  status: response.status,
  ok: response.ok,
  body
}, null, 2));

if (!response.ok) process.exit(1);
if (body?.reconciliation?.ok !== true) process.exit(1);
