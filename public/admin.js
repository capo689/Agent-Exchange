const state = {
  token: sessionStorage.getItem('ax_admin_token') ?? '',
  timer: null,
  selection: null
};

const colors = ['#4fc3bd', '#e0b94a', '#ed6a5a', '#9f8cff', '#49d18f', '#d88fd8'];
const totals = [
  ['agents', 'Agents'],
  ['listings', 'Listings'],
  ['offers', 'Offers'],
  ['trades', 'Trades'],
  ['escrowEvents', 'Escrow'],
  ['paymentIntents', 'Payments'],
  ['reputationEvents', 'Reputation']
];

function $(id) {
  return document.getElementById(id);
}

function text(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function esc(value) {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortId(value) {
  if (!value) return '-';
  const raw = String(value);
  return raw.length <= 14 ? raw : `${raw.slice(0, 7)}...${raw.slice(-4)}`;
}

function time(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function setGate(visible) {
  $('gate').classList.toggle('hidden', !visible);
  $('dashboard').classList.toggle('hidden', visible);
}

async function fetchAudit() {
  return fetchAdmin('/v1/admin/audit');
}

async function fetchAdmin(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-admin-token': state.token, ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'Audit request failed');
  }
  return payload;
}

async function postAdmin(path, body = {}) {
  return fetchAdmin(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function renderTotals(data) {
  $('totals').innerHTML = totals.map(([key, label], index) => `
    <article class="metric" style="--accent:${colors[index % colors.length]}">
      <div>
        <span class="label">${esc(label)}</span>
        <strong>${esc(data.totals[key])}</strong>
      </div>
      <span class="spark" aria-hidden="true"></span>
    </article>
  `).join('');
}

function renderBars(id, counts) {
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  const fallback = '<div class="empty">No data</div>';
  $(id).innerHTML = entries.length ? entries.map(([name, count], index) => `
    <div class="bar-row">
      <span>${esc(name)}</span>
      <span class="bar-track">
        <span class="bar-fill" style="--w:${Math.max(4, (count / max) * 100)}%;--accent:${colors[index % colors.length]}"></span>
      </span>
      <strong>${esc(count)}</strong>
    </div>
  `).join('') : fallback;
}

function renderTrades(trades) {
  $('trades-table').innerHTML = trades.length ? trades.map((trade) => `
    <div class="table-row" data-resource="trades" data-resource-id="${esc(trade.id)}">
      <span><strong>${esc(shortId(trade.id))}</strong></span>
      <span data-resource="agents" data-resource-id="${esc(trade.buyerAgentId)}">${esc(shortId(trade.buyerAgentId))}</span>
      <span data-resource="agents" data-resource-id="${esc(trade.sellerAgentId)}">${esc(shortId(trade.sellerAgentId))}</span>
      <span class="chip">${esc(trade.state)}</span>
      <span>${esc(trade.priceUsdc)} USDC</span>
    </div>
  `).join('') : '<div class="empty">No trades</div>';
}

function renderReputation(events) {
  $('reputation-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event" data-resource="agents" data-resource-id="${esc(event.agentId)}">
      <strong>${esc(`${event.delta > 0 ? '+' : ''}${event.delta} ${text(event.reason)}`)}</strong>
      <span class="subtle">${esc(shortId(event.agentId))} ${esc(event.previousScore)} -> ${esc(event.newScore)}</span>
      <span class="subtle">${esc(time(event.createdAt))}</span>
    </div>
  `).join('') : '<div class="empty">No reputation events</div>';
}

function renderEscrow(events) {
  $('escrow-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event" data-resource="trades" data-resource-id="${esc(event.tradeId)}">
      <strong>${esc(event.type)} ${esc(event.amountUsdc)} USDC</strong>
      <span class="subtle">${esc(shortId(event.tradeId))} via ${esc(event.adapter)}</span>
      <span class="subtle">${esc(time(event.createdAt))}</span>
    </div>
  `).join('') : '<div class="empty">No escrow events</div>';
}

function renderPayments(intents, events) {
  const rows = [
    ...(intents ?? []).map((intent) => ({
      kind: 'intent',
      at: intent.createdAt,
      label: `${intent.action} ${intent.amountUsdc} USDC`,
      meta: `${intent.status} ${shortId(intent.tradeId)}`
    })),
    ...(events ?? []).map((event) => ({
      kind: 'webhook',
      at: event.createdAt,
      label: event.type,
      meta: `${event.status} ${shortId(event.paymentIntentId)}`
    }))
  ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 12);

  $('payment-stream').innerHTML = rows.length ? rows.map((row) => `
    <div class="event">
      <strong>${esc(row.label)} <span class="chip">${esc(row.kind)}</span></strong>
      <span class="subtle">${esc(row.meta)}</span>
      <span class="subtle">${esc(time(row.at))}</span>
    </div>
  `).join('') : '<div class="empty">No payment activity</div>';
}

function renderModeration(events) {
  $('moderation-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event">
      <strong>${esc(event.type)}</strong>
      <span class="subtle">${event.reportable ? 'reportable' : 'not reportable'}</span>
      <span class="subtle">${esc(time(event.createdAt))}</span>
    </div>
  `).join('') : '<div class="empty">No moderation events</div>';
}

function renderOps(events) {
  $('ops-stream').innerHTML = events.length ? events.map((event) => {
    const group = event.resourceId ? resourceGroup(event.resourceType) : null;
    return `
      <div class="event" ${group ? `data-resource="${esc(group)}" data-resource-id="${esc(event.resourceId)}"` : ''}>
        <strong>${esc(event.type)} <span class="chip">${esc(event.severity)}</span></strong>
        <span class="subtle">${esc(event.resourceType ?? 'system')} ${esc(shortId(event.resourceId))}</span>
        <span class="subtle">${esc(time(event.createdAt))}</span>
      </div>
    `;
  }).join('') : '<div class="empty">No ops events</div>';
}

function renderRequests(logs) {
  $('request-stream').innerHTML = logs.length ? logs.map((log) => `
    <div class="event">
      <strong>${esc(log.status)} ${esc(log.method)} ${esc(log.path)}</strong>
      <span class="subtle">${esc(log.latencyMs)}ms ${esc(log.errorCode ?? '')}</span>
      <span class="subtle">${esc(time(log.createdAt))}</span>
    </div>
  `).join('') : '<div class="empty">No requests logged</div>';
}

function resourceGroup(resourceType) {
  return {
    agent: 'agents',
    listing: 'listings',
    offer: 'offers',
    trade: 'trades'
  }[resourceType] ?? null;
}

function summaryCells(resource) {
  return Object.entries(resource ?? {})
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 16)
    .map(([key, value]) => `
      <div class="detail-cell">
        <span class="label">${esc(key)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `).join('');
}

function renderDetail(data) {
  const resource = data.resource;
  const type = data.type;
  $('detail-label').textContent = `${type} / ${data.id}`;
  const canPause = type === 'listings' && resource.status !== 'paused';
  const canFlag = type === 'agents' && resource.status !== 'flagged';
  $('detail-panel').innerHTML = `
    <div class="detail-actions">
      ${canPause ? '<button class="danger" type="button" data-action="pause-listing">Pause listing</button>' : ''}
      ${canFlag ? '<button class="danger" type="button" data-action="flag-agent">Flag agent</button>' : ''}
      <button type="button" data-action="refresh-detail">Refresh</button>
    </div>
    <div class="detail-grid">${summaryCells(resource)}</div>
    <div>
      <span class="label">Related events</span>
      <div class="detail-events">
        ${(data.events ?? []).length ? data.events.map((event) => `
          <div class="event">
            <strong>${esc(event.type)} <span class="chip">${esc(event.severity)}</span></strong>
            <span class="subtle">${esc(time(event.createdAt))}</span>
          </div>
        `).join('') : '<div class="empty">No related events</div>'}
      </div>
    </div>
  `;
  state.selection = { type, id: data.id };
}

async function inspectResource(type, id) {
  if (!type || !id || type === 'auto_accept_rules') return;
  const data = await fetchAdmin(`/v1/admin/inspect/${type}/${encodeURIComponent(id)}`);
  renderDetail(data);
}

async function runDetailAction(action) {
  if (action === 'cleanup') {
    await postAdmin('/v1/maintenance/cleanup', {});
    await refresh();
    return;
  }
  if (!state.selection) return;
  if (action === 'refresh-detail') {
    await inspectResource(state.selection.type, state.selection.id);
    return;
  }
  if (action === 'pause-listing' && state.selection.type === 'listings') {
    await postAdmin(`/v1/admin/listings/${encodeURIComponent(state.selection.id)}/pause`, {
      reason: 'Paused from admin dashboard'
    });
    await inspectResource(state.selection.type, state.selection.id);
    await refresh();
    return;
  }
  if (action === 'flag-agent' && state.selection.type === 'agents') {
    await postAdmin(`/v1/admin/agents/${encodeURIComponent(state.selection.id)}/flag`, {
      reason: 'Flagged from admin dashboard'
    });
    await inspectResource(state.selection.type, state.selection.id);
    await refresh();
  }
}

function render(data) {
  $('backend').textContent = text(data.runtime.storageBackend);
  $('database').textContent = data.runtime.databaseConfigured ? text(data.runtime.databaseConnection?.host) : 'not configured';
  $('admin-state').textContent = data.runtime.adminConfigured ? 'configured' : 'missing';
  $('updated-at').textContent = time(data.generatedAt);
  $('trade-total').textContent = `${data.totals.trades} total`;

  renderTotals(data);
  renderBars('trade-bars', data.breakdowns.tradesByState);
  renderBars('market-bars', {
    ...data.breakdowns.listingsByStatus,
    ...Object.fromEntries(Object.entries(data.breakdowns.offersByStatus ?? {}).map(([key, value]) => [`offer ${key}`, value]))
  });
  renderTrades(data.recent.trades ?? []);
  renderReputation(data.recent.reputationEvents ?? []);
  renderEscrow(data.recent.escrowEvents ?? []);
  renderPayments(data.recent.paymentIntents ?? [], data.recent.paymentEvents ?? []);
  renderModeration(data.recent.moderationEvents ?? []);
  renderOps(data.recent.auditEvents ?? []);
  renderRequests(data.recent.requestLogs ?? []);
}

async function refresh() {
  if (!state.token) return false;
  try {
    const data = await fetchAudit();
    setGate(false);
    render(data);
    $('gate-error').textContent = '';
    return true;
  } catch (error) {
    clearInterval(state.timer);
    state.timer = null;
    $('gate-error').textContent = error.message;
    setGate(true);
    return false;
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 4000);
}

$('token-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = $('admin-token').value.trim();
  sessionStorage.setItem('ax_admin_token', state.token);
  const connected = await refresh();
  if (connected) startPolling();
});

$('refresh-button').addEventListener('click', refresh);

$('lock-button').addEventListener('click', () => {
  sessionStorage.removeItem('ax_admin_token');
  state.token = '';
  clearInterval(state.timer);
  state.timer = null;
  setGate(true);
});

$('dashboard').addEventListener('click', async (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    await runDetailAction(actionTarget.dataset.action);
    return;
  }

  const resourceTarget = event.target.closest('[data-resource][data-resource-id]');
  if (!resourceTarget) return;
  await inspectResource(resourceTarget.dataset.resource, resourceTarget.dataset.resourceId);
});

if (state.token) {
  refresh().then((connected) => {
    if (connected) startPolling();
  });
} else {
  setGate(true);
}
