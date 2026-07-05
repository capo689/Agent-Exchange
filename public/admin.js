const state = {
  token: sessionStorage.getItem('ax_admin_token') ?? '',
  timer: null
};

const colors = ['#4fc3bd', '#e0b94a', '#ed6a5a', '#9f8cff', '#49d18f', '#d88fd8'];
const totals = [
  ['agents', 'Agents'],
  ['listings', 'Listings'],
  ['offers', 'Offers'],
  ['trades', 'Trades'],
  ['escrowEvents', 'Escrow'],
  ['reputationEvents', 'Reputation']
];

function $(id) {
  return document.getElementById(id);
}

function text(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
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
  const response = await fetch('/v1/admin/audit', {
    headers: { 'x-admin-token': state.token }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'Audit request failed');
  }
  return payload;
}

function renderTotals(data) {
  $('totals').innerHTML = totals.map(([key, label], index) => `
    <article class="metric" style="--accent:${colors[index % colors.length]}">
      <div>
        <span class="label">${label}</span>
        <strong>${text(data.totals[key])}</strong>
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
      <span>${text(name)}</span>
      <span class="bar-track">
        <span class="bar-fill" style="--w:${Math.max(4, (count / max) * 100)}%;--accent:${colors[index % colors.length]}"></span>
      </span>
      <strong>${count}</strong>
    </div>
  `).join('') : fallback;
}

function renderTrades(trades) {
  $('trades-table').innerHTML = trades.length ? trades.map((trade) => `
    <div class="table-row">
      <span><strong>${shortId(trade.id)}</strong></span>
      <span>${shortId(trade.buyerAgentId)}</span>
      <span>${shortId(trade.sellerAgentId)}</span>
      <span class="chip">${text(trade.state)}</span>
      <span>${text(trade.priceUsdc)} USDC</span>
    </div>
  `).join('') : '<div class="empty">No trades</div>';
}

function renderReputation(events) {
  $('reputation-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event">
      <strong>${event.delta > 0 ? '+' : ''}${event.delta} ${text(event.reason)}</strong>
      <span class="subtle">${shortId(event.agentId)} ${event.previousScore} -> ${event.newScore}</span>
      <span class="subtle">${time(event.createdAt)}</span>
    </div>
  `).join('') : '<div class="empty">No reputation events</div>';
}

function renderEscrow(events) {
  $('escrow-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event">
      <strong>${text(event.type)} ${text(event.amountUsdc)} USDC</strong>
      <span class="subtle">${shortId(event.tradeId)} via ${text(event.adapter)}</span>
      <span class="subtle">${time(event.createdAt)}</span>
    </div>
  `).join('') : '<div class="empty">No escrow events</div>';
}

function renderModeration(events) {
  $('moderation-stream').innerHTML = events.length ? events.map((event) => `
    <div class="event">
      <strong>${text(event.type)}</strong>
      <span class="subtle">${event.reportable ? 'reportable' : 'not reportable'}</span>
      <span class="subtle">${time(event.createdAt)}</span>
    </div>
  `).join('') : '<div class="empty">No moderation events</div>';
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
  renderModeration(data.recent.moderationEvents ?? []);
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

if (state.token) {
  refresh().then((connected) => {
    if (connected) startPolling();
  });
} else {
  setGate(true);
}
