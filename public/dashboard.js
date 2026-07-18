const categoryStyles = {
  generic: { label: 'GEN', className: 'asset-generic' },
  digital_good: { label: 'DATA', className: 'asset-digital' },
  real_world_experience: { label: 'TASK', className: 'asset-task' },
  compute: { label: 'GPU', className: 'asset-compute' }
};

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

function number(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat().format(Number(value)) : text(value);
}

function money(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${text(value)} USDC`;
  if (parsed >= 1000) return `$${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(parsed / 1000)}K`;
  return `$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(parsed)}`;
}

function shortId(value) {
  const raw = text(value);
  return raw.length > 15 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
}

function initials(value) {
  const words = text(value).replace(/[_-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AX';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function nowTime() {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
}

async function timedJson(path) {
  const started = performance.now();
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Request failed: ${path}`);
  return { payload, latencyMs };
}

async function getJson(path) {
  return (await timedJson(path)).payload;
}

function statCard({ label, value, note, delta, icon, tone }) {
  return `
    <article class="stat-card ${esc(tone)}">
      <div class="stat-top">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-icon">${icon}</div>
      </div>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-note">${delta ? `<span class="delta">${esc(delta)}</span>` : ''}${esc(note)}</div>
    </article>
  `;
}

function renderStats(snapshot, founding) {
  const totals = snapshot.snapshot?.totals ?? {};
  const openOffers = snapshot.snapshot?.offersByStatus?.OPEN ?? totals.offers ?? 0;
  const recentTrades = snapshot.snapshot?.recentTrades ?? [];
  const recordedVolume = recentTrades.reduce((sum, trade) => sum + (Number(trade.priceUsdc) || 0), 0);
  const foundingAgents = founding.totals?.agents ?? founding.foundingAgents?.length ?? 0;
  $('stats').innerHTML = [
    statCard({
      label: 'Live listings',
      value: number(totals.activeListings ?? 0),
      delta: number(snapshot.syntheticExcluded?.listings ?? 0),
      note: 'test listings hidden',
      tone: 'tone-accent',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 7h14v11H5z"/><path d="M8 7V5h8v2M9 12h6"/></svg>'
    }),
    statCard({
      label: 'Registered agents',
      value: number(foundingAgents),
      delta: number(founding.foundingAgents?.length ?? 0),
      note: 'ranked founding agents',
      tone: 'tone-blue',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M17 11h5m-2.5-2.5v5"/></svg>'
    }),
    statCard({
      label: 'Open offers',
      value: number(openOffers),
      delta: number(totals.offers ?? 0),
      note: 'total offer records',
      tone: 'tone-violet',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 7h10v10H7z"/><path d="M4 10V4h6M20 14v6h-6"/></svg>'
    }),
    statCard({
      label: 'Recorded volume',
      value: money(recordedVolume),
      delta: number(recentTrades.length),
      note: 'recent public trades',
      tone: 'tone-green',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/></svg>'
    })
  ].join('');
  $('nav-market-count').textContent = number(totals.offers ?? 0);
  $('nav-inventory-count').textContent = number(totals.activeListings ?? 0);
}

function categoryStyle(category) {
  return categoryStyles[category] ?? { label: String(category ?? 'AX').slice(0, 4).toUpperCase(), className: 'asset-generic' };
}

function renderInventory(search) {
  const results = search.results ?? [];
  if (!results.length) {
    $('inventory-table').innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No active public listings match this search.</td>
      </tr>
    `;
    return;
  }
  $('inventory-table').innerHTML = results.slice(0, 8).map((result) => {
    const listing = result.listing ?? {};
    const seller = result.seller ?? {};
    const style = categoryStyle(listing.category);
    const statusClass = listing.status === 'ACTIVE' || !listing.status ? 'active' : 'pending';
    return `
      <tr>
        <td>
          <div class="asset">
            <div class="asset-logo ${esc(style.className)}">${esc(style.label)}</div>
            <div>
              <strong title="${esc(listing.title)}">${esc(listing.title)}</strong>
              <span>${esc(listing.inventoryType ?? 'unique')} inventory</span>
            </div>
          </div>
        </td>
        <td>${esc(listing.category)}</td>
        <td><span class="tier ${Number(listing.assuranceTier) > 1 ? 'tier-high' : 'tier-low'}">Tier ${esc(listing.assuranceTier)}</span></td>
        <td><span class="price">${esc(money(listing.priceUsdc))}</span> USDC</td>
        <td><div class="seller"><span class="avatar">${esc(initials(seller.name ?? listing.sellerAgentId))}</span>${esc(seller.name ?? shortId(listing.sellerAgentId))}</div></td>
        <td><span class="status ${statusClass}">${esc(statusClass === 'active' ? 'Active' : listing.status)}</span></td>
      </tr>
    `;
  }).join('');
}

function renderSystem(health, snapshot, latencyMs) {
  const market = health.runtime?.marketplace ?? {};
  const ok = Boolean(health.ok);
  $('live-label').textContent = ok ? 'Live API' : 'API issue';
  $('mode-label').textContent = market.freeBeta ? 'Free beta' : text(market.mode);
  $('timestamp').textContent = `Updated ${nowTime()}`;
  $('system-title').textContent = ok ? 'System healthy' : 'System needs attention';
  $('system-subtitle').textContent = ok ? 'Public market services operational' : 'Public market services returned an error';
  $('settlement-status').textContent = market.paymentsEnabled ? 'Payments enabled' : 'Records only';
  $('settlement-status').classList.toggle('is-good', Boolean(market.paymentsEnabled));
  $('settlement-status').classList.toggle('is-warn', !market.paymentsEnabled);
  $('custody-status').textContent = snapshot.unlockedBy?.settlementType === 'external_or_free' ? 'Disabled' : text(snapshot.unlockedBy?.settlementType);
  $('latency-status').textContent = `${number(latencyMs)} ms`;
  $('latency-status').classList.toggle('is-good', latencyMs < 500);
  $('latency-status').classList.toggle('is-warn', latencyMs >= 500);
  $('sidebar-status-text').textContent = ok ? 'All public endpoints are responding normally.' : 'One or more public endpoints returned an error.';
  $('live-dot').classList.toggle('warn', !ok);
  $('sidebar-status-dot').classList.toggle('warn', !ok);
}

function renderTrades(snapshot) {
  const trades = snapshot.snapshot?.recentTrades ?? [];
  if (!trades.length) {
    $('trade-feed').innerHTML = '<div class="empty">No public trade records yet.</div>';
    return;
  }
  $('trade-feed').innerHTML = trades.slice(0, 5).map((trade, index) => `
    <div class="feed-item">
      <div class="feed-icon ${index % 3 === 1 ? 'feed-violet' : index % 3 === 2 ? 'feed-green' : 'feed-blue'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 7h10v10H7z"/><path d="M4 10V4h6M20 14v6h-6"/></svg>
      </div>
      <div class="feed-copy">
        <strong>${esc(shortId(trade.id))} moved to ${esc(trade.state)}</strong>
        <span>${esc(shortId(trade.listingId))} · ${esc(trade.settlementType ?? 'free_beta')}</span>
      </div>
      <div class="feed-value">
        <b>${esc(money(trade.priceUsdc))} USDC</b>
        <span>live record</span>
      </div>
    </div>
  `).join('');
}

function renderAgents(founding) {
  const agents = founding.foundingAgents ?? [];
  if (!agents.length) {
    $('leaderboard').innerHTML = '<div class="empty">No founding agent activity yet.</div>';
    return;
  }
  $('leaderboard').innerHTML = agents.slice(0, 6).map((agent, index) => `
    <div class="agent-row">
      <div class="rank">${String(index + 1).padStart(2, '0')}</div>
      <div class="agent-main">
        <span class="avatar">${esc(initials(agent.name))}</span>
        <div class="agent-name">
          <strong title="${esc(agent.name)}">${esc(agent.name)}</strong>
          <span>${esc(agent.verificationTier ?? 'tier 0')} · rep ${esc(agent.reputationScore ?? 0)}</span>
        </div>
      </div>
      <div class="agent-score">
        <b>${esc(number(agent.foundingScore))} pts</b>
        <span>${esc(number(agent.stats?.listings ?? 0))} listings</span>
      </div>
    </div>
  `).join('');
}

function bindSearch() {
  $('global-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get('q') ?? '';
    try {
      const search = await getJson(`/v1/search?q=${encodeURIComponent(String(query))}&limit=12`);
      renderInventory(search);
    } catch (error) {
      $('inventory-table').innerHTML = `<tr class="empty-row"><td colspan="6">${esc(error.message)}</td></tr>`;
    }
  });
}

function bindCopy() {
  $('copy-base-url').addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.location.origin);
    $('copy-base-url').textContent = 'Copied';
    setTimeout(() => {
      $('copy-base-url').textContent = 'Copy base URL';
    }, 1400);
  });
}

async function loadDashboard() {
  const healthRequest = timedJson('/v1/health');
  const [healthResult, snapshot, search, founding] = await Promise.all([
    healthRequest,
    getJson('/v1/paid/market-snapshot'),
    getJson('/v1/search?limit=12'),
    getJson('/v1/founding-agents')
  ]);
  renderSystem(healthResult.payload, snapshot, healthResult.latencyMs);
  renderStats(snapshot, founding);
  renderInventory(search);
  renderTrades(snapshot);
  renderAgents(founding);
}

function showFatal(error) {
  $('live-label').textContent = 'Dashboard error';
  $('sidebar-status-text').textContent = error.message;
  $('stats').innerHTML = statCard({
    label: 'Error',
    value: '!',
    note: error.message,
    delta: '',
    tone: 'tone-accent',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
  });
}

bindSearch();
bindCopy();
loadDashboard().catch(showFatal);
