/* ============================================================
   BulkListIQ — JavaScript Application
   Real-time Keepa API Integration for Amazon India ASIN Explorer
   ============================================================ */

'use strict';

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  KEEPA_KEY: 'pa8osmtpo6bq3bbf3vgfqmp78p0ifbouv34flbvs51hsjqkb7kg6qjgddpspinlp', // used only on localhost
  DOMAIN: 10,  // Amazon India
  // On Vercel: use the secure server-side proxy (key stays in env vars)
  // On localhost: call Keepa directly (for development)
  IS_LOCAL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',
  BASE_URL: 'https://api.keepa.com',
  PROXY_URL: '/api/keepa',
  BATCH_SIZE: 100,    // ASINs per product call
  INITIAL_LOAD: 100,  // Initial bestseller ASINs to enrich
  PAGE_SIZE: 50,      // Rows per page in table

  CATEGORIES: {
    electronics: {
      id: 976419031,
      name: 'Consumer Electronics',
      icon: '📱',
      color: '#6366F1',
      description: 'Smartphones, headphones, laptops & more'
    },
    automotive: {
      id: 4772060031,
      name: 'Car & Motorbike',
      icon: '🚗',
      color: '#F97316',
      description: 'Car accessories, motorbike parts & care products'
    },
    home: {
      id: 3704992031,
      name: 'Home & Kitchen',
      icon: '🏠',
      color: '#22C55E',
      description: 'Kitchen appliances, home décor & improvement'
    }
  }
};

// ============================================================
// STATE
// ============================================================
const STATE = {
  activeCategory: 'electronics',
  data: {
    electronics: { asins: [], products: [], loaded: false, bestsellersAsins: [] },
    automotive:  { asins: [], products: [], loaded: false, bestsellersAsins: [] },
    home:        { asins: [], products: [], loaded: false, bestsellersAsins: [] }
  },
  filtered: [],
  sorted: { col: null, dir: 'asc' },
  page: 1,
  totalPages: 1,
  tokensLeft: null,
  loading: false
};

// ============================================================
// DOM REFERENCES
// ============================================================
const $ = id => document.getElementById(id);

// ============================================================
// UTILS
// ============================================================
function keepaPrice(raw) {
  if (!raw || raw === -1 || raw < 0) return null;
  return (raw / 100).toFixed(2);
}

function keepaRating(raw) {
  if (!raw || raw < 0) return null;
  return (raw / 10).toFixed(1);
}

function formatNumber(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

function formatPrice(raw) {
  const val = keepaPrice(raw);
  if (!val) return null;
  return '₹' + parseFloat(val).toLocaleString('en-IN');
}

function starsHtml(rating) {
  if (!rating) return '';
  const r = parseFloat(rating);
  const full = Math.floor(r);
  const half = r - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================
// KEEPA API — with smart rate-limit retry + countdown
// ============================================================
async function keepaFetch(endpoint, params, retryCount = 0) {
  let url;

  if (CONFIG.IS_LOCAL) {
    // Local dev: call Keepa directly
    url = new URL(`${CONFIG.BASE_URL}/${endpoint}`);
    url.searchParams.set('key', CONFIG.KEEPA_KEY);
    url.searchParams.set('domain', CONFIG.DOMAIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    // Vercel deployment: use server-side proxy (key is in env vars)
    url = new URL(CONFIG.PROXY_URL, window.location.origin);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('domain', CONFIG.DOMAIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  let resp;
  try {
    resp = await fetch(url.toString());
  } catch (netErr) {
    throw new Error('Network error — check your internet connection');
  }

  // Parse response body regardless of status (Keepa returns JSON even on 429)
  let data = {};
  try { data = await resp.json(); } catch (_) {}

  // Update token count from response
  if (data.tokensLeft !== undefined) {
    STATE.tokensLeft = data.tokensLeft;
    updateTokenDisplay();
  }

  // Handle 429 (Too Many Requests) / token exhaustion
  if (resp.status === 429 || (data.tokensLeft !== undefined && data.tokensLeft < 0)) {
    const refillInMs = data.refillIn || 60000; // fallback 60s
    const refillInSec = Math.ceil(refillInMs / 1000);

    if (retryCount >= 5) {
      throw new Error(`Token limit reached after ${retryCount} retries. Please wait a moment and try again.`);
    }

    // Show countdown in the loading UI
    await countdownWait(refillInSec, retryCount);

    // Retry after refill
    return keepaFetch(endpoint, params, retryCount + 1);
  }

  if (!resp.ok) {
    throw new Error(`Keepa API error: ${resp.status} ${resp.statusText}`);
  }

  return data;
}

async function countdownWait(seconds, attempt) {
  const start = Date.now();
  const end = start + (seconds * 1000) + 500;

  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    const tokStr = STATE.tokensLeft !== null ? ` (${STATE.tokensLeft} tokens)` : '';
    setLoadingText(
      `⏳ Token limit reached — auto-retrying in ${remaining}s`,
      `Keepa refills 20 tokens/minute${tokStr}. Attempt ${attempt + 1} of 5...`
    );
    // Also show in error-state if visible
    const errSub = $('error-sub');
    if (errSub) errSub.textContent = `Tokens refilling... retrying in ${remaining}s`;
    await sleep(800);
  }

  setLoadingText('🔄 Retrying request...', 'Reconnecting to Keepa API');
}

async function fetchBestsellers(catKey) {
  const cat = CONFIG.CATEGORIES[catKey];
  setLoadingText(`Fetching bestsellers from ${cat.name}...`, 'Connecting to Amazon India catalog via Keepa');
  setProgress(15);

  const data = await keepaFetch('bestsellers', { category: cat.id });
  const asins = (data.bestSellersList?.asinList || []).filter(Boolean);
  STATE.data[catKey].bestsellersAsins = asins;
  $(`count-${catKey}`).textContent = formatNumber(asins.length);
  return asins;
}

async function fetchProductBatch(asins) {
  if (!asins.length) return [];
  const data = await keepaFetch('product', {
    asin: asins.join(','),
    history: 0,
    stats: 180,
    offers: 20,
    rating: 1
  });
  return data.products || [];
}

async function loadCategoryData(catKey) {
  if (STATE.data[catKey].loaded) return;
  STATE.loading = true;
  showLoading();

  try {
    // Step 1: Get bestseller ASINs
    const allAsins = await fetchBestsellers(catKey);
    const toEnrich = allAsins.slice(0, CONFIG.INITIAL_LOAD);

    // Step 2: Enrich in batches
    setLoadingText(
      `Loading ${toEnrich.length} products from Keepa...`,
      `Fetching title, EAN/GTIN, price, rating & more`
    );
    setProgress(35);

    const products = [];
    const batches = Math.ceil(toEnrich.length / CONFIG.BATCH_SIZE);

    for (let i = 0; i < batches; i++) {
      const batch = toEnrich.slice(i * CONFIG.BATCH_SIZE, (i + 1) * CONFIG.BATCH_SIZE);
      const progress = 35 + Math.round(((i + 1) / batches) * 60);
      setProgress(progress);
      setLoadingText(
        `Processing batch ${i + 1} of ${batches}...`,
        `Enriching ${batch.length} ASINs with product intelligence`
      );
      const batchProds = await fetchProductBatch(batch);
      products.push(...batchProds);
      if (i < batches - 1) await sleep(200); // Rate limit courtesy
    }

    STATE.data[catKey].asins = allAsins;
    STATE.data[catKey].products = products;
    STATE.data[catKey].loaded = true;
    setProgress(100);
    await sleep(300);

    renderTable();
    updateStats();
    populateBrandFilter();
    showTable();
    showToast(`✅ Loaded ${products.length} products from ${CONFIG.CATEGORIES[catKey].name}`, 'success');

  } catch (err) {
    console.error('Load error:', err);
    showError('Failed to load data', err.message || 'API request failed. Check console for details.');
  } finally {
    STATE.loading = false;
  }
}

async function loadMoreProducts() {
  const catKey = STATE.activeCategory;
  const cat = STATE.data[catKey];
  if (!cat.loaded || STATE.loading) return;

  const $btn = $('btn-load-more');
  $btn.disabled = true;
  $btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Loading...`;

  STATE.loading = true;

  try {
    const alreadyLoaded = cat.products.length;
    const toEnrich = cat.bestsellersAsins.slice(alreadyLoaded, alreadyLoaded + CONFIG.INITIAL_LOAD);

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
      if (i < batches - 1) await sleep(200);
    }

    renderTable();
    updateStats();
    populateBrandFilter();
    showToast(`✅ Loaded ${toEnrich.length} more products`, 'success');

  } catch (err) {
    showToast('❌ Failed to load more products', 'error');
    console.error(err);
  } finally {
    STATE.loading = false;
    $btn.disabled = false;
    $btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg> Load More`;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// CATEGORY SWITCHING
// ============================================================
function switchCategory(catKey) {
  if (catKey === STATE.activeCategory && STATE.data[catKey].loaded) return;
  STATE.activeCategory = catKey;
  STATE.page = 1;
  STATE.sorted = { col: null, dir: 'asc' };

  // Update tab UI
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === catKey);
  });

  // Clear search/filters
  $('search-input').value = '';
  $('search-clear').style.display = 'none';
  $('filter-brand').value = '';
  $('filter-rating').value = '';
  $('filter-ean').value = '';

  if (STATE.data[catKey].loaded) {
    renderTable();
    updateStats();
    populateBrandFilter();
    showTable();
  } else {
    showLoading();
    loadCategoryData(catKey);
  }
}

// ============================================================
// TABLE RENDERING
// ============================================================
function getFilteredProducts() {
  const catKey = STATE.activeCategory;
  let products = [...STATE.data[catKey].products];

  const query = $('search-input').value.toLowerCase().trim();
  const filterBrand = $('filter-brand').value.toLowerCase();
  const filterRating = parseFloat($('filter-rating').value) || 0;
  const filterEan = $('filter-ean').value;

  if (query) {
    products = products.filter(p => {
      const t = (p.title || '').toLowerCase();
      const a = (p.asin || '').toLowerCase();
      const b = (p.brand || '').toLowerCase();
      const ean = (p.eanList || []).join(' ').toLowerCase();
      return t.includes(query) || a.includes(query) || b.includes(query) || ean.includes(query);
    });
  }

  if (filterBrand) {
    products = products.filter(p => (p.brand || '').toLowerCase() === filterBrand);
  }

  if (filterRating) {
    products = products.filter(p => {
      const r = keepaRating(p.avgRating);
      return r && parseFloat(r) >= filterRating;
    });
  }

  if (filterEan === 'has') {
    products = products.filter(p => p.eanList && p.eanList.length > 0);
  } else if (filterEan === 'none') {
    products = products.filter(p => !p.eanList || p.eanList.length === 0);
  }

  // Sorting
  if (STATE.sorted.col) {
    products.sort((a, b) => {
      let va, vb;
      switch (STATE.sorted.col) {
        case 'asin':    va = a.asin || ''; vb = b.asin || ''; break;
        case 'title':   va = a.title || ''; vb = b.title || ''; break;
        case 'brand':   va = a.brand || ''; vb = b.brand || ''; break;
        case 'ean':
          va = (a.eanList || [])[0] || '';
          vb = (b.eanList || [])[0] || '';
          break;
        case 'price':
          {
            const getP = prod => {
              const cur = prod.stats?.current;
              const bbp = prod.stats?.buyBoxPrice;
              if (bbp && bbp > 0) return bbp;
              if (cur && cur[1] > 0) return cur[1];
              if (cur && cur[0] > 0) return cur[0];
              return Infinity;
            };
            va = getP(a); vb = getP(b);
          }
          break;
        case 'rating':
          va = (a.reviews?.ratingCount?.length >= 2 ? a.reviews.ratingCount[a.reviews.ratingCount.length - 1] : 0);
          vb = (b.reviews?.ratingCount?.length >= 2 ? b.reviews.ratingCount[b.reviews.ratingCount.length - 1] : 0);
          break;
        case 'reviews':
          va = (a.reviews?.reviewCount?.length >= 2 ? a.reviews.reviewCount[a.reviews.reviewCount.length - 1] : 0);
          vb = (b.reviews?.reviewCount?.length >= 2 ? b.reviews.reviewCount[b.reviews.reviewCount.length - 1] : 0);
          break;
        case 'rank':
          va = a.salesRanks?.[Object.keys(a.salesRanks || {})[0]]?.slice(-2)?.[1] || Infinity;
          vb = b.salesRanks?.[Object.keys(b.salesRanks || {})[0]]?.slice(-2)?.[1] || Infinity;
          break;
        default: va = ''; vb = '';
      }
      if (typeof va === 'string') {
        const cmp = va.localeCompare(vb);
        return STATE.sorted.dir === 'asc' ? cmp : -cmp;
      }
      return STATE.sorted.dir === 'asc' ? va - vb : vb - va;
    });
  }

  return products;
}

function renderTable() {
  const filtered = getFilteredProducts();
  STATE.filtered = filtered;
  const total = filtered.length;

  STATE.totalPages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  if (STATE.page > STATE.totalPages) STATE.page = 1;

  const start = (STATE.page - 1) * CONFIG.PAGE_SIZE;
  const page = filtered.slice(start, start + CONFIG.PAGE_SIZE);

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
    const asin = p.asin || '—';
    const title = p.title || 'Unknown Product';
    const brand = p.brand || '';
    const eans = p.eanList || [];
    const ean = eans[0] || null;

    // Price: stats.current is array of prices in keepa CSV format
    // For Amazon.in, stats.buyBoxPrice or stats.current[0] = Amazon price, current[1] = new price, etc.
    let rawPrice = -1;
    if (p.stats) {
      // stats.current layout: [Amazon, New, Used, Sales Rank, ...]
      const cur = p.stats.current;
      if (p.stats.buyBoxPrice && p.stats.buyBoxPrice > 0) {
        rawPrice = p.stats.buyBoxPrice;
      } else if (cur && cur.length > 1 && cur[1] > 0) {
        rawPrice = cur[1]; // New price
      } else if (cur && cur.length > 0 && cur[0] > 0) {
        rawPrice = cur[0];
      }
    }

    // Rating
    // Rating: extract last value from reviews.ratingCount (pairs of [keepaTime, value])
    let rawRating = null;
    if (p.reviews?.ratingCount?.length >= 2) {
      rawRating = p.reviews.ratingCount[p.reviews.ratingCount.length - 1];
    }
    const rating = rawRating ? (rawRating / 10).toFixed(1) : null;

    // Reviews: extract last value from reviews.reviewCount
    let reviews = 0;
    if (p.reviews?.reviewCount?.length >= 2) {
      reviews = p.reviews.reviewCount[p.reviews.reviewCount.length - 1];
    }

    // BSR
    let bsr = null;
    if (p.salesRanks) {
      const rankKeys = Object.keys(p.salesRanks);
      if (rankKeys.length) {
        const rankData = p.salesRanks[rankKeys[0]];
        if (Array.isArray(rankData) && rankData.length >= 2) {
          bsr = rankData[rankData.length - 1]; // last rank value
        }
      }
    }

    // FBA: check buyBoxEligibleOfferCounts or fbaFees
    const isFBA = !!(p.fbaFees || (p.buyBoxEligibleOfferCounts && p.buyBoxEligibleOfferCounts[0] > 0));

    const priceStr = formatPrice(rawPrice);
    const priceHtml = priceStr
      ? `<span class="price-val">${priceStr}</span>`
      : `<span class="price-na">—</span>`;

    const eanHtml = ean
      ? `<span class="ean-value" title="${eans.join(', ')}">${ean}</span>`
      : `<span class="ean-none">—</span>`;

    const brandHtml = brand
      ? `<span class="brand-pill" title="${brand}">${brand}</span>`
      : `<span style="color:var(--text-faint);font-size:12px;">—</span>`;

    const ratingHtml = rating
      ? `<div class="rating-display">
           <span class="rating-stars" title="${rating}">${starsHtml(rating)}</span>
           <span class="rating-val">${rating}</span>
         </div>`
      : `<span style="color:var(--text-faint);">—</span>`;

    const reviewsHtml = reviews
      ? `<span class="reviews-count">${formatNumber(reviews)}</span>`
      : `<span style="color:var(--text-faint);">—</span>`;

    let bsrHtml = `<span style="color:var(--text-faint);">—</span>`;
    if (bsr) {
      const cls = bsr < 1000 ? 'rank-good' : bsr < 50000 ? 'rank-mid' : 'rank-val';
      bsrHtml = `<span class="${cls}" title="Best Sellers Rank">#${bsr.toLocaleString('en-IN')}</span>`;
    }

    const fbaHtml = `<span class="${isFBA ? 'badge-fba' : 'badge-fbm'}">${isFBA ? 'FBA' : 'FBM'}</span>`;

    const amazonUrl = `https://www.amazon.in/dp/${asin}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num"><div class="row-num">${rowNum}</div></td>
      <td class="col-asin">
        <span class="asin-chip" onclick="copyAsin('${asin}', event)" title="Click to copy ASIN">${asin}</span>
      </td>
      <td class="col-title">
        <div class="product-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      </td>
      <td class="col-brand">${brandHtml}</td>
      <td class="col-ean">${eanHtml}</td>
      <td class="col-price">${priceHtml}</td>
      <td class="col-rating">${ratingHtml}</td>
      <td class="col-reviews">${reviewsHtml}</td>
      <td class="col-rank">${bsrHtml}</td>
      <td class="col-fba">${fbaHtml}</td>
      <td class="col-link">
        <a class="amazon-link" href="${amazonUrl}" target="_blank" rel="noopener" title="View on Amazon India">
          ↗ View
        </a>
      </td>
    `;
    tbody.appendChild(tr);
  });

  renderPagination();
  updateSortHeaders();
}

function renderPagination() {
  const pg = $('pagination');
  pg.innerHTML = '';
  const total = STATE.totalPages;
  const cur = STATE.page;

  if (total <= 1) return;

  const addBtn = (label, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    btn.onclick = () => { STATE.page = page; renderTable(); };
    pg.appendChild(btn);
  };

  addBtn('‹', cur - 1, cur === 1);

  const range = getPaginationRange(cur, total);
  let last = 0;
  for (const p of range) {
    if (p - last > 1) {
      const ellipsis = document.createElement('span');
      ellipsis.textContent = '…';
      ellipsis.style.cssText = 'padding: 0 6px; color: var(--text-muted); line-height: 34px;';
      pg.appendChild(ellipsis);
    }
    addBtn(p, p, false, p === cur);
    last = p;
  }

  addBtn('›', cur + 1, cur === total);
}

function getPaginationRange(cur, total) {
  const delta = 2;
  const range = [];
  for (let i = Math.max(1, cur - delta); i <= Math.min(total, cur + delta); i++) range.push(i);
  if (range[0] > 1) range.unshift(1);
  if (range[range.length - 1] < total) range.push(total);
  return range;
}

// ============================================================
// STATS
// ============================================================
function updateStats() {
  const catKey = STATE.activeCategory;
  const products = STATE.data[catKey].products;
  const catInfo = CONFIG.CATEGORIES[catKey];

  if (!products.length) return;

  // Total loaded
  $('sv-asins').textContent = formatNumber(products.length);

  // Unique brands
  const brands = new Set(products.map(p => p.brand).filter(Boolean));
  $('sv-brands').textContent = formatNumber(brands.size);

  // Average buy box price
  const prices = products
    .map(p => {
      const cur = p.stats?.current;
      const bbp = p.stats?.buyBoxPrice;
      if (bbp && bbp > 0) return bbp;
      if (cur && cur[1] > 0) return cur[1];
      if (cur && cur[0] > 0) return cur[0];
      return -1;
    })
    .filter(v => v > 0);
  if (prices.length) {
    const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
    $('sv-avg-price').textContent = '₹' + (avg / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  } else {
    $('sv-avg-price').textContent = '—';
  }

  // EAN coverage
  const withEan = products.filter(p => p.eanList && p.eanList.length > 0).length;
  const eanPct = products.length ? Math.round((withEan / products.length) * 100) : 0;
  $('sv-ean').textContent = eanPct + '%';

  // FBA %
  const fbaCount = products.filter(p => !!(p.fbaFees || (p.buyBoxEligibleOfferCounts && p.buyBoxEligibleOfferCounts[0] > 0))).length;
  const fbaPct = products.length ? Math.round((fbaCount / products.length) * 100) : 0;
  $('sv-fba').textContent = fbaPct + '%';
}

function updateTokenDisplay() {
  if (STATE.tokensLeft !== null) {
    const el = $('token-count');
    const tokens = STATE.tokensLeft;
    el.textContent = `${tokens.toLocaleString('en-IN')} tokens`;
    // Color-code by level
    const wrap = el.closest('.token-display');
    if (wrap) {
      wrap.style.color = tokens < 0 ? '#DC2626' : tokens < 50 ? '#D97706' : '';
      wrap.style.borderColor = tokens < 0 ? '#FCA5A5' : tokens < 50 ? '#FCD34D' : '';
      wrap.style.background = tokens < 0 ? '#FEF2F2' : tokens < 50 ? '#FFFBEB' : '';
    }
  }
}

// ============================================================
// BRAND FILTER
// ============================================================
function populateBrandFilter() {
  const catKey = STATE.activeCategory;
  const products = STATE.data[catKey].products;
  const brandCounts = {};
  products.forEach(p => {
    if (p.brand) brandCounts[p.brand] = (brandCounts[p.brand] || 0) + 1;
  });

  const sorted = Object.entries(brandCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);

  const sel = $('filter-brand');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Brands</option>';
  sorted.forEach(([brand, count]) => {
    const opt = document.createElement('option');
    opt.value = brand.toLowerCase();
    opt.textContent = `${brand} (${count})`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

// ============================================================
// SEARCH & FILTER
// ============================================================
const filterTable = debounce(() => {
  STATE.page = 1;
  renderTable();
  const q = $('search-input').value;
  $('search-clear').style.display = q ? 'flex' : 'none';
}, 200);

function clearSearch() {
  $('search-input').value = '';
  $('search-clear').style.display = 'none';
  filterTable();
}

// ============================================================
// SORTING
// ============================================================
function sortTable(col) {
  if (STATE.sorted.col === col) {
    STATE.sorted.dir = STATE.sorted.dir === 'asc' ? 'desc' : 'asc';
  } else {
    STATE.sorted.col = col;
    STATE.sorted.dir = 'asc';
  }
  STATE.page = 1;
  renderTable();
}

function updateSortHeaders() {
  document.querySelectorAll('.data-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
  });
  if (STATE.sorted.col) {
    const th = $(`th-${STATE.sorted.col}`);
    if (th) th.classList.add(STATE.sorted.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  }
}

// ============================================================
// EXPORT
// ============================================================
function exportCurrentData() {
  const catKey = STATE.activeCategory;
  const products = getFilteredProducts();

  if (!products.length) {
    showToast('⚠️ No data to export', 'error');
    return;
  }

  const catName = CONFIG.CATEGORIES[catKey].name;
  const rows = [
    ['#', 'ASIN', 'Title', 'Brand', 'EAN/GTIN', 'All EANs', 'Price (₹)', 'Rating', 'Reviews', 'BSR', 'FBA', 'Category', 'Amazon URL']
  ];

  products.forEach((p, i) => {
    const asin = p.asin || '';
    const title = (p.title || '').replace(/"/g, '""');
    const brand = p.brand || '';
    const eans = p.eanList || [];
    const ean1 = eans[0] || '';
    const allEans = eans.join('; ');

    let rawPrice = -1;
    const cur = p.stats?.current;
    const bbp = p.stats?.buyBoxPrice;
    if (bbp && bbp > 0) rawPrice = bbp;
    else if (cur && cur[1] > 0) rawPrice = cur[1];
    else if (cur && cur[0] > 0) rawPrice = cur[0];
    const price = rawPrice > 0 ? (rawPrice / 100).toFixed(2) : '';

    let rating = '';
    if (p.reviews?.ratingCount?.length >= 2) {
      rating = (p.reviews.ratingCount[p.reviews.ratingCount.length - 1] / 10).toFixed(1);
    }

    let reviews = '';
    if (p.reviews?.reviewCount?.length >= 2) {
      reviews = p.reviews.reviewCount[p.reviews.reviewCount.length - 1];
    }

    let bsr = '';
    if (p.salesRanks) {
      const rankKeys = Object.keys(p.salesRanks);
      if (rankKeys.length) {
        const rankData = p.salesRanks[rankKeys[0]];
        if (Array.isArray(rankData) && rankData.length >= 2) bsr = rankData[rankData.length - 1];
      }
    }

    const fba = (p.isFBAPercent ?? 0) > 50 ? 'FBA' : 'FBM';
    const url = `https://www.amazon.in/dp/${asin}`;

    rows.push([i + 1, asin, `"${title}"`, brand, ean1, allEans, price, rating, reviews, bsr, fba, catName, url]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
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
  $('error-state').style.display = 'none';
}

function showTable() {
  $('loading-state').style.display = 'none';
  $('table-wrapper').style.display = 'block';
  $('error-state').style.display = 'none';
}

function showError(title, sub) {
  $('loading-state').style.display = 'none';
  $('table-wrapper').style.display = 'none';
  $('error-state').style.display = 'flex';
  $('error-title').textContent = title;
  $('error-sub').textContent = sub;
}

function setLoadingText(title, sub) {
  const el = $('loading-title');
  el.textContent = title;
  el.classList.toggle('waiting', title.startsWith('⏳'));
  $('loading-sub').textContent = sub;
}

function setProgress(pct) {
  $('loading-bar').style.cssText = `width: ${pct}%; animation: none;`;
}

function retryLoad() {
  const catKey = STATE.activeCategory;
  STATE.data[catKey].loaded = false;
  STATE.data[catKey].products = [];
  STATE.data[catKey].asins = [];
  // Reset the loading bar to indeterminate animation
  const bar = $('loading-bar');
  if (bar) bar.style.cssText = '';
  showLoading();
  loadCategoryData(catKey);
}

// ============================================================
// TOAST
// ============================================================
function showToast(msg, type = 'info') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============================================================
// COPY ASIN
// ============================================================
function copyAsin(asin, event) {
  navigator.clipboard.writeText(asin).then(() => {
    const badge = document.createElement('div');
    badge.className = 'copied-badge';
    badge.textContent = 'Copied!';
    badge.style.left = `${event.clientX - 30}px`;
    badge.style.top = `${event.clientY - 30}px`;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1300);
  }).catch(() => {
    showToast(`ASIN: ${asin}`, 'info');
  });
}

// ============================================================
// HTML ESCAPE
// ============================================================
function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// SEARCH INPUT HANDLER
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Init category counts from config
  Object.keys(CONFIG.CATEGORIES).forEach(key => {
    $(`count-${key}`).textContent = '—';
  });

  // Load initial category
  loadCategoryData('electronics');
});
