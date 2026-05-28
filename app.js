/* ============================================================
   BulkListIQ — JavaScript Application
   Real-time Keepa API with 24h localStorage caching
   ============================================================ */

'use strict';

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  KEEPA_KEY: 'pa8osmtpo6bq3bbf3vgfqmp78p0ifbouv34flbvs51hsjqkb7kg6qjgddpspinlp',
  DOMAIN: 10,
  IS_LOCAL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',
  BASE_URL: 'https://api.keepa.com',
  PROXY_URL: '/api/keepa',
  BATCH_SIZE: 10,      // 10 ASINs per product call (~10 tokens per call)
  INITIAL_LOAD: 10,    // Load 10 products on first open
  PAGE_SIZE: 50,
  CACHE_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours

  CATEGORIES: {
    electronics: { id: 976419031,  name: 'Consumer Electronics', color: '#6366F1' },
    automotive:  { id: 4772060031, name: 'Car & Motorbike',       color: '#F97316' },
    home:        { id: 3704992031, name: 'Home & Kitchen',        color: '#22C55E' }
  }
};

// ============================================================
// STATE
// ============================================================
const STATE = {
  activeCategory: 'electronics',
  data: {
    electronics: { products: [], loaded: false, bestsellersAsins: [], fromCache: false },
    automotive:  { products: [], loaded: false, bestsellersAsins: [], fromCache: false },
    home:        { products: [], loaded: false, bestsellersAsins: [], fromCache: false }
  },
  filtered: [],
  sorted: { col: null, dir: 'asc' },
  page: 1,
  totalPages: 1,
  tokensLeft: null,
  loading: false
};

const $ = id => document.getElementById(id);

// ============================================================
// LOCAL STORAGE CACHE — KEY FEATURE: saves tokens on every revisit
// Bestsellers alone costs 50 tokens per call!
// With caching: pay tokens ONCE per 24h, then FREE forever.
// ============================================================
function cacheGet(type, catKey) {
  try {
    const raw = localStorage.getItem(`bliq_${type}_${catKey}`);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CONFIG.CACHE_TTL_MS) {
      localStorage.removeItem(`bliq_${type}_${catKey}`);
      return null;
    }
    return data;
  } catch (e) { return null; }
}

function cacheSet(type, catKey, data) {
  try {
    localStorage.setItem(`bliq_${type}_${catKey}`, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { console.warn('Cache write failed (storage full?):', e); }
}

function cacheAge(catKey) {
  try {
    const raw = localStorage.getItem(`bliq_products_${catKey}`);
    if (!raw) return null;
    const { ts } = JSON.parse(raw);
    const ms = Date.now() - ts;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
  } catch (e) { return null; }
}

function clearAllCache() {
  ['electronics', 'automotive', 'home'].forEach(cat => {
    localStorage.removeItem(`bliq_asins_${cat}`);
    localStorage.removeItem(`bliq_products_${cat}`);
    STATE.data[cat].loaded = false;
    STATE.data[cat].products = [];
    STATE.data[cat].bestsellersAsins = [];
    STATE.data[cat].fromCache = false;
    $(`count-${cat}`).textContent = '—';
  });
  hideCacheBadge();
  showToast('🗑️ Cache cleared — will fetch fresh data', 'info');
  retryLoad();
}

// ============================================================
// UTILS
// ============================================================
function formatNumber(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

function starsHtml(rating) {
  const r = parseFloat(rating) || 0;
  const full = Math.floor(r);
  const half = r - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function formatPrice(raw) {
  if (!raw || raw < 0) return null;
  return '₹' + (raw / 100).toLocaleString('en-IN');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// KEEPA API — with 429 auto-retry
// ============================================================
async function keepaFetch(endpoint, params, retryCount = 0) {
  let url;
  if (CONFIG.IS_LOCAL) {
    url = new URL(`${CONFIG.BASE_URL}/${endpoint}`);
    url.searchParams.set('key', CONFIG.KEEPA_KEY);
    url.searchParams.set('domain', CONFIG.DOMAIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    url = new URL(CONFIG.PROXY_URL, window.location.origin);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('domain', CONFIG.DOMAIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  let resp;
  try { resp = await fetch(url.toString()); }
  catch (e) { throw new Error('Network error — check internet connection'); }

  let data = {};
  try { data = await resp.json(); } catch (_) {}

  if (data.tokensLeft !== undefined) {
    STATE.tokensLeft = data.tokensLeft;
    updateTokenDisplay();
  }

  if (resp.status === 429 || (data.tokensLeft !== undefined && data.tokensLeft < 0)) {
    if (retryCount >= 5) throw new Error('Token limit reached after 5 retries. Please wait a minute.');
    const refillSec = Math.ceil((data.refillIn || 60000) / 1000);
    await countdownWait(refillSec, retryCount);
    return keepaFetch(endpoint, params, retryCount + 1);
  }

  if (!resp.ok) throw new Error(`Keepa API error: ${resp.status}`);
  return data;
}

async function countdownWait(seconds, attempt) {
  const end = Date.now() + seconds * 1000 + 500;
  while (Date.now() < end) {
    const rem = Math.ceil((end - Date.now()) / 1000);
    setLoadingText(
      `⏳ Token limit reached — auto-retrying in ${rem}s`,
      `Keepa refills 20 tokens/min. Attempt ${attempt + 1}/5`
    );
    await sleep(800);
  }
  setLoadingText('🔄 Retrying...', 'Reconnecting to Keepa API');
}

// ============================================================
// DATA FETCHING
// ============================================================
async function fetchBestsellers(catKey) {
  const cat = CONFIG.CATEGORIES[catKey];

  // ✅ Check cache first — saves 50 tokens per call!
  const cached = cacheGet('asins', catKey);
  if (cached && cached.length > 0) {
    STATE.data[catKey].bestsellersAsins = cached;
    $(`count-${catKey}`).textContent = formatNumber(cached.length);
    return cached;
  }

  // Not cached — fetch from Keepa (~50 tokens)
  setLoadingText(
    `Fetching ${cat.name} bestsellers...`,
    'Note: This call costs ~50 tokens and will be cached for 24h'
  );
  setProgress(15);
  const data = await keepaFetch('bestsellers', { category: cat.id });
  const asins = (data.bestSellersList?.asinList || []).filter(Boolean);
  STATE.data[catKey].bestsellersAsins = asins;
  $(`count-${catKey}`).textContent = formatNumber(asins.length);
  cacheSet('asins', catKey, asins); // Cache immediately
  return asins;
}

async function fetchProductBatch(asins) {
  if (!asins.length) return [];
  const data = await keepaFetch('product', {
    asin: asins.join(','),
    history: 0,
    stats: 30,   // 30-day stats for price data
    rating: 1    // for review count & star rating
  });
  return data.products || [];
}

// ============================================================
// MAIN LOAD FUNCTION
// ============================================================
async function loadCategoryData(catKey) {
  if (STATE.data[catKey].loaded) return;
  STATE.loading = true;
  showLoading();

  try {
    // ✅ Step 1: Check product cache — COMPLETELY FREE (0 tokens)
    const cachedProducts = cacheGet('products', catKey);
    const cachedAsins    = cacheGet('asins',    catKey);

    if (cachedProducts && cachedProducts.length > 0) {
      const age = cacheAge(catKey);
      setLoadingText('📦 Loading from cache...', `Cached ${age || 'recently'} · 0 tokens used`);
      setProgress(90);
      await sleep(350);

      if (cachedAsins) {
        STATE.data[catKey].bestsellersAsins = cachedAsins;
        $(`count-${catKey}`).textContent = formatNumber(cachedAsins.length);
      }
      STATE.data[catKey].products = cachedProducts;
      STATE.data[catKey].loaded = true;
      STATE.data[catKey].fromCache = true;
      setProgress(100);

      renderTable(); updateStats(); populateBrandFilter(); showTable();
      showCacheBadge(catKey, age);
      showToast(`📦 Served from cache (${age || 'just now'}) · 0 tokens used`, 'success');
      return;
    }

    // No cache — fetch live data
    STATE.data[catKey].fromCache = false;
    hideCacheBadge();

    // Step 2: Get ASIN list (cached internally above)
    const allAsins   = await fetchBestsellers(catKey);
    const toEnrich   = allAsins.slice(0, CONFIG.INITIAL_LOAD);

    // Step 3: Enrich products
    setLoadingText(
      `Loading ${toEnrich.length} products...`,
      `Tokens remaining: ${STATE.tokensLeft ?? '...'}`
    );
    setProgress(40);

    const products = [];
    const batches  = Math.ceil(toEnrich.length / CONFIG.BATCH_SIZE);

    for (let i = 0; i < batches; i++) {
      const batch = toEnrich.slice(i * CONFIG.BATCH_SIZE, (i + 1) * CONFIG.BATCH_SIZE);
      setProgress(40 + Math.round(((i + 1) / batches) * 55));
      setLoadingText(
        `Enriching batch ${i + 1}/${batches}...`,
        `Tokens remaining: ${STATE.tokensLeft ?? '...'}`
      );
      const batchProds = await fetchProductBatch(batch);
      products.push(...batchProds);
      if (i < batches - 1) await sleep(300);
    }

    STATE.data[catKey].products = products;
    STATE.data[catKey].loaded   = true;
    setProgress(100);

    // ✅ Cache for 24h — next visits are FREE
    cacheSet('products', catKey, products);
    await sleep(300);

    renderTable(); updateStats(); populateBrandFilter(); showTable();
    showToast(`✅ ${products.length} products loaded · Cached 24h (next visit FREE)`, 'success');

  } catch (err) {
    console.error(err);
    showError('Failed to load data', err.message || 'Check console for details');
  } finally {
    STATE.loading = false;
  }
}

async function loadMoreProducts() {
  const catKey = STATE.activeCategory;
  const cat    = STATE.data[catKey];
  if (!cat.loaded || STATE.loading) return;

  const $btn = $('btn-load-more');
  $btn.disabled = true;
  $btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Loading...`;
  STATE.loading = true;

  try {
    const loaded   = cat.products.length;
    const toEnrich = cat.bestsellersAsins.slice(loaded, loaded + CONFIG.INITIAL_LOAD);

    if (!toEnrich.length) {
      showToast('ℹ️ All available products already loaded', 'info');
      return;
    }

    showToast(`🔄 Loading ${toEnrich.length} more products...`, 'info');
    const batches = Math.ceil(toEnrich.length / CONFIG.BATCH_SIZE);

    for (let i = 0; i < batches; i++) {
      const batch = toEnrich.slice(i * CONFIG.BATCH_SIZE, (i + 1) * CONFIG.BATCH_SIZE);
      const batchProds = await fetchProductBatch(batch);
      cat.products.push(...batchProds);
      if (i < batches - 1) await sleep(300);
    }

    // Update cache with new products
    cacheSet('products', catKey, cat.products);

    renderTable(); updateStats(); populateBrandFilter();
    showToast(`✅ Loaded ${toEnrich.length} more products`, 'success');

  } catch (err) {
    showToast('❌ Failed to load more: ' + err.message, 'error');
  } finally {
    STATE.loading = false;
    $btn.disabled = false;
    $btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg> Load More`;
  }
}

// ============================================================
// CATEGORY SWITCHING
// ============================================================
function switchCategory(catKey) {
  if (catKey === STATE.activeCategory && STATE.data[catKey].loaded) return;
  STATE.activeCategory = catKey;
  STATE.page = 1;
  STATE.sorted = { col: null, dir: 'asc' };

  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.cat === catKey)
  );

  $('search-input').value = '';
  $('search-clear').style.display = 'none';
  $('filter-brand').value = '';
  $('filter-rating').value = '';
  $('filter-ean').value = '';

  if (STATE.data[catKey].loaded) {
    renderTable(); updateStats(); populateBrandFilter(); showTable();
    if (STATE.data[catKey].fromCache) showCacheBadge(catKey, cacheAge(catKey));
    else hideCacheBadge();
  } else {
    showLoading();
    loadCategoryData(catKey);
  }
}

// ============================================================
// TABLE RENDERING
// ============================================================
function getFilteredProducts() {
  let products = [...STATE.data[STATE.activeCategory].products];

  const q   = $('search-input').value.toLowerCase().trim();
  const fBr = $('filter-brand').value.toLowerCase();
  const fRt = parseFloat($('filter-rating').value) || 0;
  const fEn = $('filter-ean').value;

  if (q)   products = products.filter(p =>
    [(p.title||''),(p.asin||''),(p.brand||''),(p.eanList||[]).join(' ')]
      .some(s => s.toLowerCase().includes(q))
  );
  if (fBr) products = products.filter(p => (p.brand||'').toLowerCase() === fBr);
  if (fRt) products = products.filter(p => {
    const rc = p.reviews?.ratingCount;
    if (!rc || rc.length < 2) return false;
    return (rc[rc.length - 1] / 10) >= fRt;
  });
  if (fEn === 'has')  products = products.filter(p => p.eanList?.length > 0);
  if (fEn === 'none') products = products.filter(p => !p.eanList?.length);

  if (STATE.sorted.col) {
    const col = STATE.sorted.col;
    const dir = STATE.sorted.dir === 'asc' ? 1 : -1;

    products.sort((a, b) => {
      let va, vb;
      switch (col) {
        case 'asin':    va = a.asin||'';       vb = b.asin||'';       break;
        case 'title':   va = a.title||'';      vb = b.title||'';      break;
        case 'brand':   va = a.brand||'';      vb = b.brand||'';      break;
        case 'ean':     va = (a.eanList||[])[0]||''; vb = (b.eanList||[])[0]||''; break;
        case 'price': {
          const gp = p => {
            const c = p.stats?.current, bb = p.stats?.buyBoxPrice;
            if (bb && bb > 0) return bb;
            if (c && c[1] > 0) return c[1];
            if (c && c[0] > 0) return c[0];
            return Infinity;
          };
          return dir * (gp(a) - gp(b));
        }
        case 'rating': {
          const gr = p => {
            const rc = p.reviews?.ratingCount;
            return rc?.length >= 2 ? rc[rc.length - 1] : 0;
          };
          return dir * (gr(a) - gr(b));
        }
        case 'reviews': {
          const gv = p => {
            const rc = p.reviews?.reviewCount;
            return rc?.length >= 2 ? rc[rc.length - 1] : 0;
          };
          return dir * (gv(a) - gv(b));
        }
        case 'rank': {
          const gr = p => {
            const sr = p.salesRanks;
            if (!sr) return Infinity;
            const k = Object.keys(sr)[0];
            const v = sr[k];
            return Array.isArray(v) && v.length >= 2 ? v[v.length - 1] : Infinity;
          };
          return dir * (gr(a) - gr(b));
        }
        default: va = ''; vb = '';
      }
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }
  return products;
}

function renderTable() {
  const filtered = getFilteredProducts();
  STATE.filtered  = filtered;
  const total     = filtered.length;
  STATE.totalPages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  if (STATE.page > STATE.totalPages) STATE.page = 1;

  const start = (STATE.page - 1) * CONFIG.PAGE_SIZE;
  const page  = filtered.slice(start, start + CONFIG.PAGE_SIZE);

  $('table-showing').textContent =
    `Showing ${start + 1}–${Math.min(start + page.length, total)} of ${formatNumber(total)} products`;

  const tbody = $('table-body');
  tbody.innerHTML = '';

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:48px;color:var(--text-muted);font-style:italic;">No products match your search or filters</td></tr>`;
    renderPagination();
    return;
  }

  page.forEach((p, idx) => {
    const rowNum = start + idx + 1;
    const asin   = p.asin  || '—';
    const title  = p.title || 'Unknown Product';
    const brand  = p.brand || '';
    const eans   = p.eanList || [];
    const ean    = eans[0] || null;

    // Price
    let rawPrice = -1;
    const cur = p.stats?.current, bb = p.stats?.buyBoxPrice;
    if (bb && bb > 0) rawPrice = bb;
    else if (cur?.[1] > 0) rawPrice = cur[1];
    else if (cur?.[0] > 0) rawPrice = cur[0];
    const priceStr  = formatPrice(rawPrice);
    const priceHtml = priceStr
      ? `<span class="price-val">${priceStr}</span>`
      : `<span class="price-na">—</span>`;

    // Rating
    const rc = p.reviews?.ratingCount;
    const rawRating = rc?.length >= 2 ? rc[rc.length - 1] : null;
    const rating = rawRating ? (rawRating / 10).toFixed(1) : null;

    // Reviews
    const rvc = p.reviews?.reviewCount;
    const reviews = rvc?.length >= 2 ? rvc[rvc.length - 1] : 0;

    // BSR
    let bsr = null;
    const sr = p.salesRanks;
    if (sr) {
      const k  = Object.keys(sr)[0];
      const rv = sr[k];
      if (Array.isArray(rv) && rv.length >= 2) bsr = rv[rv.length - 1];
    }

    // FBA
    const isFBA = !!(p.fbaFees || (p.buyBoxEligibleOfferCounts?.[0] > 0));

    const eanHtml = ean
      ? `<span class="ean-value" title="${eans.join(', ')}">${ean}</span>`
      : `<span class="ean-none">—</span>`;

    const brandHtml = brand
      ? `<span class="brand-pill" title="${brand}">${brand}</span>`
      : `<span style="color:var(--text-faint);font-size:12px;">—</span>`;

    const ratingHtml = rating
      ? `<div class="rating-display"><span class="rating-stars">${starsHtml(rating)}</span><span class="rating-val">${rating}</span></div>`
      : `<span style="color:var(--text-faint);">—</span>`;

    const reviewsHtml = reviews
      ? `<span class="reviews-count">${formatNumber(reviews)}</span>`
      : `<span style="color:var(--text-faint);">—</span>`;

    let bsrHtml = `<span style="color:var(--text-faint);">—</span>`;
    if (bsr) {
      const cls = bsr < 1000 ? 'rank-good' : bsr < 50000 ? 'rank-mid' : 'rank-val';
      bsrHtml = `<span class="${cls}">#${bsr.toLocaleString('en-IN')}</span>`;
    }

    const fbaHtml = `<span class="${isFBA ? 'badge-fba' : 'badge-fbm'}">${isFBA ? 'FBA' : 'FBM'}</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num"><div class="row-num">${rowNum}</div></td>
      <td class="col-asin"><span class="asin-chip" onclick="copyAsin('${asin}',event)" title="Click to copy">${asin}</span></td>
      <td class="col-title"><div class="product-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div></td>
      <td class="col-brand">${brandHtml}</td>
      <td class="col-ean">${eanHtml}</td>
      <td class="col-price">${priceHtml}</td>
      <td class="col-rating">${ratingHtml}</td>
      <td class="col-reviews">${reviewsHtml}</td>
      <td class="col-rank">${bsrHtml}</td>
      <td class="col-fba">${fbaHtml}</td>
      <td class="col-link"><a class="amazon-link" href="https://www.amazon.in/dp/${asin}" target="_blank" rel="noopener">↗ View</a></td>
    `;
    tbody.appendChild(tr);
  });

  renderPagination();
  updateSortHeaders();
}

function renderPagination() {
  const pg = $('pagination');
  pg.innerHTML = '';
  const total = STATE.totalPages, cur = STATE.page;
  if (total <= 1) return;

  const addBtn = (label, p, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    btn.onclick = () => { STATE.page = p; renderTable(); };
    pg.appendChild(btn);
  };

  addBtn('‹', cur - 1, cur === 1);
  const range = [];
  for (let i = Math.max(1, cur - 2); i <= Math.min(total, cur + 2); i++) range.push(i);
  if (range[0] > 1) range.unshift(1);
  if (range[range.length - 1] < total) range.push(total);
  let last = 0;
  for (const p of range) {
    if (p - last > 1) {
      const el = document.createElement('span');
      el.textContent = '…';
      el.style.cssText = 'padding:0 6px;color:var(--text-muted);line-height:34px;';
      pg.appendChild(el);
    }
    addBtn(p, p, false, p === cur);
    last = p;
  }
  addBtn('›', cur + 1, cur === total);
}

// ============================================================
// STATS
// ============================================================
function updateStats() {
  const products = STATE.data[STATE.activeCategory].products;
  if (!products.length) return;

  $('sv-asins').textContent = formatNumber(products.length);

  const brands = new Set(products.map(p => p.brand).filter(Boolean));
  $('sv-brands').textContent = formatNumber(brands.size);

  const prices = products.map(p => {
    const c = p.stats?.current, bb = p.stats?.buyBoxPrice;
    if (bb && bb > 0) return bb;
    if (c?.[1] > 0) return c[1];
    if (c?.[0] > 0) return c[0];
    return -1;
  }).filter(v => v > 0);

  $('sv-avg-price').textContent = prices.length
    ? '₹' + Math.round(prices.reduce((s,v) => s+v, 0) / prices.length / 100).toLocaleString('en-IN')
    : '—';

  const withEan = products.filter(p => p.eanList?.length > 0).length;
  $('sv-ean').textContent = Math.round((withEan / products.length) * 100) + '%';

  const fbaCount = products.filter(p => !!(p.fbaFees || p.buyBoxEligibleOfferCounts?.[0] > 0)).length;
  $('sv-fba').textContent = Math.round((fbaCount / products.length) * 100) + '%';
}

function updateTokenDisplay() {
  if (STATE.tokensLeft === null) return;
  const el   = $('token-count');
  const wrap = el?.closest('.token-display');
  const t    = STATE.tokensLeft;
  if (el) el.textContent = `${t.toLocaleString('en-IN')} tokens`;
  if (wrap) {
    wrap.style.color       = t < 0 ? '#DC2626' : t < 100 ? '#D97706' : '';
    wrap.style.borderColor = t < 0 ? '#FCA5A5' : t < 100 ? '#FCD34D' : '';
    wrap.style.background  = t < 0 ? '#FEF2F2' : t < 100 ? '#FFFBEB' : '';
  }
}

// ============================================================
// CACHE BADGE UI
// ============================================================
function showCacheBadge(catKey, age) {
  let badge = $('cache-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'cache-badge';
    badge.style.cssText = `
      display:flex;align-items:center;gap:8px;
      background:#F0FDF4;border:1px solid rgba(34,197,94,.25);
      border-radius:8px;padding:8px 14px;margin:0 24px 16px;
      font-size:12px;font-weight:600;color:#166534;
    `;
    const tableWrapper = $('table-wrapper');
    tableWrapper?.parentNode?.insertBefore(badge, tableWrapper);
  }
  badge.innerHTML = `
    <span>📦</span>
    <span>Served from cache · ${age || 'just now'} · <strong>0 tokens used</strong></span>
    <button onclick="clearAllCache()" style="margin-left:auto;background:none;border:1px solid #BBF7D0;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;color:#166534;cursor:pointer;font-family:inherit;">
      🔄 Refresh Data
    </button>
  `;
  badge.style.display = 'flex';
}

function hideCacheBadge() {
  const badge = $('cache-badge');
  if (badge) badge.style.display = 'none';
}

// ============================================================
// BRAND FILTER
// ============================================================
function populateBrandFilter() {
  const products = STATE.data[STATE.activeCategory].products;
  const counts   = {};
  products.forEach(p => { if (p.brand) counts[p.brand] = (counts[p.brand] || 0) + 1; });

  const sel = $('filter-brand');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Brands</option>';
  Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 80).forEach(([brand, cnt]) => {
    const opt = document.createElement('option');
    opt.value = brand.toLowerCase();
    opt.textContent = `${brand} (${cnt})`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

// ============================================================
// SEARCH / FILTER / SORT
// ============================================================
const filterTable = debounce(() => {
  STATE.page = 1;
  renderTable();
  $('search-clear').style.display = $('search-input').value ? 'flex' : 'none';
}, 200);

function clearSearch() {
  $('search-input').value = '';
  $('search-clear').style.display = 'none';
  filterTable();
}

function sortTable(col) {
  if (STATE.sorted.col === col) STATE.sorted.dir = STATE.sorted.dir === 'asc' ? 'desc' : 'asc';
  else { STATE.sorted.col = col; STATE.sorted.dir = 'asc'; }
  STATE.page = 1;
  renderTable();
}

function updateSortHeaders() {
  document.querySelectorAll('.data-table th.sortable').forEach(th => th.classList.remove('sort-asc','sort-desc'));
  if (STATE.sorted.col) {
    const th = $(`th-${STATE.sorted.col}`);
    if (th) th.classList.add(STATE.sorted.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  }
}

// ============================================================
// EXPORT
// ============================================================
function exportCurrentData() {
  const catKey   = STATE.activeCategory;
  const products = getFilteredProducts();
  if (!products.length) { showToast('⚠️ No data to export', 'error'); return; }

  const catName = CONFIG.CATEGORIES[catKey].name;
  const rows = [['#','ASIN','Title','Brand','EAN/GTIN','All EANs','Price (₹)','Rating','Reviews','BSR','FBA','Category','Amazon URL']];

  products.forEach((p, i) => {
    const eans  = p.eanList || [];
    let rawPrice = -1;
    const c = p.stats?.current, bb = p.stats?.buyBoxPrice;
    if (bb && bb > 0) rawPrice = bb;
    else if (c?.[1] > 0) rawPrice = c[1];
    else if (c?.[0] > 0) rawPrice = c[0];

    const rc  = p.reviews?.ratingCount;
    const rvc = p.reviews?.reviewCount;
    const rating  = rc?.length  >= 2 ? (rc[rc.length - 1]   / 10).toFixed(1) : '';
    const reviews = rvc?.length >= 2 ? rvc[rvc.length - 1] : '';

    let bsr = '';
    const sr = p.salesRanks;
    if (sr) { const k = Object.keys(sr)[0]; const v = sr[k]; if (Array.isArray(v) && v.length >= 2) bsr = v[v.length-1]; }

    rows.push([
      i+1, p.asin||'',
      `"${(p.title||'').replace(/"/g,'""')}"`,
      p.brand||'', eans[0]||'', eans.join('; '),
      rawPrice > 0 ? (rawPrice/100).toFixed(2) : '',
      rating, reviews, bsr,
      (p.fbaFees || p.buyBoxEligibleOfferCounts?.[0] > 0) ? 'FBA' : 'FBM',
      catName, `https://www.amazon.in/dp/${p.asin||''}`
    ]);
  });

  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `BulkListIQ_${catName.replace(/\s/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`✅ Exported ${products.length} rows to CSV`, 'success');
}

// ============================================================
// UI STATE
// ============================================================
function showLoading() {
  $('loading-state').style.display = 'flex';
  $('table-wrapper').style.display = 'none';
  $('error-state').style.display   = 'none';
  hideCacheBadge();
}
function showTable() {
  $('loading-state').style.display = 'none';
  $('table-wrapper').style.display = 'block';
  $('error-state').style.display   = 'none';
}
function showError(title, sub) {
  $('loading-state').style.display = 'none';
  $('table-wrapper').style.display = 'none';
  $('error-state').style.display   = 'flex';
  $('error-title').textContent = title;
  $('error-sub').textContent   = sub;
}
function setLoadingText(title, sub) {
  const el = $('loading-title');
  el.textContent = title;
  el.classList.toggle('waiting', title.startsWith('⏳'));
  $('loading-sub').textContent = sub;
}
function setProgress(pct) {
  $('loading-bar').style.cssText = `width:${pct}%;animation:none;`;
}
function retryLoad() {
  const catKey = STATE.activeCategory;
  STATE.data[catKey].loaded = false;
  STATE.data[catKey].products = [];
  STATE.data[catKey].bestsellersAsins = [];
  $('loading-bar').style.cssText = '';
  showLoading();
  loadCategoryData(catKey);
}

// ============================================================
// TOAST & COPY
// ============================================================
function showToast(msg, type = 'info') {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${type==='success'?'✓':type==='error'?'✕':'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => t.remove(), 300); }, 4000);
}

function copyAsin(asin, event) {
  navigator.clipboard.writeText(asin).then(() => {
    const b = document.createElement('div');
    b.className = 'copied-badge';
    b.textContent = 'Copied!';
    b.style.left = `${event.clientX - 30}px`;
    b.style.top  = `${event.clientY - 30}px`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1300);
  }).catch(() => showToast(`ASIN: ${asin}`, 'info'));
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  Object.keys(CONFIG.CATEGORIES).forEach(key => $(`count-${key}`).textContent = '—');
  loadCategoryData('electronics');
});
