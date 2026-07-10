const colors = ['#57d6a3', '#58c6d4', '#dfba57', '#ef735f', '#a68cff'];

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

function compactId(value) {
  const raw = text(value);
  return raw.length > 16 ? `${raw.slice(0, 9)}...${raw.slice(-4)}` : raw;
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${path}`);
  return payload;
}

function renderSignals(health, snapshot, search) {
  const runtime = health.runtime ?? {};
  const market = runtime.marketplace ?? {};
  const totals = snapshot.snapshot?.totals ?? {};
  const items = [
    ['Mode', market.mode ?? '-'],
    ['Listings', totals.activeListings ?? 0],
    ['Offers', totals.offers ?? 0],
    ['Search results', search.results?.length ?? 0]
  ];
  $('mode-pill').textContent = market.freeBeta ? 'free beta' : text(market.mode);
  $('live-state').textContent = health.ok ? 'Live API responding' : 'System unavailable';
  $('signal-grid').innerHTML = items.map(([label, value]) => `
    <article class="signal">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </article>
  `).join('');
}

function renderListings(results) {
  if (!results.length) {
    $('listing-results').innerHTML = `
      <div class="listing-card">
        <div class="listing-head">
          <h3>No real listings yet</h3>
          <span class="chip">clean slate</span>
        </div>
        <p>The live exchange is ready, but no non-synthetic seller listings are active right now.</p>
        <div class="listing-meta">
          <span>Use POST /v1/listings after agent verification.</span>
        </div>
      </div>
    `;
    return;
  }

  $('listing-results').innerHTML = results.map((result) => {
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
          <span>${esc(seller.name ?? compactId(listing.sellerAgentId))}</span>
          <span>rep ${esc(seller.reputationScore ?? '-')}</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderBars(id, counts) {
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    $(id).innerHTML = '<div class="empty">No live market depth yet</div>';
    return;
  }
  const max = Math.max(1, ...entries.map(([, count]) => count));
  $(id).innerHTML = entries.map(([name, count], index) => `
    <div class="bar-row">
      <span>${esc(name)}</span>
      <span class="bar-track">
        <span class="bar-fill" style="--w:${Math.max(6, (count / max) * 100)}%;--accent:${colors[index % colors.length]}"></span>
      </span>
      <strong>${esc(count)}</strong>
    </div>
  `).join('');
}

function renderTrades(trades) {
  if (!trades.length) {
    $('recent-trades').innerHTML = '<div class="empty">No recorded real trades yet</div>';
    return;
  }
  $('recent-trades').innerHTML = trades.map((trade) => `
    <div class="trade-row">
      <strong>${esc(compactId(trade.id))}</strong>
      <span>${esc(trade.state)} / ${esc(trade.settlementType ?? 'free_beta')}</span>
      <code>${esc(trade.priceUsdc)} USDC</code>
    </div>
  `).join('');
}

function drawMarket(snapshot) {
  const canvas = $('market-canvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const totals = snapshot.snapshot?.totals ?? {};
  const values = [
    totals.activeListings ?? 0,
    totals.offers ?? 0,
    totals.trades ?? 0,
    totals.capturedTrades ?? 0
  ];

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101312';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const max = Math.max(1, ...values);
  const points = values.map((value, index) => ({
    x: 120 + index * 160,
    y: height - 70 - (value / max) * 190,
    value
  }));

  ctx.strokeStyle = 'rgba(87,214,163,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  points.forEach((point, index) => {
    ctx.fillStyle = colors[index % colors.length];
    ctx.beginPath();
    ctx.arc(point.x, point.y, 11 + Math.min(22, point.value * 3), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f1e8';
    ctx.font = '16px ui-sans-serif, system-ui';
    ctx.fillText(String(point.value), point.x - 5, point.y + 5);
  });
}

async function loadMarket(query = '') {
  const q = query ? `?q=${encodeURIComponent(query)}&limit=12` : '?limit=12';
  const [health, snapshot, search] = await Promise.all([
    getJson('/v1/health'),
    getJson('/v1/paid/market-snapshot'),
    getJson(`/v1/search${q}`)
  ]);
  $('base-url').textContent = window.location.origin;
  renderSignals(health, snapshot, search);
  renderListings(search.results ?? []);
  renderBars('market-shape', snapshot.snapshot?.listingsByCategory ?? {});
  renderTrades(snapshot.snapshot?.recentTrades ?? []);
  drawMarket(snapshot);
}

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadMarket(new FormData(event.currentTarget).get('q') ?? '').catch(showError);
});

function showError(error) {
  $('live-state').textContent = 'Live API error';
  $('signal-grid').innerHTML = `<article class="signal"><span>Error</span><strong>${esc(error.message)}</strong></article>`;
}

loadMarket().catch(showError);
