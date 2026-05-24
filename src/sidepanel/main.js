import { matchDomain, getCrawlerStats, postScanResult } from '../lib/mochoApi.js';

// ── State ────────────────────────────────────────────────────────────────────
let currentTabId = null;
let currentUrl = null;
let analysisData = null;
let activeTabName = 'overview';
let connectionState = null; // { status, domain, site, stats, error, cta }

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clamp(val, min, max) { return Math.min(max, Math.max(min, val)); }

function statusClass(pass, warn) {
  if (pass) return 'pass';
  if (warn) return 'warn';
  return 'fail';
}

// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTabName = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`pane-${activeTabName}`).classList.add('active');
  });
});

// ── Page inspection (runs in page context via executeScript) ──────────────────
function inspectPage() {
  function collectMeta() {
    const m = {
      title: document.title,
      titleLen: document.title.length,
      description: null,
      descriptionLen: 0,
      canonical: null,
      robots: null,
      viewport: null,
      og: {},
      twitter: {},
    };

    document.querySelectorAll('meta').forEach((el) => {
      const name = (el.getAttribute('name') || '').toLowerCase();
      const prop = (el.getAttribute('property') || '').toLowerCase();
      const content = el.getAttribute('content') || '';

      if (name === 'description') { m.description = content; m.descriptionLen = content.length; }
      else if (name === 'robots') m.robots = content;
      else if (name === 'viewport') m.viewport = content;
      else if (prop.startsWith('og:')) m.og[prop.slice(3)] = content;
      else if (name.startsWith('twitter:')) m.twitter[name.slice(8)] = content;
    });

    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) m.canonical = canon.href;

    return m;
  }

  function collectStructuredData() {
    const items = [];

    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        const data = JSON.parse(el.textContent);
        items.push({ kind: 'json-ld', data, valid: true });
      } catch (e) {
        items.push({ kind: 'json-ld', valid: false, error: e.message });
      }
    });

    document.querySelectorAll('[itemscope]').forEach((el) => {
      const itemtype = el.getAttribute('itemtype') || '(unknown)';
      const props = {};
      el.querySelectorAll('[itemprop]').forEach((p) => {
        const key = p.getAttribute('itemprop');
        const val = p.getAttribute('content') || p.textContent.trim().slice(0, 150);
        if (key) props[key] = val;
      });
      items.push({ kind: 'microdata', itemtype, props, valid: true });
    });

    return items;
  }

  function collectWebVitals() {
    const v = {};
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        v.ttfb = Math.round(nav.responseStart - nav.requestStart);
        v.domInteractive = Math.round(nav.domInteractive);
        v.loadTime = Math.round(nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : 0);
      }

      const paint = performance.getEntriesByType('paint');
      const fcp = paint.find((e) => e.name === 'first-contentful-paint');
      if (fcp) v.fcp = Math.round(fcp.startTime);

      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length) {
        const lcp = lcpEntries[lcpEntries.length - 1];
        v.lcp = Math.round(lcp.startTime);
        v.lcpElement = lcp.element ? lcp.element.tagName.toLowerCase() : null;
      }

      // CLS: max session window
      const shifts = performance.getEntriesByType('layout-shift');
      let cls = 0, sessionVal = 0, sessionStart = 0, lastShift = null;
      for (const s of shifts) {
        if (!s.hadRecentInput) {
          if (lastShift && s.startTime - lastShift.startTime < 1000 && s.startTime - sessionStart < 5000) {
            sessionVal += s.value;
          } else {
            sessionVal = s.value;
            sessionStart = s.startTime;
          }
          if (sessionVal > cls) cls = sessionVal;
          lastShift = s;
        }
      }
      v.cls = Math.round(cls * 1000) / 1000;

      const fid = performance.getEntriesByType('first-input')[0];
      if (fid) v.fid = Math.round(fid.processingStart - fid.startTime);

      // INP: 98th-percentile event duration
      const events = performance.getEntriesByType('event');
      if (events.length) {
        const sorted = events.map((e) => e.duration).sort((a, b) => a - b);
        const idx = Math.max(0, Math.ceil(sorted.length * 0.98) - 1);
        v.inp = Math.round(sorted[idx]);
      }
    } catch (_) { /* graceful degradation */ }
    return v;
  }

  function collectJSSignals() {
    const s = {};
    s.totalElements = document.querySelectorAll('*').length;
    s.links = document.querySelectorAll('a[href]').length;
    s.headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
    s.images = document.querySelectorAll('img').length;
    s.textLength = (document.body && document.body.innerText) ? document.body.innerText.length : 0;
    s.inlineScripts = document.querySelectorAll('script:not([src])').length;
    s.externalScripts = document.querySelectorAll('script[src]').length;
    s.lazyImages = document.querySelectorAll('img[loading="lazy"]').length;
    s.noscriptCount = document.querySelectorAll('noscript').length;

    // Framework detection
    const frameworks = [];
    try {
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')) frameworks.push('React');
      if (window.ng || document.querySelector('[ng-version]')) frameworks.push('Angular');
      if (window.__VUE__ || document.querySelector('[data-v-app]')) frameworks.push('Vue');
      if (document.querySelector('#__NEXT_DATA__')) frameworks.push('Next.js');
      if (document.querySelector('#__NUXT__')) frameworks.push('Nuxt.js');
      if (document.querySelector('#gatsby-announcer')) frameworks.push('Gatsby');
      if (document.querySelector('meta[name="generator"][content*="WordPress"]')) frameworks.push('WordPress');
    } catch (_) {}
    s.frameworks = frameworks;

    // SSR signals
    s.hasSSRMarker = !!(
      document.querySelector('#__NEXT_DATA__') ||
      document.querySelector('#__NUXT__') ||
      document.querySelector('[data-server-rendered="true"]') ||
      document.querySelector('meta[name="generator"]')
    );

    // Empty app root (sign of pure CSR before hydration finishes)
    s.emptyRoots = Array.from(
      document.querySelectorAll('#app,#root,#__next,[data-app]')
    ).filter((el) => el.childElementCount === 0).length;

    return s;
  }

  return {
    url: window.location.href,
    meta: collectMeta(),
    structuredData: collectStructuredData(),
    webVitals: collectWebVitals(),
    jsSignals: collectJSSignals(),
  };
}

// ── JS Visibility: fetch raw HTML and compare with live DOM ───────────────────
async function fetchRawComparison(url, liveSignals) {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!res.ok) return { fetchFailed: true, status: res.status };

    const html = await res.text();
    const parser = new DOMParser();
    const rawDoc = parser.parseFromString(html, 'text/html');

    const rawText = rawDoc.body ? rawDoc.body.innerText.length : 0;
    const rawLinks = rawDoc.querySelectorAll('a[href]').length;
    const rawHeadings = rawDoc.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
    const rawImages = rawDoc.querySelectorAll('img').length;
    const rawTitle = rawDoc.title;
    const rawDesc = (() => {
      const el = rawDoc.querySelector('meta[name="description"]');
      return el ? el.getAttribute('content') : null;
    })();
    const rawCanon = (() => {
      const el = rawDoc.querySelector('link[rel="canonical"]');
      return el ? el.getAttribute('href') : null;
    })();

    const textDelta = rawText > 0
      ? ((liveSignals.textLength - rawText) / rawText)
      : liveSignals.textLength > 0 ? 1 : 0;

    return {
      fetchFailed: false,
      rawText,
      rawLinks,
      rawHeadings,
      rawImages,
      rawTitle,
      rawDesc,
      rawCanon,
      textDelta: Math.round(textDelta * 100) / 100,
      liveText: liveSignals.textLength,
      liveLinks: liveSignals.links,
      liveHeadings: liveSignals.headings,
      liveImages: liveSignals.images,
    };
  } catch (err) {
    return { fetchFailed: true, error: err.message };
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function scoreMeta(meta) {
  let score = 0;
  const issues = [];

  // Title (8 pts)
  if (!meta.title) {
    issues.push({ level: 'fail', text: '<strong>Missing title tag</strong> — required for SEO.' });
  } else if (meta.titleLen < 30 || meta.titleLen > 60) {
    score += 5;
    issues.push({ level: 'warn', text: `<strong>Title length</strong> is ${meta.titleLen} chars. Aim for 30–60.` });
  } else {
    score += 8;
    issues.push({ level: 'pass', text: `<strong>Title</strong> is ${meta.titleLen} chars — good length.` });
  }

  // Description (8 pts)
  if (!meta.description) {
    issues.push({ level: 'fail', text: '<strong>Missing meta description</strong> — helps click-through rates.' });
  } else if (meta.descriptionLen < 120 || meta.descriptionLen > 160) {
    score += 5;
    issues.push({ level: 'warn', text: `<strong>Description</strong> is ${meta.descriptionLen} chars. Aim for 120–160.` });
  } else {
    score += 8;
    issues.push({ level: 'pass', text: `<strong>Description</strong> is ${meta.descriptionLen} chars — good length.` });
  }

  // Canonical (5 pts)
  if (!meta.canonical) {
    score += 2;
    issues.push({ level: 'warn', text: '<strong>No canonical URL</strong> — recommended to prevent duplicate content.' });
  } else {
    score += 5;
    issues.push({ level: 'pass', text: '<strong>Canonical URL</strong> present.' });
  }

  // Robots (4 pts)
  if (meta.robots && /noindex/i.test(meta.robots)) {
    issues.push({ level: 'fail', text: `<strong>robots: ${esc(meta.robots)}</strong> — this page is excluded from search index.` });
  } else {
    score += 4;
    issues.push({ level: 'pass', text: `<strong>Robots</strong>: ${meta.robots ? esc(meta.robots) : 'index, follow (default)'}` });
  }

  return { score, maxScore: 25, issues };
}

function scoreStructuredData(items) {
  let score = 0;
  const issues = [];

  const jsonItems = items.filter((i) => i.kind === 'json-ld');
  const microItems = items.filter((i) => i.kind === 'microdata');

  if (items.length === 0) {
    issues.push({ level: 'fail', text: '<strong>No structured data</strong> — add JSON-LD Schema.org markup for rich results.' });
    return { score: 0, maxScore: 25, issues };
  }

  score += 15;
  issues.push({ level: 'pass', text: `<strong>${items.length} structured data item${items.length > 1 ? 's' : ''}</strong> found (${jsonItems.length} JSON-LD, ${microItems.length} Microdata).` });

  const invalid = jsonItems.filter((i) => !i.valid);
  if (invalid.length) {
    issues.push({ level: 'fail', text: `<strong>${invalid.length} JSON-LD block${invalid.length > 1 ? 's' : ''} failed to parse</strong> — fix JSON syntax errors.` });
  } else if (jsonItems.length) {
    score += 5;
    issues.push({ level: 'pass', text: 'All JSON-LD blocks are valid JSON.' });
  }

  const withType = jsonItems.filter((i) => i.valid && i.data && (i.data['@type'] || (Array.isArray(i.data) && i.data[0]?.['@type'])));
  if (jsonItems.length && withType.length === jsonItems.length) {
    score += 5;
    issues.push({ level: 'pass', text: 'All JSON-LD items declare a <strong>@type</strong>.' });
  } else if (jsonItems.length) {
    score += 2;
    issues.push({ level: 'warn', text: 'Some JSON-LD items are missing a <strong>@type</strong>.' });
  }

  return { score, maxScore: 25, issues };
}

function scoreWebVitals(v) {
  let score = 0;
  const issues = [];

  // LCP (8 pts)
  if (v.lcp !== undefined) {
    const s = v.lcp <= 2500 ? 'pass' : v.lcp <= 4000 ? 'warn' : 'fail';
    score += s === 'pass' ? 8 : s === 'warn' ? 5 : 1;
    issues.push({ level: s, text: `<strong>LCP</strong> ${(v.lcp / 1000).toFixed(2)}s — ${s === 'pass' ? 'good' : s === 'warn' ? 'needs improvement' : 'poor'}. Target ≤ 2.5s.` });
  } else {
    issues.push({ level: 'info', text: '<strong>LCP</strong> — not available (page may not have loaded fully).' });
  }

  // FCP (5 pts)
  if (v.fcp !== undefined) {
    const s = v.fcp <= 1800 ? 'pass' : v.fcp <= 3000 ? 'warn' : 'fail';
    score += s === 'pass' ? 5 : s === 'warn' ? 3 : 1;
    issues.push({ level: s, text: `<strong>FCP</strong> ${(v.fcp / 1000).toFixed(2)}s — ${s === 'pass' ? 'good' : s === 'warn' ? 'needs improvement' : 'poor'}. Target ≤ 1.8s.` });
  }

  // CLS (7 pts)
  if (v.cls !== undefined) {
    const s = v.cls <= 0.1 ? 'pass' : v.cls <= 0.25 ? 'warn' : 'fail';
    score += s === 'pass' ? 7 : s === 'warn' ? 4 : 1;
    issues.push({ level: s, text: `<strong>CLS</strong> ${v.cls.toFixed(3)} — ${s === 'pass' ? 'good' : s === 'warn' ? 'needs improvement' : 'poor'}. Target ≤ 0.1.` });
  }

  // TTFB (5 pts)
  if (v.ttfb !== undefined) {
    const s = v.ttfb <= 800 ? 'pass' : v.ttfb <= 1800 ? 'warn' : 'fail';
    score += s === 'pass' ? 5 : s === 'warn' ? 3 : 1;
    issues.push({ level: s, text: `<strong>TTFB</strong> ${v.ttfb}ms — ${s === 'pass' ? 'good' : s === 'warn' ? 'needs improvement' : 'poor'}. Target ≤ 800ms.` });
  }

  return { score, maxScore: 25, issues };
}

function scoreJSVisibility(jsSignals, rawComp) {
  let score = 0;
  const issues = [];

  if (!rawComp || rawComp.fetchFailed) {
    score = 12;
    issues.push({ level: 'warn', text: rawComp?.error
      ? `<strong>Could not fetch raw HTML</strong>: ${esc(rawComp.error)} — JS visibility check skipped.`
      : '<strong>Raw HTML fetch failed</strong> — JS visibility check skipped.' });
  } else {
    const delta = rawComp.textDelta;
    if (delta <= 0.2) {
      score += 20;
      issues.push({ level: 'pass', text: `<strong>Good crawlability</strong> — rendered page has only ${Math.round(delta * 100)}% more text than raw HTML.` });
    } else if (delta <= 0.5) {
      score += 12;
      issues.push({ level: 'warn', text: `<strong>Moderate JS dependency</strong> — rendered page has ${Math.round(delta * 100)}% more text than raw HTML. Some content may not be indexed.` });
    } else {
      score += 3;
      issues.push({ level: 'fail', text: `<strong>High JS dependency</strong> — rendered page has ${Math.round(delta * 100)}% more text than raw HTML. Significant content may be invisible to crawlers.` });
    }

    // Title / description match
    if (rawComp.rawTitle && rawComp.rawTitle !== jsSignals.title) {
      issues.push({ level: 'warn', text: '<strong>Title differs</strong> between raw and rendered HTML — the indexed title may differ from what users see.' });
    }
  }

  // Framework signals
  if (jsSignals.frameworks.length > 0) {
    const hasSsrFramework = jsSignals.frameworks.some((f) => ['Next.js', 'Nuxt.js', 'Gatsby'].includes(f));
    if (hasSsrFramework) {
      score += 5;
      issues.push({ level: 'pass', text: `<strong>${jsSignals.frameworks.join(', ')}</strong> detected — SSR/SSG framework typically good for crawlability.` });
    } else {
      issues.push({ level: 'warn', text: `<strong>${jsSignals.frameworks.join(', ')}</strong> detected — ensure server-side rendering is enabled for SEO.` });
    }
  }

  return { score, maxScore: 25, issues };
}

// ── Analysis pipeline ─────────────────────────────────────────────────────────
async function runAnalysis() {
  if (!currentTabId) return;

  setLoadingState(true, 'Inspecting page…');

  try {
    // 1. Execute content script in the active tab
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: inspectPage,
    });

    if (!result || result.error) {
      throw new Error(result?.error?.message || 'Content script execution failed.');
    }

    const pageData = result.result;
    setLoadingState(true, 'Fetching raw HTML…');

    // 2. Fetch raw HTML for JS visibility comparison
    const rawComp = await fetchRawComparison(pageData.url, pageData.jsSignals);

    analysisData = { pageData, rawComp, timestamp: Date.now() };

    setLoadingState(false);
    renderAll(analysisData);
    saveResultsToMocho(pageData.url, analysisData); // non-blocking

  } catch (err) {
    setLoadingState(false);
    showError(err.message);
  }
}

function setLoadingState(loading, msg = 'Analyzing…') {
  $('overview-idle').style.display = loading ? 'none' : '';
  $('overview-loading').style.display = loading ? 'block' : 'none';
  $('overview-results').style.display = loading ? 'none' : '';
  if (msg) $('loadingMsg').textContent = msg;
}

function showError(msg) {
  $('overview-idle').style.display = 'block';
  $('overview-idle').innerHTML = `
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--error)">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <div class="empty-state-title">Analysis failed</div>
    <div class="empty-state-sub">${esc(msg)}</div>
    <button class="analyze-btn" id="analyzeBtn" style="margin-top:8px">Try Again</button>`;
  $('analyzeBtn').addEventListener('click', runAnalysis);
}

// ── Render all tabs ───────────────────────────────────────────────────────────
function renderAll(data) {
  const { pageData, rawComp } = data;
  const { meta, structuredData, webVitals, jsSignals } = pageData;

  const metaScore = scoreMeta(meta);
  const schemaScore = scoreStructuredData(structuredData);
  const vitalsScore = scoreWebVitals(webVitals);
  const jsScore = scoreJSVisibility(jsSignals, rawComp);

  const total = metaScore.score + schemaScore.score + vitalsScore.score + jsScore.score;
  const maxTotal = 100;

  renderOverview(total, maxTotal, { metaScore, schemaScore, vitalsScore, jsScore }, pageData);
  renderMeta(meta);
  renderSchema(structuredData);
  renderVitals(webVitals);
  renderJS(jsSignals, rawComp, jsScore);

  // Update tab badges
  updateTabBadge('meta', metaScore);
  updateTabBadge('schema', schemaScore);
  updateTabBadge('vitals', vitalsScore);
  updateTabBadge('js', jsScore);
}

function updateTabBadge(tabName, scoreObj) {
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!tab) return;
  const pct = Math.round((scoreObj.score / scoreObj.maxScore) * 100);
  const cls = pct >= 85 ? 'pass' : pct >= 60 ? 'warn' : 'fail';
  const existing = tab.querySelector('.tab-badge');
  if (existing) existing.remove();
  const badge = document.createElement('span');
  badge.className = `tab-badge ${cls}`;
  badge.textContent = pct;
  tab.appendChild(badge);
}

// ── Overview ──────────────────────────────────────────────────────────────────
function renderOverview(total, max, scores, pageData) {
  const pct = Math.round((total / max) * 100);
  const cls = pct >= 85 ? 'great' : pct >= 70 ? 'good' : pct >= 50 ? 'ok' : 'poor';
  const verdict = { great: 'Excellent', good: 'Good', ok: 'Needs Work', poor: 'Poor' }[cls];

  const circumference = 2 * Math.PI * 30;
  const dash = (pct / 100) * circumference;

  const ringColor = { great: '#059669', good: '#0d9488', ok: '#d97706', poor: '#dc2626' }[cls];

  // Collect critical/warning issues across all categories
  const allIssues = [
    ...scores.metaScore.issues,
    ...scores.schemaScore.issues,
    ...scores.vitalsScore.issues,
    ...scores.jsScore.issues,
  ].filter((i) => i.level === 'fail' || i.level === 'warn').slice(0, 6);

  const html = `
    <div class="score-card">
      <div class="score-ring">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r="30" fill="none" stroke="#e2e8f0" stroke-width="6"/>
          <circle cx="36" cy="36" r="30" fill="none" stroke="${ringColor}" stroke-width="6"
            stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"
            stroke-linecap="round"
            transform="rotate(-90 36 36)"/>
          <text x="36" y="41" text-anchor="middle" font-size="16" font-weight="800" fill="${ringColor}" font-family="system-ui">${pct}</text>
        </svg>
      </div>
      <div class="score-info">
        <div class="score-label">SEO Score</div>
        <div class="score-value ${cls}">${pct}<span style="font-size:14px;font-weight:500">/100</span></div>
        <div class="score-verdict ${cls}">${verdict}</div>
      </div>
    </div>

    <div class="summary-grid">
      ${summaryCard('Meta Tags', '🏷', scores.metaScore, 'meta')}
      ${summaryCard('Structured Data', '🧩', scores.schemaScore, 'schema')}
      ${summaryCard('Core Web Vitals', '⚡', scores.vitalsScore, 'vitals')}
      ${summaryCard('JS Visibility', '👁', scores.jsScore, 'js')}
    </div>

    ${allIssues.length ? `
      <div class="issues-section">
        <div class="issues-title">Top issues</div>
        ${allIssues.map(issueHTML).join('')}
      </div>` : '<div class="note">No critical or warning issues found — great work!</div>'}

    <button class="analyze-btn" id="reAnalyzeBtn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
      </svg>
      Re-analyze
    </button>`;

  $('overview-results').innerHTML = html;
  $('overview-results').style.display = 'block';
  $('overview-idle').style.display = 'none';

  $('reAnalyzeBtn').addEventListener('click', runAnalysis);

  // Summary card click → switch tab
  document.querySelectorAll('.summary-card[data-target]').forEach((card) => {
    card.addEventListener('click', () => {
      const tab = document.querySelector(`.tab[data-tab="${card.dataset.target}"]`);
      if (tab) tab.click();
    });
  });
}

function summaryCard(name, icon, scoreObj, target) {
  const pct = Math.round((scoreObj.score / scoreObj.maxScore) * 100);
  const cls = pct >= 85 ? 'great' : pct >= 70 ? 'good' : pct >= 50 ? 'ok' : 'poor';
  return `
    <div class="summary-card" data-target="${target}">
      <div class="summary-icon">${icon}</div>
      <div class="summary-name">${esc(name)}</div>
      <div class="summary-score ${cls}">${pct}</div>
    </div>`;
}

function issueHTML(issue) {
  return `<div class="issue-item ${issue.level}"><div class="issue-dot"></div><div class="issue-text">${issue.text}</div></div>`;
}

// ── Meta Tags ─────────────────────────────────────────────────────────────────
function renderMeta(meta) {
  $('meta-empty').style.display = 'none';

  const titleStatus = !meta.title ? 'fail' : (meta.titleLen >= 30 && meta.titleLen <= 60) ? 'pass' : 'warn';
  const descStatus = !meta.description ? 'fail' : (meta.descriptionLen >= 120 && meta.descriptionLen <= 160) ? 'pass' : 'warn';
  const canonStatus = meta.canonical ? 'pass' : 'warn';
  const robotsFail = meta.robots && /noindex/i.test(meta.robots);

  const ogKeys = Object.keys(meta.og);
  const twitterKeys = Object.keys(meta.twitter);
  const ogStatus = (meta.og.title && meta.og.description && meta.og.image) ? 'pass' : ogKeys.length ? 'warn' : 'fail';
  const twitterStatus = meta.twitter.card ? 'pass' : twitterKeys.length ? 'warn' : 'fail';

  function titleBar(len, min, max) {
    const pct = clamp(Math.round((len / max) * 100), 0, 100);
    const s = len >= min && len <= max ? 'pass' : 'warn';
    return `<div class="char-bar"><div class="char-bar-fill ${s}" style="width:${pct}%"></div></div>`;
  }

  const html = `
    <div class="section-card">
      <div class="section-header">
        <span class="section-title">Basic SEO Tags</span>
      </div>
      <div class="section-body">
        <div class="meta-row">
          <div class="meta-key">Title</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:flex-start;gap:8px">
              <div class="meta-val">${meta.title ? esc(meta.title) : '<span class="missing">Not set</span>'}</div>
              <span class="meta-badge ${titleStatus}">${titleStatus.toUpperCase()}</span>
            </div>
            ${meta.title ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${meta.titleLen} chars · ideal 30–60</div>${titleBar(meta.titleLen, 30, 60)}` : ''}
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-key">Description</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:flex-start;gap:8px">
              <div class="meta-val">${meta.description ? esc(meta.description) : '<span class="missing">Not set</span>'}</div>
              <span class="meta-badge ${descStatus}">${descStatus.toUpperCase()}</span>
            </div>
            ${meta.description ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${meta.descriptionLen} chars · ideal 120–160</div>${titleBar(meta.descriptionLen, 120, 160)}` : ''}
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-key">Canonical</div>
          <div style="flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px">
            <div class="meta-val mono">${meta.canonical ? esc(meta.canonical) : '<span class="missing">Not set</span>'}</div>
            <span class="meta-badge ${canonStatus}">${canonStatus.toUpperCase()}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-key">Robots</div>
          <div style="flex:1;min-width:0;display:flex;align-items:flex-start;gap:8px">
            <div class="meta-val mono">${meta.robots ? esc(meta.robots) : 'index, follow (default)'}</div>
            <span class="meta-badge ${robotsFail ? 'fail' : 'pass'}">${robotsFail ? 'NOINDEX' : 'PASS'}</span>
          </div>
        </div>

        <div class="meta-row">
          <div class="meta-key">Viewport</div>
          <div class="meta-val mono">${meta.viewport ? esc(meta.viewport) : '<span class="missing">Not set</span>'}</div>
        </div>
      </div>
    </div>

    <div class="section-card">
      <div class="section-header">
        <span class="section-title">Open Graph</span>
        <span class="meta-badge ${ogStatus}">${ogStatus.toUpperCase()}</span>
      </div>
      <div class="section-body">
        ${ogKeys.length === 0
          ? '<div class="meta-val missing">No Open Graph tags found. Add og:title, og:description, og:image.</div>'
          : ['title', 'description', 'image', 'url', 'type', 'site_name']
              .concat(ogKeys.filter((k) => !['title','description','image','url','type','site_name'].includes(k)))
              .filter((k) => meta.og[k] !== undefined)
              .map((k) => `
                <div class="meta-row">
                  <div class="meta-key">og:${esc(k)}</div>
                  <div class="meta-val">${esc(meta.og[k])}</div>
                </div>`).join('')}
      </div>
    </div>

    <div class="section-card">
      <div class="section-header">
        <span class="section-title">Twitter / X Card</span>
        <span class="meta-badge ${twitterStatus}">${twitterStatus.toUpperCase()}</span>
      </div>
      <div class="section-body">
        ${twitterKeys.length === 0
          ? '<div class="meta-val missing">No Twitter Card tags found. Add twitter:card at minimum.</div>'
          : ['card', 'title', 'description', 'image', 'site', 'creator']
              .concat(twitterKeys.filter((k) => !['card','title','description','image','site','creator'].includes(k)))
              .filter((k) => meta.twitter[k] !== undefined)
              .map((k) => `
                <div class="meta-row">
                  <div class="meta-key">twitter:${esc(k)}</div>
                  <div class="meta-val">${esc(meta.twitter[k])}</div>
                </div>`).join('')}
      </div>
    </div>`;

  $('meta-results').innerHTML = html;
  $('meta-results').style.display = 'block';
}

// ── Structured Data ───────────────────────────────────────────────────────────
function renderSchema(items) {
  $('schema-empty').style.display = 'none';

  if (items.length === 0) {
    $('schema-results').innerHTML = `
      <div class="issue-item fail">
        <div class="issue-dot"></div>
        <div class="issue-text"><strong>No structured data found.</strong> Add JSON-LD Schema.org markup to enable rich results in Google Search.</div>
      </div>
      <div class="note" style="margin-top:8px">
        Common schemas: Article, Product, BreadcrumbList, FAQPage, Organization, LocalBusiness.
        Use <a href="https://schema.org" target="_blank" rel="noopener">schema.org</a> as reference.
      </div>`;
    $('schema-results').style.display = 'block';
    return;
  }

  function getType(item) {
    if (item.kind === 'microdata') return item.itemtype.split('/').pop() || item.itemtype;
    if (!item.valid) return '(invalid JSON)';
    const d = item.data;
    if (Array.isArray(d)) return d[0]?.['@type'] || '@graph';
    return d['@type'] || '(no @type)';
  }

  function renderItemData(item) {
    if (!item.valid) {
      return `<div class="schema-error">⚠ Invalid JSON: ${esc(item.error)}</div>`;
    }
    const d = item.kind === 'microdata' ? item.props : item.data;
    const excluded = new Set(['@context', '@type']);
    const entries = Object.entries(d)
      .filter(([k]) => !excluded.has(k))
      .slice(0, 12);
    if (!entries.length) return '<div class="schema-error" style="color:var(--text-muted)">No properties.</div>';
    return `<div class="schema-props">${entries.map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
      return `<div class="schema-prop"><div class="schema-prop-key">${esc(k)}</div><div class="schema-prop-val">${esc(val)}</div></div>`;
    }).join('')}</div>`;
  }

  const html = items.map((item) => `
    <div class="schema-item">
      <div class="schema-item-header">
        <span class="schema-type">${esc(getType(item))}</span>
        <span class="schema-kind">${item.kind === 'json-ld' ? 'JSON-LD' : 'Microdata'}</span>
      </div>
      ${renderItemData(item)}
    </div>`).join('');

  $('schema-results').innerHTML = html;
  $('schema-results').style.display = 'block';
}

// ── Web Vitals ────────────────────────────────────────────────────────────────
function renderVitals(v) {
  $('vitals-empty').style.display = 'none';

  function vitalCard(name, value, unit, thresholds, description) {
    let cls = 'na', display = 'N/A', barPct = 0;
    if (value !== undefined) {
      cls = value <= thresholds[0] ? 'pass' : value <= thresholds[1] ? 'warn' : 'fail';
      display = unit === 's' ? (value / 1000).toFixed(2) : value.toString();
      barPct = clamp(Math.round((value / (thresholds[1] * 1.5)) * 100), 5, 100);
    }
    return `
      <div class="vital-card">
        <div class="vital-name">${esc(name)}</div>
        <div class="vital-value ${cls}">${esc(display)}</div>
        <div class="vital-unit">${cls === 'na' ? 'not available' : unit === 's' ? 'seconds' : 'milliseconds'}</div>
        <div class="vital-bar">
          <div class="vital-bar-fill ${cls}" style="width:${barPct}%"></div>
        </div>
        <div class="vital-threshold">${esc(description)}</div>
      </div>`;
  }

  const html = `
    <div class="note">
      Vitals are read from the browser's Performance API after page load.
      LCP and CLS may not be available if the page is a cached navigation.
    </div>
    <div class="vitals-grid">
      ${vitalCard('LCP', v.lcp, 's', [2500, 4000], 'Good ≤ 2.5s')}
      ${vitalCard('FCP', v.fcp, 's', [1800, 3000], 'Good ≤ 1.8s')}
      ${vitalCard('CLS', v.cls !== undefined ? v.cls * 1000 : undefined, 'cls', [100, 250], 'Good ≤ 0.1')}
      ${vitalCard('TTFB', v.ttfb, 'ms', [800, 1800], 'Good ≤ 800ms')}
      ${vitalCard('FID', v.fid, 'ms', [100, 300], 'Good ≤ 100ms')}
      ${vitalCard('INP', v.inp, 'ms', [200, 500], 'Good ≤ 200ms')}
    </div>
    ${v.lcpElement ? `<div class="note" style="margin-top:8px">LCP element: <code>${esc(v.lcpElement)}</code></div>` : ''}`;

  $('vitals-results').innerHTML = html;
  $('vitals-results').style.display = 'block';
}

// ── JS Visibility ─────────────────────────────────────────────────────────────
function renderJS(jsSignals, rawComp, jsScore) {
  $('js-empty').style.display = 'none';

  const delta = rawComp && !rawComp.fetchFailed ? rawComp.textDelta : null;
  const deltaPct = delta !== null ? Math.round(delta * 100) : null;
  const scoreStatus = deltaPct === null ? 'warn'
    : deltaPct <= 20 ? 'pass'
    : deltaPct <= 50 ? 'warn'
    : 'fail';

  const verdictText = scoreStatus === 'pass'
    ? 'Good crawlability — most content is server-rendered.'
    : scoreStatus === 'warn'
    ? 'Moderate JS dependency — some content may not be indexed.'
    : 'High JS dependency — significant content may be invisible to crawlers.';

  const crawlabilityScore = Math.round((jsScore.score / jsScore.maxScore) * 100);

  let compTable = '';
  if (rawComp && !rawComp.fetchFailed) {
    compTable = `
      <div class="section-title-sm">Raw HTML vs Rendered DOM</div>
      <div class="section-card">
        <div class="section-body" style="padding:0">
          <table class="compare-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Raw HTML</th>
                <th>Rendered</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              ${compareRow('Text chars', rawComp.rawText, rawComp.liveText)}
              ${compareRow('Links', rawComp.rawLinks, rawComp.liveLinks)}
              ${compareRow('Headings', rawComp.rawHeadings, rawComp.liveHeadings)}
              ${compareRow('Images', rawComp.rawImages, rawComp.liveImages)}
            </tbody>
          </table>
        </div>
      </div>`;
  } else if (rawComp && rawComp.fetchFailed) {
    compTable = `<div class="note">Raw HTML comparison unavailable${rawComp.error ? ': ' + esc(rawComp.error) : ''}.</div>`;
  }

  const frameworkHtml = jsSignals.frameworks.length
    ? `<div class="framework-tags">${jsSignals.frameworks.map((f) => `<span class="framework-tag">${esc(f)}</span>`).join('')}</div>`
    : '<div style="color:var(--text-muted);font-size:12px">No major JS frameworks detected.</div>';

  const html = `
    <div class="section-card" style="margin-bottom:8px">
      <div class="section-body">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <div style="font-size:12px;font-weight:600">${esc(verdictText)}</div>
          <div style="font-size:18px;font-weight:800;color:var(--${scoreStatus === 'pass' ? 'success' : scoreStatus === 'warn' ? 'warning' : 'error'})">${crawlabilityScore}</div>
        </div>
        <div class="js-score-bar">
          <div class="js-score-fill ${scoreStatus}" style="width:${crawlabilityScore}%"></div>
        </div>
        ${deltaPct !== null ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Rendered page has ${deltaPct}% more text than raw HTML</div>` : ''}
      </div>
    </div>

    <div class="section-title-sm">Detected Frameworks</div>
    <div class="section-card" style="margin-bottom:8px">
      <div class="section-body">${frameworkHtml}</div>
    </div>

    ${compTable}

    <div class="section-title-sm">Page Signals</div>
    <div class="section-card">
      <div class="section-body">
        ${sigRow('DOM elements', jsSignals.totalElements)}
        ${sigRow('External scripts', jsSignals.externalScripts)}
        ${sigRow('Inline scripts', jsSignals.inlineScripts)}
        ${sigRow('Lazy-loaded images', jsSignals.lazyImages)}
        ${sigRow('Noscript blocks', jsSignals.noscriptCount)}
        ${sigRow('Empty app roots', jsSignals.emptyRoots, jsSignals.emptyRoots > 0 ? 'warn' : 'pass')}
        ${sigRow('Server-rendered marker', jsSignals.hasSSRMarker ? 'Yes' : 'No', jsSignals.hasSSRMarker ? 'pass' : 'warn')}
      </div>
    </div>

    ${jsScore.issues.map(issueHTML).join('')}`;

  $('js-results').innerHTML = html;
  $('js-results').style.display = 'block';
}

function compareRow(label, raw, live) {
  const diff = live - raw;
  const pct = raw > 0 ? Math.round((diff / raw) * 100) : 0;
  const cls = diff === 0 ? 'same' : diff > 0 ? 'up' : '';
  const deltaStr = diff === 0 ? '—' : `+${pct}%`;
  return `
    <tr>
      <td class="metric">${esc(label)}</td>
      <td class="raw-val">${esc(String(raw ?? '—'))}</td>
      <td class="live-val">${esc(String(live ?? '—'))}</td>
      <td class="delta ${cls}">${deltaStr}</td>
    </tr>`;
}

function sigRow(label, value, status) {
  const s = status || 'pass';
  const dot = s !== 'pass' ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--${s === 'warn' ? 'warning' : 'error'});margin-right:4px;vertical-align:middle"></span>` : '';
  return `
    <div class="meta-row">
      <div class="meta-key">${esc(label)}</div>
      <div class="meta-val">${dot}${esc(String(value))}</div>
    </div>`;
}

// ── Tab / URL tracking ────────────────────────────────────────────────────────
async function updateFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const newUrl = tab.url || '';
    const isExtensionPage = newUrl.startsWith('chrome://') || newUrl.startsWith('chrome-extension://') || newUrl.startsWith('about:');

    if (isExtensionPage) {
      $('urlText').textContent = 'Extension / system page';
      $('urlText').className = 'url-text placeholder';
      currentTabId = null;
      currentUrl = null;
      $('connection-section').innerHTML = '';
      connectionState = null;
      return;
    }

    currentTabId = tab.id;

    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      $('urlText').textContent = newUrl;
      $('urlText').className = 'url-text';
      clearResults();
      connectionState = null;
      $('connection-section').innerHTML = '';
    }

    checkCurrentTab(newUrl);
  } catch (_) {}
}

function clearResults() {
  analysisData = null;
  $('overview-idle').style.display = '';
  $('overview-results').style.display = 'none';
  $('overview-loading').style.display = 'none';

  $('overview-idle').innerHTML = `
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="11" y1="8" x2="11" y2="14"/>
      <line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
    <div class="empty-state-title">Analyze the current page</div>
    <div class="empty-state-sub">Click the button below to audit meta tags, structured data, Core Web Vitals, and JavaScript rendering.</div>
    <button class="analyze-btn" id="analyzeBtn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Analyze Page
    </button>`;
  $('analyzeBtn').addEventListener('click', runAnalysis);

  ['meta', 'schema', 'vitals', 'js'].forEach((t) => {
    $(`${t}-empty`).style.display = '';
    $(`${t}-results`).style.display = 'none';
  });

  document.querySelectorAll('.tab-badge').forEach((b) => b.remove());
}

// ── MOCHO connection ──────────────────────────────────────────────────────────
async function checkCurrentTab(url) {
  let domain;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch { return; }

  // Skip if we already have a fresh result for this domain
  if (connectionState && connectionState.domain === domain &&
      connectionState.status !== 'loading') return;

  connectionState = { status: 'loading', domain };
  renderConnectionSection();

  const matchResult = await matchDomain(domain);

  if (!matchResult.ok) {
    const isNoKey = matchResult.error.includes('No API key');
    connectionState = { status: isNoKey ? 'no-key' : 'error', domain, error: matchResult.error };
    renderConnectionSection();
    updateStatusBar();
    return;
  }

  if (!matchResult.data.matched) {
    connectionState = { status: 'unconnected', domain, cta: matchResult.data.cta };
    renderConnectionSection();
    updateStatusBar();
    return;
  }

  const site = matchResult.data.site;
  connectionState = { status: 'connected', domain, site };
  renderConnectionSection();
  updateStatusBar();

  const statsResult = await getCrawlerStats(site.id);
  if (statsResult.ok) {
    connectionState.stats = statsResult.data;
    renderConnectionSection();
  }
}

function signupCTA() {
  return `
    <div class="conn-signup-cta">
      <p class="cta-title">New to MOCHO?</p>
      <p class="cta-body">Free plan available. See your AI Crawl Score in 60 seconds.</p>
      <a href="https://getmocho.com/signup" target="_blank" rel="noopener noreferrer" class="cta-btn">
        Sign up free →
      </a>
    </div>`;
}

function renderConnectionSection() {
  const el = $('connection-section');
  if (!el || !connectionState) return;

  const { status, domain, site, stats, error } = connectionState;

  if (status === 'loading') {
    el.innerHTML = `
      <div class="conn-card">
        <div class="conn-loading-row">
          <div class="mini-spinner"></div>
          <span>Checking MOCHO connection…</span>
        </div>
      </div>`;
    return;
  }

  if (status === 'no-key') {
    el.innerHTML = `
      <div class="conn-card">
        <div class="conn-card-header">
          <span class="conn-badge no-key">Connect to MOCHO</span>
        </div>
        <p class="conn-body">Add your MOCHO API key in the extension settings to sync this tab with your account.</p>
        <button class="conn-btn secondary" id="connOpenSettings">Open Settings →</button>
        ${signupCTA()}
      </div>`;
    el.querySelector('#connOpenSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    return;
  }

  if (status === 'unconnected') {
    el.innerHTML = `
      <div class="conn-card">
        <div class="conn-card-header">
          <span class="conn-badge unconnected">Not connected to MOCHO</span>
          <span class="conn-domain">${esc(domain)}</span>
        </div>
        <p class="conn-body">
          This domain isn't in your MOCHO account. Connect it to enable pre-rendering,
          automatic SEO fixes, and crawler intelligence.
        </p>
        <a href="https://getmocho.com/dashboard" target="_blank" rel="noopener noreferrer"
           class="conn-btn primary">Connect Domain in MOCHO →</a>
        ${signupCTA()}
      </div>`;
    return;
  }

  if (status === 'error') {
    el.innerHTML = `
      <div class="conn-card">
        <div class="conn-card-header">
          <span class="conn-badge error">MOCHO connection failed</span>
        </div>
        <p class="conn-body">${esc(error || 'Unknown error')}</p>
        <button class="conn-btn secondary" id="connCheckKey">Check API Key →</button>
      </div>`;
    el.querySelector('#connCheckKey').addEventListener('click', () => chrome.runtime.openOptionsPage());
    return;
  }

  if (status === 'connected') {
    let crawlerHtml = `
      <div class="conn-loading-row" style="margin-top:8px">
        <div class="mini-spinner"></div>
        <span>Loading crawler intelligence…</span>
      </div>`;

    if (stats) {
      const sc = stats.crawlReadinessScore;
      const scCls = sc >= 80 ? 'great' : sc >= 60 ? 'good' : sc >= 40 ? 'ok' : 'poor';
      const topBots = (stats.byBot || []).slice(0, 3);

      crawlerHtml = `
        <div class="crawler-intel">
          <div class="crawler-score-row">
            <div class="crawler-score-num ${scCls}">${sc}</div>
            <div>
              <div class="crawler-score-label">AI Crawl Score</div>
              <div class="crawler-score-verdict ${scCls}">${esc(stats.scoreLabel || '')}</div>
            </div>
          </div>
          <div class="crawler-stats-grid">
            <div class="crawler-stat">
              <div class="crawler-stat-val">${stats.totalHits ?? '—'}</div>
              <div class="crawler-stat-lbl">Bot Hits</div>
            </div>
            <div class="crawler-stat">
              <div class="crawler-stat-val">${stats.aiCrawlerHits ?? '—'}</div>
              <div class="crawler-stat-lbl">AI Crawlers</div>
            </div>
            <div class="crawler-stat">
              <div class="crawler-stat-val">${stats.cacheHitRate != null ? stats.cacheHitRate.toFixed(1) + '%' : '—'}</div>
              <div class="crawler-stat-lbl">Cache Hit</div>
            </div>
          </div>
          ${topBots.length ? `
            <div class="crawler-bots">
              <div class="section-title-sm">Top bots (30 days)</div>
              ${topBots.map((b) => `
                <div class="bot-row">
                  <span><span class="bot-name">${esc(b.botName)}</span><span class="bot-cat">${esc(b.category)}</span></span>
                  <span class="bot-count">${b.count.toLocaleString()}</span>
                </div>`).join('')}
            </div>` : ''}
          <a href="https://getmocho.com/dashboard" target="_blank" rel="noopener noreferrer"
             class="conn-btn primary full-width">View Full Dashboard →</a>
        </div>`;
    }

    el.innerHTML = `
      <div class="conn-card">
        <div class="conn-card-header">
          <span class="conn-badge connected">Connected to MOCHO ✓</span>
          <span class="conn-domain">${esc(site.name || domain)}</span>
        </div>
        ${crawlerHtml}
      </div>`;
  }
}

// ── Save results to MOCHO (fire-and-forget) ───────────────────────────────────
function saveResultsToMocho(url, data) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  const { pageData, rawComp } = data;
  const { meta, structuredData, webVitals, jsSignals } = pageData;

  const metaScore  = scoreMeta(meta);
  const schemaScore = scoreStructuredData(structuredData);
  const vitalsScore = scoreWebVitals(webVitals);
  const jsScore    = scoreJSVisibility(jsSignals, rawComp);
  const total      = metaScore.score + schemaScore.score + vitalsScore.score + jsScore.score;

  const issues = [
    ...metaScore.issues.map((i) => ({ ...i, type: 'meta' })),
    ...schemaScore.issues.map((i) => ({ ...i, type: 'schema' })),
    ...vitalsScore.issues.map((i) => ({ ...i, type: 'vitals' })),
    ...jsScore.issues.map((i) => ({ ...i, type: 'js-visibility' })),
  ]
    .filter((i) => i.level === 'fail' || i.level === 'warn')
    .map((i) => ({
      type: i.type,
      severity: i.level === 'fail' ? 'critical' : 'warning',
      message: i.text.replace(/<[^>]+>/g, ''),
    }));

  postScanResult({
    siteId: connectionState?.status === 'connected' ? connectionState.site.id : undefined,
    url,
    scanData: {
      crawlabilityScore: total,
      issues,
      metaTags: {
        title: meta.title || '',
        description: meta.description || '',
        canonical: meta.canonical || '',
        robots: meta.robots || '',
      },
      robotsBlocked: !!(meta.robots && /noindex/i.test(meta.robots)),
      jsDependent: jsScore.score / jsScore.maxScore < 0.5,
      renderGap: !!(rawComp && !rawComp.fetchFailed && rawComp.textDelta > 0.5),
      aiCrawlScore: connectionState?.stats?.crawlReadinessScore,
      scannedAt: new Date().toISOString(),
    },
  }).catch(() => {});
}

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar() {
  const dot  = $('apiDot');
  const text = $('apiStatusText');
  const st   = connectionState?.status;

  if (st === 'connected') {
    dot.className = 'status-dot connected';
    text.textContent = `MOCHO: ${connectionState.site?.name || connectionState.domain}`;
  } else if (st === 'unconnected') {
    dot.className = 'status-dot disconnected';
    text.textContent = `${connectionState.domain} — not in MOCHO`;
  } else if (st === 'error') {
    dot.className = 'status-dot error';
    text.textContent = 'MOCHO connection failed';
  } else {
    dot.className = 'status-dot disconnected';
    text.innerHTML = 'Not connected · <a href="#" id="connectLink">Add API key</a>';
    const link = $('connectLink');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
$('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('analyzeBtn').addEventListener('click', runAnalysis);
$('refreshBtn').addEventListener('click', () => {
  if (analysisData) runAnalysis();
});

chrome.tabs.onActivated.addListener(() => updateFromActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTabId && info.status === 'complete') updateFromActiveTab();
});
// Re-check connection when API key is saved in options
chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey) {
    connectionState = null;
    if (currentUrl) checkCurrentTab(currentUrl);
  }
});

updateFromActiveTab();
