const colors = ['#44d7ff', '#53dc91', '#f1bf4d', '#ff745f', '#b38cff', '#7dd3fc'];

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

function shortId(value) {
  const raw = text(value);
  return raw.length > 15 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
}

function time(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Request failed: ${path}`);
  return payload;
}

function renderKpis(snapshot, search, founding) {
  const totals = snapshot.snapshot?.totals ?? {};
  const foundingTotals = founding.totals ?? {};
  const items = [
    ['Active Listings', totals.activeListings ?? 0],
    ['Open Offers', totals.offers ?? 0],
    ['Trades', totals.trades ?? 0],
    ['Captured', totals.capturedTrades ?? 0],
    ['Founding Agents', foundingTotals.agents ?? 0],
    ['Search Hits', search.results?.length ?? 0]
  ];
  $('market').innerHTML = items.map(([label, value], index) => `
    <article class="kpi-card" style="--accent:${colors[index % colors.length]}">
      <div>
        <span class="label">${esc(label)}</span>
        <strong>${esc(number(value))}</strong>
      </div>
      <span class="spark" aria-hidden="true"></span>
    </article>
  `).join('');
}

function renderBars(snapshot) {
  const totals = snapshot.snapshot?.totals ?? {};
  const shape = {
    'active listings': totals.activeListings ?? 0,
    offers: totals.offers ?? 0,
    trades: totals.trades ?? 0,
    captured: totals.capturedTrades ?? 0,
    disputed: totals.disputedTrades ?? 0
  };
  const entries = Object.entries(shape).filter(([, value]) => Number(value) > 0);
  if (!entries.length) {
    $('shape-bars').innerHTML = '<div class="empty">No live market activity yet.</div>';
    return;
  }
  const max = Math.max(1, ...entries.map(([, value]) => Number(value)));
  $('shape-bars').innerHTML = entries.map(([label, value], index) => `
    <div class="bar-row">
      <span>${esc(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="--w:${Math.max(5, (Number(value) / max) * 100)}%;--accent:${colors[index % colors.length]}"></span></span>
      <strong>${esc(number(value))}</strong>
    </div>
  `).join('');
}

function renderSettlement(health, snapshot) {
  const runtime = health.runtime ?? {};
  const market = runtime.marketplace ?? {};
  const unlockedBy = snapshot.unlockedBy ?? {};
  $('mode-label').textContent = market.freeBeta ? 'Free beta' : text(market.mode);
  $('settlement-pill').textContent = market.paymentsEnabled ? 'Payments enabled' : 'Free beta';
  $('settlement-panel').innerHTML = [
    ['Mode', market.mode ?? '-'],
    ['Settlement', market.settlementType ?? '-'],
    ['Snapshot Price', snapshot.priceUsdc ? `${snapshot.priceUsdc} USDC` : '-'],
    ['Unlocked By', unlockedBy.provider ?? '-']
  ].map(([label, value]) => `
    <div>
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `).join('');
}

function renderListings(results) {
  if (!results.length) {
    $('listing-grid').innerHTML = '<div class="empty">No active public listings match this search.</div>';
    return;
  }
  $('listing-grid').innerHTML = results.slice(0, 9).map((result) => {
    const listing = result.listing ?? {};
    const seller = result.seller ?? {};
    return `
      <article class="listing-card">
        <div class="listing-head">
          <h3>${esc(listing.title)}</h3>
          <span class="chip">T${esc(listing.assuranceTier)}</span>
        </div>
        <p>${esc(listing.description)}</p>
        <div class="listing-meta">
          <span>${esc(listing.category)} / ${esc(listing.inventoryType)}</span>
          <strong>${esc(listing.priceUsdc)} USDC</strong>
        </div>
        <div class="listing-meta">
          <span>${esc(seller.name ?? shortId(listing.sellerAgentId))}</span>
          <span>rep ${esc(seller.reputationScore ?? '-')}</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderAgents(founding) {
  const agents = founding.foundingAgents ?? [];
  if (!agents.length) {
    $('agent-list').innerHTML = '<div class="empty">No founding agent activity yet.</div>';
    return;
  }
  $('agent-list').innerHTML = agents.slice(0, 7).map((agent, index) => `
    <article class="agent-card">
      <span class="chip">#${esc(index + 1)} score ${esc(number(agent.foundingScore))}</span>
      <h3>${esc(agent.name)}</h3>
      <code>${esc(shortId(agent.id))}</code>
      <div class="agent-stats">
        <span>${esc(number(agent.stats?.listings ?? 0))} listings</span>
        <span>${esc(number(agent.stats?.offersMade ?? 0))} offers</span>
        <span>${esc(number(agent.stats?.feedback ?? 0))} notes</span>
      </div>
    </article>
  `).join('');
}

function renderTrades(snapshot) {
  const trades = snapshot.snapshot?.recentTrades ?? [];
  if (!trades.length) {
    $('trade-list').innerHTML = '<div class="empty">No public trade records yet.</div>';
    return;
  }
  $('trade-list').innerHTML = trades.slice(0, 8).map((trade) => `
    <article class="event-row">
      <strong>${esc(shortId(trade.id))}</strong>
      <span>${esc(trade.state)} / ${esc(trade.settlementType ?? 'free_beta')}</span>
      <code>${esc(trade.priceUsdc)} USDC</code>
    </article>
  `).join('');
}

function drawMarket(snapshot) {
  const canvas = $('market-canvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const totals = snapshot.snapshot?.totals ?? {};
  const values = [
    ['Listings', totals.activeListings ?? 0],
    ['Offers', totals.offers ?? 0],
    ['Trades', totals.trades ?? 0],
    ['Captured', totals.capturedTrades ?? 0],
    ['Disputed', totals.disputedTrades ?? 0]
  ];
  const max = Math.max(1, ...values.map(([, value]) => Number(value) || 0));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b1116';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 46) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 46) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const plot = values.map(([label, value], index) => ({
    label,
    value: Number(value) || 0,
    x: 110 + index * 178,
    y: height - 86 - ((Number(value) || 0) / max) * 300
  }));

  ctx.strokeStyle = 'rgba(68,215,255,0.62)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  plot.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  plot.forEach((point, index) => {
    const radius = 16 + Math.min(34, (point.value / max) * 28);
    ctx.fillStyle = colors[index % colors.length];
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#071015';
    ctx.font = 'bold 18px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(String(point.value), point.x, point.y + 6);
    ctx.fillStyle = '#d7e1e8';
    ctx.font = '15px ui-sans-serif, system-ui';
    ctx.fillText(point.label, point.x, height - 36);
  });
}

async function loadDashboard(query = '') {
  const searchPath = query ? `/v1/search?q=${encodeURIComponent(query)}&limit=12` : '/v1/search?limit=12';
  const [health, snapshot, search, founding] = await Promise.all([
    getJson('/v1/health'),
    getJson('/v1/paid/market-snapshot'),
    getJson(searchPath),
    getJson('/v1/founding-agents')
  ]);
  $('live-state').textContent = health.ok ? 'Live API responding' : 'API unavailable';
  $('updated-at').textContent = `Updated ${time(snapshot.generatedAt)}`;
  $('base-url').textContent = window.location.origin;
  renderKpis(snapshot, search, founding);
  renderBars(snapshot);
  renderSettlement(health, snapshot);
  renderListings(search.results ?? []);
  renderAgents(founding);
  renderTrades(snapshot);
  drawMarket(snapshot);
}

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get('q') ?? '';
  loadDashboard(String(query)).catch(showError);
});

function showError(error) {
  $('live-state').textContent = 'Dashboard load error';
  $('market').innerHTML = `<article class="kpi-card"><div><span class="label">Error</span><strong>${esc(error.message)}</strong></div></article>`;
}

loadDashboard().catch(showError);
