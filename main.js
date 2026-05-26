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
const DEFAULT_TIMEOUT     = 5000;
const DEFAULT_MAX_PATHS   = 100;
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
// Utility fetch
// ============================================================
async function fetchTextSource(url, timeout, label) {
  try {
    const response = await got(url, {
      method: 'GET',
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' },
    });
    if (response.statusCode === 200 && response.body) {
      console.log(`[FETCH] ${label}: ${response.body.length} bytes`);
      return response.body;
    }
  } catch (err) {
    console.log(`[FETCH] ${label} error: ${err.message}`);
  }
  return null;
}

// ============================================================
// STAGE 1 – CRAWLER: kumpulkan SEMUA path mentah (belum parsing)
// ============================================================
async function crawlAPISources(base, timeout) {
  const rawPaths = [];
  const sources = [
    { url: `https://${base}/.well-known/x402`,                label: 'well-known-x402' },
    { url: `https://${base}/.well-known/agent-card.json`,     label: 'agent-card' },
    { url: `https://${base}/.well-known/agent.json`,          label: 'agent.json' },
    { url: `https://${base}/.well-known/agent-services.json`, label: 'agent-services' },
    { url: `https://${base}/openapi.json`,                    label: 'openapi' },
    { url: `https://${base}/swagger.json`,                    label: 'swagger' },
    { url: `https://${base}/health`,                          label: 'health' },
    { url: `https://${base}/llms.txt`,                        label: 'llms.txt' },
    { url: `https://${base}/.well-known/mcp.json`,            label: 'mcp.json' },
    { url: `https://${base}/api-docs.json`,                   label: 'api-docs' },
  ];
  for (const src of sources) {
    const text = await fetchTextSource(src.url, timeout, src.label);
    if (text) rawPaths.push({ source: src.label, content: text });
  }
  return rawPaths;
}

async function crawlHTMLPages(base, timeout) {
  const startUrls = [
    `https://${base}`,
    `https://${base}/docs`,
    `https://${base}/api`,
    `https://${base}/developers`,
    `https://${base}/pricing`,
  ];
  const discovered = new Map();
  const keywords = [
    'x402', 'agent', 'payment', 'endpoint', 'pricing', 'service',
    '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /',
    'base url', 'api reference', 'pricing summary',
  ];
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 5,
    async requestHandler({ request, response, $, enqueueLinks }) {
      const contentType = response?.headers?.['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        try {
          const bodyText = String(response?.body || '');
          if (bodyText && bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
        } catch (err) { /* ignore */ }
        return;
      }
      try {
        const bodyText = $('body').text().toLowerCase();
        const matched = keywords.filter((kw) => bodyText.includes(kw));
        if (matched.length > 0) discovered.set(request.url, { url: request.url, html: $.html() });
        await enqueueLinks({
          transformRequestFunction(req) {
            try {
              const links = $('a[href]').toArray();
              for (const el of links) {
                const href = $(el).attr('href') || '';
                try {
                  const fullHref = new URL(href, request.url).href;
                  if (fullHref === req.url && keywords.some((kw) => $(el).text().toLowerCase().includes(kw))) return req;
                } catch { /* invalid href */ }
              }
            } catch { /* ignore */ }
            return null;
          },
        });
      } catch (err) {
        const bodyText = String(response?.body || '');
        if (bodyText && bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
      }
    },
  });
  await crawler.run(startUrls);
  return [...discovered.values()];
}

// ============================================================
// STAGE 2 – SCRAPER: kumpulkan respons mentah dari setiap path
// ============================================================
async function scrapeEndpoints(base, candidates, timeout) {
  const scraped = [];
  const queue = [...candidates];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      const path   = normalizePath(item.path);
      const method = String(item.method || 'GET').toUpperCase();
      const url    = `https://${base}${path}`;
      const start  = Date.now();
      try {
        const response = await got(url, {
          method,
          timeout: { request: timeout },
          throwHttpErrors: false,
          retry: { limit: 0 },
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' },
        });
        scraped.push({
          candidate: item,
          statusCode: response.statusCode,
          body: response.body,
          responseTime: Date.now() - start,
          error: null,
        });
      } catch (err) {
        scraped.push({
          candidate: item,
          statusCode: 0,
          body: '',
          responseTime: Date.now() - start,
          error: err.message,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: DEFAULT_CONCURRENCY }, () => worker()));
  console.log(`[SCRAPER] ${scraped.length} endpoints scraped`);
  return scraped;
}

// ============================================================
// STAGE 3 – SCANNER: baca respons, catat status & hash
// ============================================================
function scanResponses(scraped) {
  return scraped.map(({ candidate, statusCode, body, responseTime, error }) => {
    const bodyHash = body ? sha256(body) : '';
    return {
      candidate,
      statusCode,
      body,
      bodyHash,
      responseTime,
      errorMessage: error || '',
    };
  });
}

// ============================================================
// STAGE 4 – PARSER: semua logika ekstraksi dijalankan DI AKHIR
// ============================================================

// --- 4a. Ultimate Price Extractor ---
function extractPrice(pricing) {
  if (!pricing) return '';
  const raw = String(pricing).trim();
  if (!raw) return '';
  const patterns = [
    /US\$\s*([\d.]+)/i,
    /\$\s*([\d.]+)\s*(?:USD|USDC|usd|usdc)/i,
    /([\d.]+)\s*(?:USDC|USD|usd|usdc)/i,
    /\$\s*([\d.]+)/,
    /Price:\s*([\d.]+)/i,
    /([\d.]+)\s*per\s+request/i,
    /^([\d.]+)$/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return String(Math.round(parseFloat(match[1]) * 1_000_000));
  }
  if (typeof pricing === 'number') return String(Math.round(pricing * 1_000_000));
  if (typeof pricing === 'string' && !isNaN(parseFloat(pricing))) return String(Math.round(parseFloat(pricing) * 1_000_000));
  return '';
}

// --- 4b. Precision Parsers (hanya dipakai di akhir) ---
function parseWellKnownX402(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.resources)) {
      for (const res of data.resources) {
        if (typeof res === 'object' && res) {
          const path = res.path || res.endpoint || res.url;
          if (!path) continue;
          candidates.push(normalizeCandidate({
            path, method: res.method || 'GET',
            rawPrice: extractPrice(res.pricing || res.price || res.amount || res.cost || ''),
            network: res.network || data.network || '',
            asset: res.asset || data.asset || '',
            label: res.name || res.id || res.label || '',
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
        let rawPrice = extractPrice(svc.pricing || svc.price || svc.amount || svc.cost || '');
        if (!rawPrice && Array.isArray(svc.models) && svc.models.length > 0) {
          rawPrice = extractPrice(svc.models[0].pricing || svc.models[0].price || svc.models[0].amount || svc.models[0].cost || '');
        }
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
    const possibleServiceKeys = [
      'skills', 'services', 'endpoints', 'actions', 'capabilities',
      'tools', 'functions', 'methods', 'apis', 'resources',
      'offers', 'listings', 'items', 'entries',
    ];
    for (const key of possibleServiceKeys) {
      if (data[key] && Array.isArray(data[key])) {
        for (const item of data[key]) {
          if (typeof item === 'object') candidates.push(extractEndpointFromObject(item));
        }
      }
    }
    if (candidates.length === 0) {
      function deepScan(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(item => { if (typeof item === 'object') candidates.push(extractEndpointFromObject(item)); });
          return;
        }
        if (obj.path || obj.endpoint || obj.url) candidates.push(extractEndpointFromObject(obj));
        Object.values(obj).forEach(val => deepScan(val));
      }
      deepScan(data);
    }
  } catch { /* not JSON */ }
  return candidates;
}

function extractEndpointFromObject(obj) {
  return normalizeCandidate({
    path:        obj.path || obj.endpoint || obj.url || obj.route || '',
    method:      obj.method || obj.verb || obj.type || 'GET',
    rawPrice:    extractPrice(obj.price || obj.cost || obj.amount || obj.pricing || ''),
    network:     obj.network || obj.chain || '',
    asset:       obj.asset || obj.token || '',
    payTo:       obj.payTo || obj.address || obj.wallet || '',
    label:       obj.label || obj.name || obj.title || obj.id || obj.summary || '',
    description: obj.description || obj.summary || obj.detail || obj.info || '',
    source:      'agent-card',
  });
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
        price = extractPrice(pi.price || pi.amount || '');
        network = pi.network || ''; asset = pi.asset || pi.token || '';
        description = pi.description || '';
      }
      const resp402 = operation.responses?.['402'];
      if (resp402?.content?.['application/json']?.example?.accepts) {
        const offer = resp402.content['application/json'].example.accepts[0] || {};
        price = price || extractPrice(offer.maxAmountRequired || offer.amount || '');
        network = network || offer.network || '';
        asset = asset || offer.asset || '';
        description = description || offer.description || operation.description || '';
      }
      if (!price && spec['x-payment-info']) {
        const pi = spec['x-payment-info'];
        price = extractPrice(pi.price || '');
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
        if (typeof info.price === 'string') rawPrice = extractPrice(info.price);
        else if (typeof info.price === 'number') rawPrice = String(info.price);
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
          rawPrice: extractPrice(svc.price || svc.x402Price || ''),
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

function parseLLMsTxt(text, sourceLabel) {
  const candidates = [];
  const raw = String(text || '');
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let match;
  while ((match = llmsAltPattern.exec(raw)) !== null) {
    candidates.push(normalizeCandidate({
      path: normalizePath('/tools/' + match[1].trim().toLowerCase().replace(/\s+/g, '_')),
      method: 'GET',
      rawPrice: String(Math.round(parseFloat(match[2]) * 1_000_000)),
      label: match[1].trim(),
      description: match[3].trim(),
      source: `llms.txt:${sourceLabel}`,
    }));
  }
  return candidates;
}

function parseJSONLike(text, sourceLabel) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (data.path || data.endpoint || data.url) candidates.push(extractEndpointFromObject(data));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'object') candidates.push(extractEndpointFromObject(item));
      }
    }
    if (typeof data === 'object' && data !== null) {
      for (const val of Object.values(data)) {
        if (val && typeof val === 'object' && (val.path || val.endpoint || val.url)) candidates.push(extractEndpointFromObject(val));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}

// --- 4c. Universal Extractor (tetap seperti asli) ---
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
    const price = extractPrice(liContent.match(/\$\s*([\d.]+)/) ? liContent.match(/\$\s*([\d.]+)/)[0] : '');
    if (!price) continue;
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
    const price = extractPrice(block.match(/Price:\s*\$?([\d.]+)/i) ? block.match(/Price:\s*\$?([\d.]+)/i)[0] : '');
    let finalPrice = price;
    if (!finalPrice) { const headingLower = heading.toLowerCase(); for (const [key, val] of tablePrices) if (headingLower.includes(key) || key.includes(headingLower)) { finalPrice = val; break; } }
    const cleanHeading = heading.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
    let label = cleanHeading || previousHeading || '';
    if (label.includes('\n') || label.includes('#')) label = previousHeading || '';
    if (!label) label = path.split('/').filter(Boolean).slice(-2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const lines = block.split('\n');
    let description = '';
    for (const line of lines) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.includes('Price:')) continue; if (trimmed.length > 15) { description = trimmed; break; } }
    if (!description) description = label;
    candidates.push({ path, method, rawPrice: finalPrice, network: '', asset: '', payTo: '', label, description, source: `universal:md:${sourceLabel}` });
    if (heading) previousHeading = heading;
  }

  // Alternative llms.txt
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let llmsAltMatch;
  while ((llmsAltMatch = llmsAltPattern.exec(raw)) !== null) {
    candidates.push({ path: normalizePath('/tools/' + llmsAltMatch[1].trim().toLowerCase().replace(/\s+/g, '_')), method: 'GET', rawPrice: String(Math.round(parseFloat(llmsAltMatch[2]) * 1_000_000)), network: '', asset: '', payTo: '', label: llmsAltMatch[1].trim(), description: llmsAltMatch[3].trim(), source: `universal:llms-alt:${sourceLabel}` });
  }

  // HTML href extraction
  const htmlPathMatches = raw.matchAll(/(?:href|src|action)=["'](\/[^"']+)["']/gi);
  for (const match of htmlPathMatches) {
    const path = match[1];
    if (!path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;
    const context = raw.substring(Math.max(0, match.index - 200), match.index + 300);
    const price = extractPrice(context.match(/\$([\d.]+)/) ? context.match(/\$([\d.]+)/)[0] : '');
    const labelMatch = context.match(/>([^<]{5,50})<\/a>/);
    candidates.push({ path, method: 'GET', rawPrice: price, network: '', asset: '', payTo: '', label: labelMatch ? labelMatch[1].trim() : '', description: '', source: `universal:html:${sourceLabel}` });
  }

  // Plain text
  const plainMatches = raw.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n"\]\},]+)/gi);
  for (const match of plainMatches) {
    const method = match[1].toUpperCase();
    const path   = match[2].replace(/[^a-zA-Z0-9_\/.-]/g, '');
    if (!path.startsWith('/')) continue;
    const context = raw.substring(Math.max(0, match.index - 50), match.index + 200);
    const price = extractPrice(context.match(/\$([\d.]+)/) ? context.match(/\$([\d.]+)/)[0] : '');
    const descMatch  = context.match(/-\s*(.{10,100})$/m);
    candidates.push({ path, method, rawPrice: price, network: '', asset: '', payTo: '', label: descMatch ? descMatch[1].trim() : '', description: descMatch ? descMatch[1].trim() : '', source: `universal:text:${sourceLabel}` });
  }

  return candidates;
}

// --- 4d. Smart Router (tetap seperti asli) ---
function smartRouter(candidates, sourceLabel) {
  const cleaned = [];
  for (const candidate of candidates) {
    let cleanPath = candidate.path.replace(/[`\\\n\r<>]/g, '').trim();
    if (!cleanPath.startsWith('/') || cleanPath.length < 2) continue;
    if (cleanPath.includes('<') || cleanPath.includes('>')) continue;
    if (candidate.label && (candidate.label.includes('<html') || candidate.label.includes('<pre>') || candidate.label.includes('<code>'))) continue;
    let cleanLabel = (candidate.label || '').replace(/<[^>]+>/g, '').replace(/[`\\]/g, '').trim();
    if (!cleanLabel) cleanLabel = cleanPath.split('/').filter(Boolean).pop() || cleanPath;
    let cleanDesc = (candidate.description || '').replace(/<[^>]+>/g, '').trim();
    if (sourceLabel === 'scraper' || sourceLabel === 'llms.txt' || sourceLabel === 'mcp.json' || sourceLabel === 'api-docs') {
      if (!candidate.rawPrice || candidate.rawPrice === '0') continue;
    }
    cleaned.push({ ...candidate, path: cleanPath, label: cleanLabel, description: cleanDesc });
  }
  return cleaned;
}

// ============================================================
// FINAL PARSER: gabungkan semua hasil parsing
// ============================================================
function parseAllRawData(rawPaths, scrapedData) {
  const candidates = [];

  // 1. Parse raw API sources dengan parser spesifik
  for (const { source, content } of rawPaths) {
    let parsed = [];
    if (source === 'well-known-x402') parsed = parseWellKnownX402(content);
    else if (source.startsWith('agent-')) parsed = parseAgentCard(content);
    else if (source === 'openapi' || source === 'swagger') parsed = parseOpenAPI(content);
    else if (source === 'health') parsed = parseHealth(content);
    else if (source === 'llms.txt') parsed = parseLLMsTxt(content, source);
    else if (source === 'mcp.json' || source === 'api-docs') parsed = parseJSONLike(content, source);

    if (parsed.length === 0) {
      // Fallback ke universalExtract jika parser spesifik tidak menghasilkan apa-apa
      parsed = universalExtract(content, source);
    }
    const cleaned = smartRouter(parsed, source);
    console.log(`[PARSER] ${source}: ${parsed.length} raw → ${cleaned.length} cleaned`);
    candidates.push(...cleaned);
  }

  // 2. Parse body respons dari scraper
  for (const item of scrapedData) {
    if (!item.body) continue;
    const { candidate, body, statusCode } = item;
    const path = normalizePath(candidate.path);

    // Coba 402 JSON
    if (statusCode === 402) {
      try {
        const json = JSON.parse(body);
        if (json.accepts && Array.isArray(json.accepts) && json.accepts.length > 0) {
          const offer = json.accepts[0];
          candidates.push(normalizeCandidate({
            path,
            method: candidate.method || 'GET',
            rawPrice: extractPrice(offer.maxAmountRequired || offer.amount || ''),
            network: offer.network || candidate.network || '',
            asset: offer.asset || candidate.asset || '',
            payTo: offer.payTo || candidate.payTo || '',
            label: offer.label || candidate.label || '',
            description: offer.description || candidate.description || '',
            source: 'scraper:402',
          }));
          continue;
        }
      } catch { /* not JSON */ }
    }

    // Fallback: universalExtract pada body
    const extracted = universalExtract(body, `scraper:${path}`);
    const cleaned = smartRouter(extracted, 'scraper');
    if (cleaned.length > 0) candidates.push(...cleaned);
  }

  return uniqCandidates(candidates).filter(isValidCandidate);
}

// ============================================================
// FINAL FILTER: hanya endpoint lengkap yang lolos
// ============================================================
function finalFilter(parsedCandidates) {
  return parsedCandidates.map(c => ({
    domain: '',
    path: c.path,
    status: 'public_info',
    x402Version: '',
    price: c.rawPrice || '',
    priceReadable: c.rawPrice ? `$${(parseInt(c.rawPrice, 10) / 1_000_000).toFixed(6)}` : '',
    network: c.network || '',
    asset: c.asset || '',
    payTo: c.payTo || '',
    label: c.label || '',
    description: c.description || '',
    httpStatus: '',
    responseTimeMs: '',
    errorMessage: '',
    timestamp: new Date().toISOString(),
    auditHash: '',
  })).filter(row => {
    const hasPrice = row.price && row.price !== '0';
    const hasDescription = row.description && row.description.length > 5;
    const hasLabel = row.label && row.label.length > 2;
    return hasPrice && hasDescription && hasLabel;
  });
}

// ============================================================
// Report Generation
// ============================================================
async function generateDOCX(domain, results) {
  const children = [
    new Paragraph({ text: 'X402 Domain Scan Report', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    new Paragraph({ text: `Domain: ${domain}`, spacing: { after: 60 } }),
    new Paragraph({ text: `Scan time: ${new Date().toISOString()}`, spacing: { after: 200 } }),
  ];
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
}

const allResults = [];
const manualList = (manualPaths || '').split(/\r?\n/g).map(x => x.trim()).filter(Boolean).map(normalizePath);

for (const base of targetDomains) {
  console.log(`\n[SDS] === Pipeline for ${base} ===\n`);

  // ============================================================
  // STAGE 1 – CRAWLER: kumpulkan SEMUA path mentah
  // ============================================================
  let rawPaths = [];
  if (manualList.length > 0) {
    console.log('[CRAWLER] Manual path list provided, skipping source discovery.');
    rawPaths = []; // manual path tidak butuh API source crawling
  } else {
    rawPaths = await crawlAPISources(base, timeout);
  }
  const htmlPages = manualList.length > 0 ? [] : await crawlHTMLPages(base, timeout);
  console.log(`[CRAWLER] ${rawPaths.length} API sources + ${htmlPages.length} HTML pages crawled`);

  // Gabungkan semua konten mentah: API sources + HTML pages
  const allRawContent = [
    ...rawPaths,
    ...htmlPages.map(p => ({ source: 'scraper', content: p.html })),
  ];

  // ============================================================
  // STAGE 2 – SCRAPER: panggil setiap path, ambil respons mentah
  // ============================================================
  let candidates;
  if (manualList.length > 0) {
    candidates = manualList.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual' }));
  } else {
    // Gunakan dictionary dulu kalau tidak ada manual list, untuk dikirim ke scraper
    candidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary' }));
  }
  console.log(`[SCRAPER] ${candidates.length} paths to scrape`);

  const scrapedData = await scrapeEndpoints(base, candidates, timeout);

  // ============================================================
  // STAGE 3 – SCANNER: baca respons, catat status & hash
  // ============================================================
  const scannedData = scanResponses(scrapedData);
  console.log(`[SCANNER] ${scannedData.length} responses scanned`);

  // ============================================================
  // STAGE 4 – PARSER: semua parsing dijalankan DI AKHIR
  // ============================================================
  const parsedCandidates = parseAllRawData(allRawContent, scannedData);
  console.log(`[PARSER] ${parsedCandidates.length} total candidates after parsing`);

  // ============================================================
  // STAGE 5 – FINAL FILTER
  // ============================================================
  const final = finalFilter(parsedCandidates);
  console.log(`[FINAL] ${final.length} complete endpoints after final filter`);

  allResults.push(...final);
}

// ============================================================
// OUTPUT
// ============================================================
const finalResults = allResults.map(row => ({ ...row, domain, download_docx: '', download_pdf: '' }));
const docxBuffer = await generateDOCX(domain, finalResults);
const pdfBuffer  = await generatePDF(domain, finalResults);
const docxUrl    = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl     = await saveFileToKVS('OUTPUT.pdf',  pdfBuffer,  'application/pdf');
const output     = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`\nScan complete. ${output.length} endpoints found.`);
await Actor.exit();
