import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import got from 'got';
import crypto from 'crypto';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';

await Actor.init();

// ============================================================
// Config
// ============================================================
const DEFAULT_TIMEOUT    = 5000;
const DEFAULT_MAX_PATHS  = 100;
const DEFAULT_CONCURRENCY = 8;

const BUILT_IN_DICTIONARY = [
  '/x402/', '/x402/sapi', '/x402/spdet', '/x402/scdft',
  '/x402/v1/', '/x402/payment', '/x402/checkout', '/x402/status',
  '/x402/health', '/x402/invoice', '/x402/balance', '/x402/webhook',
  '/x402/callback', '/x402/token', '/x402/auth', '/x402/order',
  '/x402/subscription', '/x402/usage', '/x402/rate', '/x402/quote',
  '/api/x402/', '/api/x402/payment', '/api/x402/status', '/api/x402/webhook',
  '/v1/x402', '/v1/x402/payment', '/v2/x402', '/.well-known/x402',
];

// ============================================================
// Helpers
// ============================================================
function sha256(raw) { return crypto.createHash('sha256').update(String(raw || '')).digest('hex'); }

function normalizePath(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p) return '';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try { const url = new URL(p); p = `${url.pathname}${url.search || ''}`; } catch { /* ignore */ }
  }
  p = p.replace(/^\/api(?=\/)/i, '');
  p = p.replace(/\/+/g, '/');
  p = p.replace(/\/+$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.toLowerCase();
}

function uniqCandidates(candidates = []) {
  const seen = new Set();
  const out  = [];
  for (const c of candidates) {
    if (!c?.path) continue;
    const key = `${String(c.method || 'GET').toUpperCase()}:${normalizePath(c.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path:        normalizePath(c.path),
      method:      String(c.method || 'GET').toUpperCase(),
      rawPrice:    String(c.rawPrice || ''),
      network:     String(c.network || ''),
      asset:       String(c.asset || ''),
      payTo:       String(c.payTo || ''),
      label:       String(c.label || ''),
      description: String(c.description || ''),
      source:      String(c.source || 'unknown'),
    });
  }
  return out;
}

function isValidCandidate(candidate) {
  if (!candidate?.path) return false;
  if (!candidate.path.startsWith('/')) return false;
  if (candidate.path.length > 300) return false;
  const noisePatterns = [
    /\/_next\//i, /\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i,
    /\/static\//i, /\/chunks\//i, /\/media\//i,
    /\/favicon/i, /\/logo/i, /\/merit-logo/i,
    /\/llms\.txt/i, /\/docs\/?$/i,
    /\/v1\/x402\/?$/i, /\/v2\/x402\/?$/i, /\/\.well-known\/x402\/?$/i,
  ];
  if (noisePatterns.some(p => p.test(candidate.path))) return false;
  if (candidate.path.includes('\n') || candidate.path.includes('```')) return false;
  return true;
}

function classifyError(errorMessage = '') {
  const msg = String(errorMessage).toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('blocked')) return 'blocked';
  if (msg.includes('401') || msg.includes('unauthorized')) return 'unauthorized';
  if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limited';
  if (msg.includes('404') || msg.includes('not found')) return 'not_found';
  return 'network_error';
}

async function saveFileToKVS(filename, buffer, contentType) {
  const store = await Actor.openKeyValueStore();
  await store.setValue(filename, buffer, { contentType });
  return `https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true`;
}

function normalizeCandidate(raw = {}) {
  return {
    path:        normalizePath(raw.path || raw.endpoint || raw.url || ''),
    method:      String(raw.method || 'GET').toUpperCase(),
    rawPrice:    String(raw.rawPrice || raw.price || raw.amount || ''),
    network:     String(raw.network || ''),
    asset:       String(raw.asset || ''),
    payTo:       String(raw.payTo || ''),
    label:       String(raw.label || raw.name || ''),
    description: String(raw.description || ''),
    source:      String(raw.source || 'unknown'),
  };
}

// ============================================================
// SMART ROUTER – Membersihkan artefak dan menyaring sampah
// ============================================================
function smartRouter(candidates, sourceLabel) {
  const cleaned = [];

  for (const candidate of candidates) {
    // 1. Bersihkan path dari artefak markdown / backtick / newline / tag HTML
    let cleanPath = candidate.path
      .replace(/[`\\\n\r<>]/g, '')   // hapus backtick, newline, tag HTML
      .trim();

    // 2. TOLAK KANDIDAT SAMPAH
    if (!cleanPath.startsWith('/') || cleanPath.length < 2) continue;
    if (cleanPath.includes('<') || cleanPath.includes('>')) continue;
    // Tolak jika label mengandung tag HTML mentah
    if (candidate.label && (candidate.label.includes('<html') || candidate.label.includes('<pre>') || candidate.label.includes('<code>'))) continue;

    // 3. Bersihkan label
    let cleanLabel = (candidate.label || '').replace(/<[^>]+>/g, '').replace(/[`\\]/g, '').trim();
    if (!cleanLabel) cleanLabel = cleanPath.split('/').filter(Boolean).pop() || cleanPath;

    // 4. Bersihkan description
    let cleanDesc = (candidate.description || '').replace(/<[^>]+>/g, '').trim();

    // 5. Untuk sumber universal, tolak jika tidak ada harga
    if (sourceLabel === 'scraper' || sourceLabel === 'llms.txt' || sourceLabel === 'mcp.json' || sourceLabel === 'api-docs') {
      if (!candidate.rawPrice || candidate.rawPrice === '0') continue;
    }

    cleaned.push({
      ...candidate,
      path:        cleanPath,
      label:       cleanLabel,
      description: cleanDesc,
    });
  }

  return cleaned;
}

// ============================================================
// PARSER PRESISI UNTUK SUMBER API STANDAR
// ============================================================
function parseWellKnownX402(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    const extractPrice = (pricing) => {
      if (!pricing) return '';
      if (typeof pricing.price === 'number') return String(Math.round(pricing.price * 1_000_000));
      if (typeof pricing.price === 'string') { const m = pricing.price.match(/\$?([\d.]+)/); if (m) return String(Math.round(parseFloat(m[1]) * 1_000_000)); }
      if (typeof pricing.pricePerSource === 'number') return String(Math.round(pricing.pricePerSource * 1_000_000));
      if (typeof pricing.inputPerMillionTokens === 'number') return String(Math.round(pricing.inputPerMillionTokens * 1_000_000));
      if (typeof pricing.pricePerCall === 'number') return String(Math.round(pricing.pricePerCall * 1_000_000));
      if (typeof pricing.perRequest === 'number') return String(Math.round(pricing.perRequest * 1_000_000));
      if (typeof pricing.pricePerImage === 'number') return String(Math.round(pricing.pricePerImage * 1_000_000));
      return '';
    };
    if (Array.isArray(data.resources)) {
      for (const res of data.resources) {
        if (typeof res === 'object' && res) {
          const path = res.path || res.endpoint || res.url;
          if (!path) continue;
          candidates.push(normalizeCandidate({
            path, method: res.method || 'GET',
            rawPrice: extractPrice(res.pricing || res),
            network: res.network || data.network || '',
            asset: res.asset || data.asset || '',
            label: res.name || res.id || '',
            description: res.description || '',
            source: 'well-known-x402',
          }));
        } else if (typeof res === 'string') {
          const parts = res.trim().split(/\s+/);
          candidates.push(normalizeCandidate({
            path: parts.length > 1 ? parts.slice(1).join(' ') : parts[0],
            method: parts.length > 1 ? parts[0] : 'GET',
            rawPrice: '',
            network: data.network || '', asset: data.asset || '',
            label: parts[0], description: '',
            source: 'well-known-x402',
          }));
        }
      }
    }
    if (Array.isArray(data.services)) {
      for (const svc of data.services) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        let rawPrice = extractPrice(svc.pricing || svc.price || {});
        if (!rawPrice && Array.isArray(svc.models) && svc.models.length > 0) rawPrice = extractPrice(svc.models[0].pricing || svc.models[0].price || {});
        const payment = svc.payment || {};
        candidates.push(normalizeCandidate({
          path, method: svc.method || 'POST', rawPrice,
          network: payment.network || svc.network || data.network || '',
          asset: payment.asset || svc.asset || data.asset || '',
          label: svc.name || svc.id || svc.label || '',
          description: svc.description || '',
          source: 'well-known-x402',
        }));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}

function parseAgentCard(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    const services = data.skills || data.services || data.endpoints || [];
    for (const svc of services) {
      const path = svc.endpoint || svc.path || svc.url;
      if (!path) continue;
      candidates.push(normalizeCandidate({
        path, method: svc.method || 'GET',
        rawPrice: String(svc.price || svc.cost || ''),
        network: svc.network || '',
        asset: svc.asset || '',
        label: svc.name || svc.id || '',
        description: svc.description || '',
        source: 'agent-card',
      }));
    }
  } catch { /* not JSON */ }
  return candidates;
}

function parseOpenAPI(text) {
  const candidates = [];
  try {
    const spec = JSON.parse(text);
    if (!spec.paths) return candidates;
    for (const [path, methods] of Object.entries(spec.paths)) {
      const methodKey = Object.keys(methods || {})[0] || 'get';
      const operation = methods?.[methodKey] || {};
      let price = '', network = '', asset = '', description = '';
      if (operation['x-payment-info']) {
        const pi = operation['x-payment-info'];
        price = String(pi.price || pi.amount || '');
        network = pi.network || ''; asset = pi.asset || pi.token || '';
        description = pi.description || '';
      }
      const resp402 = operation.responses?.['402'];
      if (resp402?.content?.['application/json']?.example?.accepts) {
        const offer = resp402.content['application/json'].example.accepts[0] || {};
        price = price || String(offer.maxAmountRequired || offer.amount || '');
        network = network || offer.network || '';
        asset = asset || offer.asset || '';
        description = description || offer.description || operation.description || '';
      }
      if (!price && spec['x-payment-info']) {
        const pi = spec['x-payment-info'];
        price = String(pi.price || '');
        network = network || pi.network || '';
        asset = asset || pi.asset || '';
      }
      candidates.push(normalizeCandidate({
        path, method: methodKey.toUpperCase(),
        rawPrice: price, network, asset,
        label: operation.summary || operation.operationId || '',
        description: description || operation.description || '',
        source: 'openapi',
      }));
    }
  } catch { /* not JSON */ }
  return candidates;
}

function parseHealth(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)) {
      for (const [path, info] of Object.entries(data.endpoints)) {
        let rawPrice = ''; const network = data.network || '';
        if (typeof info.price === 'string') {
          const match = info.price.match(/\$([\d.]+)/);
          if (match) rawPrice = String(Math.round(parseFloat(match[1]) * 1_000_000));
          else if (info.price === 'free' || info.price === '0') rawPrice = '0';
        } else if (typeof info.price === 'number') rawPrice = String(info.price);
        candidates.push(normalizeCandidate({
          path, method: 'GET', rawPrice, network, asset: '',
          label: info.description || path, description: info.description || '', source: '/health',
        }));
      }
    }
    if (Array.isArray(data.endpoints)) {
      for (const svc of data.endpoints) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        candidates.push(normalizeCandidate({
          path, method: svc.method || 'GET',
          rawPrice: String(svc.price || svc.x402Price || ''),
          network: svc.network || data.network || '',
          asset: svc.asset || '',
          label: svc.name || svc.id || svc.description || '',
          description: svc.description || '',
          source: '/health',
        }));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}

// ============================================================
// PARSER UNIVERSAL UNTUK HTML / TEKS (PASUKAN GERILYA)
// ============================================================
function universalExtract(text, sourceLabel = 'unknown') {
  const candidates = [];
  const raw = String(text || '');

  const tablePrices = new Map();
  const tableRegex = /\|\s*([A-Za-z][\w\s/-]+?)\s*\|\s*\$?([\d.]+)\s*\|/gi;
  let tm;
  while ((tm = tableRegex.exec(raw)) !== null) tablePrices.set(tm[1].trim().toLowerCase(), String(Math.round(parseFloat(tm[2]) * 1_000_000)));

  // <li> extraction
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(raw)) !== null) {
    const liContent = liMatch[1];
    let path = '';
    const codeMatch = liContent.match(/<code>(\/[^<]+)<\/code>/i) || liContent.match(/<span[^>]*>(\/[^<]+)<\/span>/i);
    const hrefMatch = liContent.match(/href="(\/[^"]+)"/i);
    if (codeMatch) path = codeMatch[1].trim();
    else if (hrefMatch) path = hrefMatch[1].trim();
    if (!path || !path.startsWith('/')) { const pathMatch = liContent.match(/(\/[a-zA-Z0-9_\/.-]+)/); if (pathMatch) path = pathMatch[1].trim(); }
    if (!path || !path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    const priceMatch = liContent.match(/\$\s*([\d.]+)/);
    if (!priceMatch) continue;
    const price = String(Math.round(parseFloat(priceMatch[1]) * 1_000_000));
    let description = '';
    const descMatch = liContent.match(/>([^<]{10,100})<\/li>/) || liContent.match(/- ([^<]{10,100})/);
    if (descMatch) description = descMatch[1].trim();
    else { const stripped = liContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); description = stripped.substring(0, 120); }
    candidates.push({ path, method: 'GET', rawPrice: price, network: '', asset: '', payTo: '', label: description || path, description: description || path, source: `universal:html-li:${sourceLabel}` });
  }

  // Markdown blocks
  const mdBlocks = raw.split(/(?=^#{1,3}\s)/m);
  let previousHeading = '';
  for (const block of mdBlocks) {
    const headingMatch = block.match(/^#{1,3}\s+(.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : '';
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/i);
    if (!pathMatch) { if (heading) previousHeading = heading; continue; }
    const method = pathMatch[0].split(/\s+/)[0].toUpperCase();
    const path   = pathMatch[1];
    const priceMatch = block.match(/Price:\s*\$?([\d.]+)/i);
    let price = priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '';
    if (!price) { const headingLower = heading.toLowerCase(); for (const [key, val] of tablePrices) if (headingLower.includes(key) || key.includes(headingLower)) { price = val; break; } }
    const cleanHeading = heading.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
    let label = cleanHeading || previousHeading || '';
    if (label.includes('\n') || label.includes('#')) label = previousHeading || '';
    if (!label) label = path.split('/').filter(Boolean).slice(-2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const lines = block.split('\n');
    let description = '';
    for (const line of lines) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.includes('Price:')) continue; if (trimmed.length > 15) { description = trimmed; break; } }
    if (!description) description = label;
    candidates.push({ path, method, rawPrice: price, network: '', asset: '', payTo: '', label, description, source: `universal:md:${sourceLabel}` });
    if (heading) previousHeading = heading;
  }

  // Alternative llms.txt
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let llmsAltMatch;
  while ((llmsAltMatch = llmsAltPattern.exec(raw)) !== null) {
    const name = llmsAltMatch[1].trim();
    const price = String(Math.round(parseFloat(llmsAltMatch[2]) * 1_000_000));
    const description = llmsAltMatch[3].trim();
    const path = normalizePath('/tools/' + name.toLowerCase().replace(/\s+/g, '_'));
    candidates.push({ path, method: 'GET', rawPrice: price, network: '', asset: '', payTo: '', label: name, description, source: `universal:llms-alt:${sourceLabel}` });
  }

  // HTML href extraction
  const htmlPathMatches = raw.matchAll(/(?:href|src|action)=["'](\/[^"']+)["']/gi);
  for (const match of htmlPathMatches) {
    const path = match[1];
    if (!path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;
    const context = raw.substring(Math.max(0, match.index - 200), match.index + 300);
    const priceMatch = context.match(/\$([\d.]+)/);
    const labelMatch = context.match(/>([^<]{5,50})<\/a>/);
    candidates.push({ path, method: 'GET', rawPrice: priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '', network: '', asset: '', payTo: '', label: labelMatch ? labelMatch[1].trim() : '', description: '', source: `universal:html:${sourceLabel}` });
  }

  // Plain text (safe regex)
  const plainMatches = raw.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n"\]\},]+)/gi);
  for (const match of plainMatches) {
    const method = match[1].toUpperCase();
    const path   = match[2].replace(/[^a-zA-Z0-9_\/.-]/g, '');
    if (!path.startsWith('/')) continue;
    const context = raw.substring(Math.max(0, match.index - 50), match.index + 200);
    const priceMatch = context.match(/\$([\d.]+)/);
    const descMatch  = context.match(/-\s*(.{10,100})$/m);
    candidates.push({ path, method, rawPrice: priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '', network: '', asset: '', payTo: '', label: descMatch ? descMatch[1].trim() : '', description: descMatch ? descMatch[1].trim() : '', source: `universal:text:${sourceLabel}` });
  }

  return candidates;
}

// ============================================================
// CRAWLER (LANGKAH 1) – Kumpulkan halaman
// ============================================================
async function crawlPages(base, timeout) {
  const startUrls = [
    `https://${base}`, `https://${base}/docs`, `https://${base}/api`,
    `https://${base}/developers`, `https://${base}/pricing`,
  ];
  const discovered = new Map();
  const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /', 'base url', 'api reference', 'pricing summary'];

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 5,
    async requestHandler({ request, response, $, enqueueLinks }) {
      const contentType = response?.headers?.['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        try {
          const bodyText = String(response?.body || '');
          if (bodyText && bodyText.length > 10) { discovered.set(request.url, { url: request.url, html: bodyText }); console.log(`[CRAWLER] Non-HTML page saved: ${request.url}`); }
        } catch (err) { console.log(`[CRAWLER] Error saving non-HTML: ${err.message}`); }
        return;
      }
      try {
        const bodyText = $('body').text().toLowerCase();
        const matched = keywords.filter((kw) => bodyText.includes(kw));
        if (matched.length > 0) { discovered.set(request.url, { url: request.url, html: $.html() }); console.log(`[CRAWLER] Found: ${request.url}`); }
        await enqueueLinks({ transformRequestFunction(req) { try { const links = $('a[href]').toArray(); for (const el of links) { const href = $(el).attr('href') || ''; try { const fullHref = new URL(href, request.url).href; if (fullHref === req.url && keywords.some((kw) => $(el).text().toLowerCase().includes(kw))) return req; } catch { /* invalid href */ } } } catch { /* ignore */ } return null; } });
      } catch (err) {
        console.log(`[CRAWLER] Cheerio failed for ${request.url}: ${err.message}`);
        const bodyText = String(response?.body || '');
        if (bodyText && bodyText.length > 10) { discovered.set(request.url, { url: request.url, html: bodyText }); console.log(`[CRAWLER] Saved raw body: ${request.url}`); }
      }
    },
  });
  await crawler.run(startUrls);
  return [...discovered.values()];
}

// ============================================================
// FETCHER UNTUK SUMBER API STANDAR
// ============================================================
async function fetchTextSource(url, timeout, label) {
  try {
    const response = await got(url, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' } });
    if (response.statusCode === 200 && response.body) { console.log(`[FETCH] ${label}: ${response.body.length} bytes`); return response.body; }
  } catch (err) { console.log(`[FETCH] ${label} error: ${err.message}`); }
  return null;
}

// ============================================================
// PIPELINE UTAMA (ALUR BENAR)
// ============================================================
async function runFullPipeline(base, timeout) {
  const allCandidates = [];

  // ============================================================
  // FASE 1: KERAHKAN PASUKAN GERILYA (Crawler + Universal Parser)
  // ============================================================
  console.log('[PIPELINE] Phase 1: Deploying guerrilla forces (Crawler + Universal Parser)...');
  const scraperPages = await crawlPages(base, timeout);
  for (const page of scraperPages) {
    const rawCandidates = universalExtract(page.html, 'scraper');
    const cleaned = smartRouter(rawCandidates, 'scraper');
    console.log(`[PIPELINE] scraper:${page.url}: ${rawCandidates.length} raw → ${cleaned.length} cleaned`);
    allCandidates.push(...cleaned);
  }

  // ============================================================
  // FASE 2: KERAHKAN PASUKAN PRESISI (Precision Parsers)
  // ============================================================
  console.log('[PIPELINE] Phase 2: Deploying precision forces (Precision Parsers)...');
  const precisionSources = [
    { url: `https://${base}/.well-known/x402`,                      label: 'well-known-x402', parser: parseWellKnownX402 },
    { url: `https://${base}/.well-known/agent-card.json`,           label: 'agent-card',      parser: parseAgentCard },
    { url: `https://${base}/.well-known/agent.json`,                label: 'agent.json',      parser: parseAgentCard },
    { url: `https://${base}/.well-known/agent-services.json`,       label: 'agent-services',  parser: parseAgentCard },
    { url: `https://${base}/openapi.json`,                          label: 'openapi',         parser: parseOpenAPI },
    { url: `https://${base}/swagger.json`,                          label: 'swagger',         parser: parseOpenAPI },
    { url: `https://${base}/health`,                                label: 'health',          parser: parseHealth },
  ];

  for (const src of precisionSources) {
    const text = await fetchTextSource(src.url, timeout, src.label);
    if (!text) continue;
    const rawCandidates = src.parser(text);
    const cleaned = smartRouter(rawCandidates, src.label);
    console.log(`[PIPELINE] ${src.label}: ${rawCandidates.length} raw → ${cleaned.length} cleaned`);
    allCandidates.push(...cleaned);
  }

  // ============================================================
  // FASE 3: TAMBAHAN (llms.txt, mcp.json, api-docs → Universal Parser)
  // ============================================================
  console.log('[PIPELINE] Phase 3: Additional sources (llms.txt, mcp.json)...');
  const extraSources = [
    { url: `https://${base}/llms.txt`,     label: 'llms.txt' },
    { url: `https://${base}/.well-known/mcp.json`, label: 'mcp.json' },
    { url: `https://${base}/api-docs.json`, label: 'api-docs' },
  ];
  for (const src of extraSources) {
    const text = await fetchTextSource(src.url, timeout, src.label);
    if (!text) continue;
    const rawCandidates = universalExtract(text, src.label);
    const cleaned = smartRouter(rawCandidates, src.label);
    console.log(`[PIPELINE] ${src.label}: ${rawCandidates.length} raw → ${cleaned.length} cleaned`);
    allCandidates.push(...cleaned);
  }

  return uniqCandidates(allCandidates);
}

// ============================================================
// VERIFIER – Verifikasi endpoint
// ============================================================
async function checkEndpoint(base, candidate, timeout) {
  const path   = normalizePath(candidate.path);
  const method = String(candidate.method || 'GET').toUpperCase();
  const url    = `https://${base}${path}`;
  const start  = Date.now();

  try {
    const response = await got(url, { method, timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' } });
    const httpStatus = response.statusCode; const responseTime = Date.now() - start; const bodyHash = sha256(response.body);

    if (httpStatus === 402) {
      try {
        const responseBody = JSON.parse(response.body);
        if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
          const offer = responseBody.accepts[0];
          const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
          const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1_000_000).toFixed(6)}` : '';
          return { domain: base, path, status: 'success', x402Version: String(responseBody.x402Version || ''), price: rawAmount, priceReadable, network: offer.network || candidate.network || '', asset: offer.asset || candidate.asset || '', payTo: offer.payTo || candidate.payTo || '', label: offer.label || candidate.label || '', description: offer.description || candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString(), auditHash: bodyHash };
        }
      } catch { /* fall through */ }
    }

    const rawPrice = candidate.rawPrice || '';
    const priceReadable = rawPrice ? `$${(parseInt(rawPrice, 10) / 1_000_000).toFixed(6)}` : '';
    return { domain: base, path, status: 'public_info', x402Version: '', price: rawPrice, priceReadable, network: candidate.network || '', asset: candidate.asset || '', payTo: candidate.payTo || '', label: candidate.label || '', description: candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString(), auditHash: bodyHash };
  } catch (err) {
    return { domain: base, path, status: classifyError(err.message), x402Version: '', price: '', priceReadable: '', network: candidate.network || '', asset: candidate.asset || '', payTo: candidate.payTo || '', label: candidate.label || '', description: candidate.description || '', httpStatus: '0', responseTimeMs: String(Date.now() - start), errorMessage: err.message, timestamp: new Date().toISOString(), auditHash: '' };
  }
}

// ============================================================
// Report Generation
// ============================================================
async function generateDOCX(domain, results) {
  const children = [ new Paragraph({ text: 'X402 Domain Scan Report', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }), new Paragraph({ text: `Domain: ${domain}`, spacing: { after: 60 } }), new Paragraph({ text: `Scan time: ${new Date().toISOString()}`, spacing: { after: 200 } }) ];
  if (results.length === 0) children.push(new Paragraph({ text: 'No public X402 information found on this domain.', spacing: { after: 120 } }));
  else for (const row of results) {
    children.push(new Paragraph({ text: `${row.path} [${row.status}]`, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 60 } }));
    if (row.priceReadable) children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
    if (row.label) children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
    if (row.asset) children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
    if (row.payTo) children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
    if (row.description) children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
    if (row.auditHash) children.push(new Paragraph({ text: `Audit Hash: ${row.auditHash}`, spacing: { after: 40 } }));
    if (row.errorMessage) children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
    children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function generatePDF(domain, results) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 }); const chunks = []; doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(18).text('X402 Domain Scan Report', { align: 'center' }); doc.moveDown(0.5); doc.fontSize(11).text(`Domain: ${domain}`); doc.fontSize(11).text(`Scan time: ${new Date().toISOString()}`); doc.moveDown();
    if (results.length === 0) doc.fontSize(12).text('No public X402 information found on this domain.');
    else for (const row of results) {
      doc.fontSize(12).text(`${row.path} [${row.status}]`, { underline: true });
      if (row.priceReadable) doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
      if (row.label) doc.fontSize(10).text(`Label: ${row.label}`);
      if (row.asset) doc.fontSize(10).text(`Asset: ${row.asset}`);
      if (row.payTo) doc.fontSize(10).text(`Pay To: ${row.payTo}`);
      if (row.description) doc.fontSize(10).text(`Description: ${row.description}`);
      if (row.auditHash) doc.fontSize(10).text(`Audit Hash: ${row.auditHash}`);
      if (row.errorMessage) doc.fontSize(10).text(`Error: ${row.errorMessage}`);
      doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`); doc.moveDown(0.5);
    }
    doc.end();
  });
}

// ============================================================
// Main
// ============================================================
const input = (await Actor.getInput()) || {};
let { domain, paths: manualPaths, maxPaths = DEFAULT_MAX_PATHS, timeout = DEFAULT_TIMEOUT, includeSubdomains = false } = input;
if (!domain) { await Actor.fail('Domain is required.'); await Actor.exit(); }

domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\/+$/, '').trim();

const targetDomains = [domain];
if (includeSubdomains) {
  const lowerDomain = domain.toLowerCase();
  if (!lowerDomain.endsWith('.workers.dev') && !lowerDomain.endsWith('.fly.dev')) targetDomains.push(`api.${domain}`);
  else console.log('[SDS] Workers/Fly domain detected. Skipping "api." subdomain addition.');
}

const allResults = [];
const manualList = (manualPaths || '').split(/\r?\n/g).map(x => x.trim()).filter(Boolean).map(normalizePath);

for (const base of targetDomains) {
  console.log(`[SDS] Starting pipeline for ${base}`);

  let candidates = [];

  // JIKA ADA PATH MANUAL, LANGSUNG GUNAKAN ITU
  if (manualList.length > 0) {
    console.log(`[SDS] Manual paths provided, skipping discovery. Using ${manualList.length} paths.`);
    candidates = manualList.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual' }));
  } else {
    // JIKA TIDAK, JALANKAN FULL PIPELINE
    console.log('[SDS] No manual paths. Running full pipeline.');
    candidates = await runFullPipeline(base, timeout);

    if (candidates.length === 0) {
      console.log('[SDS] Pipeline returned 0 candidates. Falling back to dictionary.');
      candidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary' }));
    }
  }

  candidates = candidates.filter(isValidCandidate);
  candidates = uniqCandidates(candidates);
  console.log(`[SDS] ${base}: ${candidates.length} candidates to verify`);

  const queue = [...candidates]; const verified = [];
  async function worker() { while (queue.length > 0) { const item = queue.shift(); if (!item) continue; verified.push(await checkEndpoint(base, item, timeout)); } }
  await Promise.all(Array.from({ length: DEFAULT_CONCURRENCY }, () => worker()));

  for (const row of verified) if (row) allResults.push(row);
}

const finalResults = allResults.map(row => ({ ...row, download_docx: '', download_pdf: '' }));
const docxBuffer = await generateDOCX(domain, finalResults); const pdfBuffer = await generatePDF(domain, finalResults);
const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl  = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');
const output = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`Scan complete. ${output.length} endpoints found.`);
await Actor.exit();
