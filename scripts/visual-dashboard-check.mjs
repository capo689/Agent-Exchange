import { chromium } from 'playwright';

const baseUrl = process.env.AGENT_EXCHANGE_URL ?? 'http://localhost:8787';
const outputDir = process.env.VISUAL_OUTPUT_DIR ?? '/private/tmp';
const adminToken = process.env.ADMIN_TOKEN ?? 'test-admin-token';

const sampleAudit = {
  generatedAt: new Date().toISOString(),
  runtime: {
    storageBackend: 'postgres',
    databaseConfigured: true,
    databaseConnection: { host: 'postgres.pedsewmsotfpvuxrohkv' },
    adminConfigured: true,
    supabaseConfigured: true,
    supabaseJwksConfigured: true,
    maxJsonBodyBytes: 1048576,
    rateLimit: { enabled: true },
    marketplace: { mode: 'free_beta' },
    payment: { enabled: false }
  },
  totals: {
    agents: 128,
    listings: 342,
    offers: 119,
    trades: 76,
    escrowEvents: 154,
    paymentIntents: 154,
    paymentEvents: 24,
    reputationEvents: 203,
    ratings: 44,
    disputes: 3,
    feedback: 19,
    settlementInterest: 12
  },
  breakdowns: {
    listingsByStatus: { ACTIVE: 286, RESERVED: 41, CLOSED: 15 },
    listingsByAssuranceTier: { 0: 33, 1: 141, 2: 118, 3: 50 },
    offersByStatus: { OPEN: 69, COUNTERED: 18, ACCEPTED: 24, EXPIRED: 8 },
    tradesByState: { CREATED: 12, ACCEPTED: 20, FUNDED: 14, DELIVERED: 9, CAPTURED: 18, DISPUTED: 3 },
    paymentIntentsByProvider: { sandbox: 144, manual_usdc: 10 },
    paymentIntentsByStatus: { SUCCEEDED: 139, PENDING: 12, DECLINED: 3 }
  },
  recent: {
    trades: [
      { id: 'trd_79db2a23-a19b-443a-b333-cb8170a77190', buyerAgentId: 'agt_quant_buyer_2049', sellerAgentId: 'agt_compute_seller_0081', state: 'CAPTURED', priceUsdc: '19.840000', createdAt: new Date().toISOString() },
      { id: 'trd_ea69e8e1-2214-4012-a25a-5dab881e62df', buyerAgentId: 'agt_data_router_7712', sellerAgentId: 'agt_model_host_1300', state: 'FUNDED', priceUsdc: '84.120000', createdAt: new Date(Date.now() - 120000).toISOString() },
      { id: 'trd_86ab1563-93bc-48dc-a06a-8179d4bad2bd', buyerAgentId: 'agt_eval_runner_9910', sellerAgentId: 'agt_labeler_pool_4401', state: 'DISPUTED', priceUsdc: '12.500000', createdAt: new Date(Date.now() - 240000).toISOString() }
    ],
    reputationEvents: [
      { agentId: 'agt_compute_seller_0081', delta: 3, previousScore: 91, newScore: 94, reason: 'TRADE_CAPTURED', createdAt: new Date().toISOString() },
      { agentId: 'agt_quant_buyer_2049', delta: 1, previousScore: 82, newScore: 83, reason: 'TRADE_CAPTURED', createdAt: new Date(Date.now() - 60000).toISOString() },
      { agentId: 'agt_labeler_pool_4401', delta: -3, previousScore: 47, newScore: 44, reason: 'TRADE_REFUNDED', createdAt: new Date(Date.now() - 180000).toISOString() }
    ],
    escrowEvents: [
      { tradeId: 'trd_79db2a23-a19b-443a-b333-cb8170a77190', type: 'CAPTURE_STUB', amountUsdc: '19.840000', adapter: 'sandbox', createdAt: new Date().toISOString() },
      { tradeId: 'trd_ea69e8e1-2214-4012-a25a-5dab881e62df', type: 'AUTHORIZE_STUB', amountUsdc: '84.120000', adapter: 'sandbox', createdAt: new Date(Date.now() - 120000).toISOString() }
    ],
    paymentIntents: [
      { id: 'pay_authorize_001', tradeId: 'trd_ea69e8e1-2214-4012-a25a-5dab881e62df', provider: 'sandbox', action: 'AUTHORIZE', amountUsdc: '84.120000', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 120000).toISOString() },
      { id: 'pay_capture_001', tradeId: 'trd_79db2a23-a19b-443a-b333-cb8170a77190', provider: 'sandbox', action: 'CAPTURE', amountUsdc: '19.840000', status: 'SUCCEEDED', createdAt: new Date().toISOString() },
      { id: 'pay_declined_001', tradeId: 'trd_declined_0001', provider: 'manual_usdc', action: 'AUTHORIZE', amountUsdc: '11.000000', status: 'DECLINED', createdAt: new Date(Date.now() - 200000).toISOString() }
    ],
    paymentEvents: [
      { id: 'evt_sandbox_001', paymentIntentId: 'pay_capture_001', provider: 'sandbox', type: 'sandbox.payment_succeeded', status: 'SUCCEEDED', createdAt: new Date(Date.now() - 30000).toISOString() }
    ],
    ratings: [
      { id: 'rat_001', raterAgentId: 'agt_quant_buyer_2049', targetAgentId: 'agt_compute_seller_0081', targetRole: 'seller', score: 5, tags: ['fast', 'accurate'], createdAt: new Date(Date.now() - 90000).toISOString() },
      { id: 'rat_002', raterAgentId: 'agt_model_host_1300', targetAgentId: 'agt_data_router_7712', targetRole: 'buyer', score: 4, tags: ['clear_scope'], createdAt: new Date(Date.now() - 180000).toISOString() }
    ],
    disputes: [
      { id: 'dsp_001', tradeId: 'trd_86ab1563-93bc-48dc-a06a-8179d4bad2bd', openedByAgentId: 'agt_eval_runner_9910', reason: 'quality_issue', status: 'evidence', priority: 'high', requestedResolution: 'split', evidence: [{ type: 'text' }], createdAt: new Date(Date.now() - 240000).toISOString() }
    ],
    moderationEvents: [
      { type: 'policy.blocked_listing', reportable: true, createdAt: new Date(Date.now() - 80000).toISOString() },
      { type: 'policy.review_warning', reportable: false, createdAt: new Date(Date.now() - 220000).toISOString() }
    ],
    auditEvents: [
      { id: 'aud_1', type: 'trade.transitioned', severity: 'info', resourceType: 'trade', resourceId: 'trd_79db2a23-a19b-443a-b333-cb8170a77190', payload: { to: 'CAPTURED' }, createdAt: new Date().toISOString() },
      { id: 'aud_2', type: 'policy.blocked_listing', severity: 'critical', resourceType: 'moderation_event', resourceId: 'mod_critical_001', payload: { reportable: true }, createdAt: new Date(Date.now() - 80000).toISOString() },
      { id: 'aud_3', type: 'agent.flagged', severity: 'warn', resourceType: 'agent', resourceId: 'agt_labeler_pool_4401', payload: { reason: 'Manual review' }, createdAt: new Date(Date.now() - 180000).toISOString() }
    ],
    requestLogs: [
      { id: 'reqlog_1', requestId: 'req_live_001', method: 'POST', path: '/v1/trades/trd_79db2a23/confirm', status: 200, latencyMs: 18.4, createdAt: new Date().toISOString() },
      { id: 'reqlog_2', requestId: 'req_live_002', method: 'POST', path: '/v1/listings', status: 422, latencyMs: 11.7, errorCode: 'prohibited_listing', createdAt: new Date(Date.now() - 80000).toISOString() },
      { id: 'reqlog_3', requestId: 'req_live_003', method: 'POST', path: '/v1/agents/register', status: 429, latencyMs: 1.2, errorCode: 'rate_limited', createdAt: new Date(Date.now() - 140000).toISOString() }
    ],
    feedback: [
      { topic: 'would_use', senderId: 'tester-agent-17', actorAgentId: 'agt_quant_buyer_2049', text: 'Would use this with escrow and agent reputation exposed through MCP.', wouldUse: 'yes', wantsTransactionsEscrow: 'yes', wantsBidding: 'yes', countForSender: 3, limits: { maxMessagesPerSender: 20 }, createdAt: new Date(Date.now() - 210000).toISOString() }
    ],
    settlementInterest: [
      { source: 'trade_wall', senderId: 'tester-agent-17', actorAgentId: 'agt_quant_buyer_2049', message: 'Settlement disabled is the current blocker for paid trades.', countForSender: 2, limits: { maxSignalsPerSender: 20 }, createdAt: new Date(Date.now() - 190000).toISOString() }
    ]
  }
};

const sampleReconciliation = {
  reconciliation: {
    generatedAt: new Date().toISOString(),
    ok: true,
    counts: {
      paymentIntents: 154,
      paymentEvents: 24,
      escrowEvents: 154,
      trades: 76,
      findings: 0,
      errors: 0,
      warnings: 0
    },
    findings: []
  }
};

async function renderDashboard(page) {
  await page.route('**/v1/admin/audit', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleAudit)
    });
  });
  await page.route('**/v1/admin/reconciliation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleReconciliation)
    });
  });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
  await page.locator('#admin-token').fill(adminToken);
  await page.locator('button[type="submit"]').click();
  await page.locator('#dashboard:not(.hidden)').waitFor({ timeout: 5000 });
}

async function capture(viewport, path) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await renderDashboard(page);
  await page.screenshot({ path, fullPage: true });
  const metrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    panelCount: document.querySelectorAll('.panel').length,
    dashboardVisible: !document.querySelector('#dashboard').classList.contains('hidden')
  }));
  await page.close();
  return { path, metrics };
}

const browser = await chromium.launch({ headless: true });
try {
  const desktop = await capture({ width: 1440, height: 1000 }, `${outputDir}/ax-dashboard-desktop.png`);
  const mobile = await capture({ width: 390, height: 900 }, `${outputDir}/ax-dashboard-mobile.png`);
  console.log(JSON.stringify({ desktop, mobile }, null, 2));
} finally {
  await browser.close();
}
