import { Actor } from 'apify'; import { CheerioCrawler } from 'crawlee'; import got from 'got'; import crypto from 'crypto'; import fs from 'fs/promises'; import { Document, Packer, Paragraph, HeadingLevel } from 'docx'; import PDFDocument from 'pdfkit';

await Actor.init();

// ============================================================ // Config // ============================================================ const DEFAULT_TIMEOUT = 5000; const DEFAULT_MAX_PATHS = 100; const DEFAULT_CONCURRENCY = 8; const MAX_BODY_PREVIEW = 1000; const MAX_TEXT_PREVIEW = 15000;

const BUILT_IN_DICTIONARY = [ '/x402/', '/x402/sapi', '/x402/spdet', '/x402/scdft', '/x402/v1/', '/x402/payment', '/x402/checkout', '/x402/status', '/x402/health', '/x402/invoice', '/x402/balance', '/x402/webhook', '/x402/callback', '/x402/token', '/x402/auth', '/x402/order', '/x402/subscription', '/x402/usage', '/x402/rate', '/x402/quote', '/api/x402/', '/api/x402/payment', '/api/x402/status', '/api/x402/webhook', '/v1/x402', '/v1/x402/payment', '/v2/x402', '/.well-known/x402', ];

// ============================================================ // Helpers // ============================================================ function normalizeDomain(d) { return String(d || '').replace(/^https?:///i, '').replace(//.*$/, '').replace(//+$/, '').trim(); }

function sha256(raw) { return crypto.createHash('sha256').update(String(raw || '')).digest('hex'); }

function normalizePath(rawPath) { let p = String(rawPath || '').trim(); if (!p) return '';

if (p.startsWith('http://') || p.startsWith('https://')) { try { const url = new URL(p); p = '${url.pathname}${url.search || ''}'; } catch { // ignore } }

// keep well-known paths intact p = p.replace(/^/api(?=/)/i, ''); p = p.replace(//+/g, '/'); p = p.replace(//+$/, ''); if (!p.startsWith('/')) p = /${p}; return p.toLowerCase(); }

function parsePathsInput(pathsInput) { if (!pathsInput) return []; return String(pathsInput) .split(/\r?\n/g) .map((x) => x.trim()) .filter(Boolean) .map(normalizePath); }

function uniqCandidates(candidates = []) { const seen = new Set(); const out = []; for (const c of candidates) { if (!c?.path) continue; const key = ${String(c.method || 'GET').toUpperCase()}:${normalizePath(c.path)}; if (seen.has(key)) continue; seen.add(key); out.push({ path: normalizePath(c.path), method: String(c.method || 'GET').toUpperCase(), rawPrice: String(c.rawPrice || c.price || ''), network: String(c.network || ''), asset: String(c.asset || ''), payTo: String(c.payTo || ''), label: String(c.label || ''), description: String(c.description || ''), source: String(c.source || 'unknown'), }); } return out; }

function cheapExtractPrice(text) { const match = String(text || '').match(/$\s*([\d.]+)/i); return match ? String(Math.round(parseFloat(match[1]) * 1_000_000)) : ''; }

function cheapExtractLabel(path) { const parts = normalizePath(path).split('/').filter(Boolean); if (parts.length === 0) return ''; return parts .slice(1) .map((p) => p.charAt(0).toUpperCase() + p.slice(1)) .join(' '); }

function isValidCandidate(candidate) { if (!candidate?.path) return false; if (!candidate.path.startsWith('/')) return false; if (candidate.path.length > 300) return false; return true; }

function classifyError(errorMessage = '') { const msg = String(errorMessage).toLowerCase(); if (msg.includes('timed out') || msg.includes('timeout')) return 'timeout'; if (msg.includes('403') || msg.includes('forbidden') || msg.includes('blocked')) return 'blocked'; if (msg.includes('401') || msg.includes('unauthorized')) return 'unauthorized'; if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limited'; if (msg.includes('404') || msg.includes('not found')) return 'not_found'; return 'network_error'; }

async function logFailure(base, stage, details = {}) { try { const dataset = await Actor.openDataset('failed-scans'); await dataset.pushData({ domain: base, stage, timestamp: new Date().toISOString(), ...details, }); } catch (err) { console.error([FAIL-LOG] ${err.message}); } }

async function saveFileToKVS(filename, buffer, contentType) { const store = await Actor.openKeyValueStore(); await store.setValue(filename, buffer, { contentType }); return https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true; }

async function loadDictionary() { const fallback = BUILT_IN_DICTIONARY; try { const raw = await fs.readFile('./dictionary-path.json', 'utf8'); const parsed = JSON.parse(raw); if (Array.isArray(parsed) && parsed.length > 0) { return parsed.map(normalizePath); } } catch { // ignore and use fallback } return fallback.map(normalizePath); }

function normalizeCandidate(raw = {}) { return { path: normalizePath(raw.path || raw.endpoint || raw.url || ''), method: String(raw.method || 'GET').toUpperCase(), rawPrice: String(raw.rawPrice || raw.price || raw.amount || ''), network: String(raw.network || ''), asset: String(raw.asset || ''), payTo: String(raw.payTo || ''), label: String(raw.label || raw.name || ''), description: String(raw.description || ''), source: String(raw.source || 'unknown'), }; }

// ============================================================ // Report Generation // ============================================================ async function generateDOCX(domain, results) { const children = [ new Paragraph({ text: 'X402 Domain Scan Report', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }), new Paragraph({ text: Domain: ${domain}, spacing: { after: 60 } }), new Paragraph({ text: Scan time: ${new Date().toISOString()}, spacing: { after: 200 } }), ];

if (results.length === 0) { children.push(new Paragraph({ text: 'No public X402 information found on this domain.', spacing: { after: 120 } })); } else { for (const row of results) { children.push(new Paragraph({ text: ${row.path} [${row.status}], heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 60 } })); if (row.priceReadable) children.push(new Paragraph({ text: Price: ${row.priceReadable} | Network: ${row.network}, spacing: { after: 40 } })); if (row.label) children.push(new Paragraph({ text: Label: ${row.label}, spacing: { after: 40 } })); if (row.asset) children.push(new Paragraph({ text: Asset: ${row.asset}, spacing: { after: 40 } })); if (row.payTo) children.push(new Paragraph({ text: Pay To: ${row.payTo}, spacing: { after: 40 } })); if (row.description) children.push(new Paragraph({ text: Description: ${row.description}, spacing: { after: 40 } })); if (row.auditHash) children.push(new Paragraph({ text: Audit Hash: ${row.auditHash}, spacing: { after: 40 } })); if (row.errorMessage) children.push(new Paragraph({ text: Error: ${row.errorMessage}, spacing: { after: 40 } })); children.push(new Paragraph({ text: HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms, spacing: { after: 80 } })); } }

const doc = new Document({ sections: [{ properties: {}, children }] }); return Packer.toBuffer(doc); }

async function generatePDF(domain, results) { return new Promise((resolve, reject) => { const doc = new PDFDocument({ margin: 50 }); const chunks = []; doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

doc.fontSize(18).text('X402 Domain Scan Report', { align: 'center' });
doc.moveDown(0.5);
doc.fontSize(11).text(`Domain: ${domain}`);
doc.fontSize(11).text(`Scan time: ${new Date().toISOString()}`);
doc.moveDown();

if (results.length === 0) {
  doc.fontSize(12).text('No public X402 information found on this domain.');
} else {
  for (const row of results) {
    doc.fontSize(12).text(`${row.path} [${row.status}]`, { underline: true });
    if (row.priceReadable) doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
    if (row.label) doc.fontSize(10).text(`Label: ${row.label}`);
    if (row.asset) doc.fontSize(10).text(`Asset: ${row.asset}`);
    if (row.payTo) doc.fontSize(10).text(`Pay To: ${row.payTo}`);
    if (row.description) doc.fontSize(10).text(`Description: ${row.description}`);
    if (row.auditHash) doc.fontSize(10).text(`Audit Hash: ${row.auditHash}`);
    if (row.errorMessage) doc.fontSize(10).text(`Error: ${row.errorMessage}`);
    doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`);
    doc.moveDown(0.5);
  }
}

doc.end();

}); }

// ============================================================ // Discovery Sources // ============================================================ async function discoverFromWellKnownAgent(base, timeout) { const paths = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/.well-known/agent-services.json']; for (const wkPath of paths) { try { const response = await got(https://${base}${wkPath}, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, });

if (response.statusCode !== 200) {
    await logFailure(base, `agent-card:${wkPath}`, {
      httpStatus: response.statusCode,
      contentType: response.headers['content-type'],
      bodyPreview: response.body?.substring(0, MAX_BODY_PREVIEW),
      reason: `Non-200 status: ${response.statusCode}`,
    });
    continue;
  }

  const data = JSON.parse(response.body);
  const services = data.skills || data.services || data.endpoints || [];
  const candidates = [];

  for (const svc of services) {
    const path = svc.endpoint || svc.path || svc.url;
    if (!path) continue;
    candidates.push(normalizeCandidate({
      path,
      method: svc.method || 'GET',
      rawPrice: String(svc.price || svc.cost || ''),
      network: svc.network || '',
      asset: svc.asset || '',
      label: svc.name || svc.id || '',
      description: svc.description || '',
      source: wkPath,
    }));
  }

  if (candidates.length > 0) return candidates;
} catch (err) {
  console.log(`[AGENT-CARD] ${wkPath} error: ${err.message}`);
  await logFailure(base, `agent-card:${wkPath}`, { error: err.message, reason: 'Parse or network error' });
}

} return null; }

async function discoverFromWellKnownX402(base, timeout) { try { const response = await got(https://${base}/.well-known/x402, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, });

if (response.statusCode !== 200) {
  await logFailure(base, 'well-known-x402', {
    httpStatus: response.statusCode,
    contentType: response.headers['content-type'],
    bodyPreview: response.body?.substring(0, MAX_BODY_PREVIEW),
    reason: `Non-200 status: ${response.statusCode}`,
  });
  return null;
}

const data = JSON.parse(response.body);
const candidates = [];

const extractPrice = (pricing) => {
  if (!pricing) return '';
  if (typeof pricing.price === 'number') return String(Math.round(pricing.price * 1_000_000));
  if (typeof pricing.price === 'string') {
    const m = pricing.price.match(/\$?([\d.]+)/);
    if (m) return String(Math.round(parseFloat(m[1]) * 1_000_000));
  }
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
        path,
        method: res.method || 'GET',
        rawPrice: extractPrice(res.pricing || res),
        network: res.network || data.network || '',
        asset: res.asset || data.asset || '',
        label: res.name || res.id || '',
        description: res.description || '',
        source: '/.well-known/x402',
      }));
    } else if (typeof res === 'string') {
      const parts = res.trim().split(/\s+/g);
      const method = parts.length > 1 ? parts[0] : 'GET';
      const path = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
      candidates.push(normalizeCandidate({
        path,
        method,
        rawPrice: '',
        network: data.network || '',
        asset: data.asset || '',
        label: path,
        description: '',
        source: '/.well-known/x402',
      }));
    }
  }
}

if (Array.isArray(data.resourceDetails)) {
  for (const detail of data.resourceDetails) {
    const path = detail.path || detail.endpoint;
    if (!path) continue;
    candidates.push(normalizeCandidate({
      path,
      method: detail.method || 'GET',
      rawPrice: extractPrice(detail.pricing || detail),
      network: detail.network || data.network || '',
      asset: detail.asset || data.asset || '',
      label: detail.name || detail.label || detail.path || '',
      description: detail.description || '',
      source: '/.well-known/x402',
    }));
  }
}

if (Array.isArray(data.services)) {
  for (const svc of data.services) {
    const path = svc.endpoint || svc.path || svc.url;
    if (!path) continue;
    let rawPrice = extractPrice(svc.pricing || svc.price || {});
    if (!rawPrice && Array.isArray(svc.models) && svc.models.length > 0) {
      rawPrice = extractPrice(svc.models[0].pricing || svc.models[0].price || {});
    }
    const payment = svc.payment || {};
    candidates.push(normalizeCandidate({
      path,
      method: svc.method || 'POST',
      rawPrice,
      network: payment.network || svc.network || data.network || '',
      asset: payment.asset || svc.asset || data.asset || '',
      label: svc.name || svc.id || svc.label || '',
      description: svc.description || '',
      source: '/.well-known/x402',
    }));
  }
}

return uniqCandidates(candidates).length > 0 ? uniqCandidates(candidates) : null;

} catch (err) { console.log([WELL-KNOWN-X402] Error: ${err.message}); await logFailure(base, 'well-known-x402', { error: err.message, reason: 'Parse or network error' }); return null; } }

async function discoverFromOpenAPI(base, timeout) { const openApiPaths = ['/openapi.json', '/swagger.json', '/api-docs.json', '/v3/api-docs']; for (const apiPath of openApiPaths) { try { const response = await got(https://${base}${apiPath}, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, });

if (response.statusCode !== 200) {
    await logFailure(base, `openapi:${apiPath}`, {
      httpStatus: response.statusCode,
      contentType: response.headers['content-type'],
      bodyPreview: response.body?.substring(0, MAX_BODY_PREVIEW),
      reason: `Non-200 status: ${response.statusCode}`,
    });
    continue;
  }

  const spec = JSON.parse(response.body);
  if (!spec.paths) continue;

  const candidates = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    const methodKey = Object.keys(methods || {})[0] || 'get';
    const operation = methods?.[methodKey] || {};

    let price = '';
    let network = '';
    let asset = '';
    let description = '';

    if (operation['x-payment-info']) {
      const pi = operation['x-payment-info'];
      price = String(pi.price || pi.amount || '');
      network = pi.network || '';
      asset = pi.asset || pi.token || '';
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
      path,
      method: methodKey.toUpperCase(),
      rawPrice: price,
      network,
      asset,
      label: operation.summary || operation.operationId || '',
      description: description || operation.description || '',
      source: apiPath,
    }));
  }

  return uniqCandidates(candidates).length > 0 ? uniqCandidates(candidates) : null;
} catch (err) {
  console.log(`[OPENAPI] ${apiPath} error: ${err.message}`);
  await logFailure(base, `openapi:${apiPath}`, { error: err.message, reason: 'Parse or network error' });
}

} return null; }

async function discoverFromHealth(base, timeout) { try { const response = await got(https://${base}/health, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, });

if (response.statusCode !== 200) {
  await logFailure(base, 'health', {
    httpStatus: response.statusCode,
    contentType: response.headers['content-type'],
    bodyPreview: response.body?.substring(0, MAX_BODY_PREVIEW),
    reason: `Non-200 status: ${response.statusCode}`,
  });
  return null;
}

const data = JSON.parse(response.body);
const candidates = [];

if (data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)) {
  for (const [path, info] of Object.entries(data.endpoints)) {
    let rawPrice = '';
    const network = data.network || '';
    if (typeof info.price === 'string') {
      const match = info.price.match(/\$([\d.]+)/);
      if (match) rawPrice = String(Math.round(parseFloat(match[1]) * 1_000_000));
      else if (info.price === 'free' || info.price === '0') rawPrice = '0';
    } else if (typeof info.price === 'number') {
      rawPrice = String(info.price);
    }

    candidates.push(normalizeCandidate({
      path,
      method: 'GET',
      rawPrice,
      network,
      asset: '',
      label: info.description || path,
      description: info.description || '',
      source: '/health',
    }));
  }
}

if (Array.isArray(data.endpoints)) {
  for (const svc of data.endpoints) {
    const path = svc.endpoint || svc.path || svc.url;
    if (!path) continue;
    candidates.push(normalizeCandidate({
      path,
      method: svc.method || 'GET',
      rawPrice: String(svc.price || svc.x402Price || ''),
      network: svc.network || data.network || '',
      asset: svc.asset || '',
      label: svc.name || svc.id || svc.description || '',
      description: svc.description || '',
      source: '/health',
    }));
  }
}

return uniqCandidates(candidates).length > 0 ? uniqCandidates(candidates) : null;

} catch (err) { console.log([HEALTH] Error: ${err.message}); await logFailure(base, 'health', { error: err.message, reason: 'Parse or network error' }); return null; } }

async function scrapeStaticPages(base, timeout) { const startUrls = [ https://${base}, https://${base}/docs, https://${base}/api, https://${base}/developers, https://${base}/pricing, ];

const discovered = new Map(); const keywords = [ 'x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /', 'base url', 'api reference', 'pricing summary', ];

const crawler = new CheerioCrawler({ maxRequestsPerCrawl: 20, requestHandlerTimeoutSecs: 30, async requestHandler({ request, $, enqueueLinks }) { const bodyText = $('body').text().toLowerCase(); const matched = keywords.filter((kw) => bodyText.includes(kw));

if (matched.length > 0) {
    discovered.set(request.url, {
      url: request.url,
      html: $.html(),
    });
  } else {
    await logFailure(base, 'static-scraper', {
      url: request.url,
      reason: 'No relevant keywords',
      bodyPreview: bodyText.substring(0, 500),
    });
  }

  await enqueueLinks({
    transformRequestFunction(req) {
      const linkText = ($(`a[href="${req.url}"]`).text() || '').toLowerCase();
      if (keywords.some((kw) => linkText.includes(kw))) return req;
      return false;
    },
  });
},

});

await crawler.run(startUrls); return [...discovered.values()]; }

async function discoverFromScraper(base, timeout) { const pages = await scrapeStaticPages(base, timeout); if (pages.length === 0) return null;

const found = []; for (const page of pages) { const html = String(page.html || '').substring(0, MAX_TEXT_PREVIEW); // no AI: just try common path signatures from the HTML/text const candidatePaths = new Set();

// href/src/action/path-like strings
const regexes = [
  /(?:href|src|action)=["']([^"']+)["']/gi,
  /(\/api\/[a-z0-9_\-./?=&]+)/gi,
  /(\/x402\/[a-z0-9_\-./?=&]+)/gi,
  /(\/\.well-known\/[a-z0-9_\-./?=&]+)/gi,
];

for (const re of regexes) {
  let m;
  while ((m = re.exec(html)) !== null) {
    candidatePaths.add(normalizePath(m[1]));
  }
}

for (const p of candidatePaths) {
  if (!p) continue;
  found.push(normalizeCandidate({
    path: p,
    method: 'GET',
    rawPrice: cheapExtractPrice(html),
    network: '',
    asset: '',
    label: cheapExtractLabel(p),
    description: '',
    source: `scraper:${page.url}`,
  }));
}

}

const uniq = uniqCandidates(found); return uniq.length > 0 ? uniq : null; }

// ============================================================ // Verification // ============================================================ async function checkEndpoint(base, candidate, timeout) { const path = normalizePath(candidate.path); const method = String(candidate.method || 'GET').toUpperCase(); const url = https://${base}${path}; const start = Date.now();

try { const response = await got(url, { method, timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '/', }, });

const httpStatus = response.statusCode;
const responseTime = Date.now() - start;
const bodyHash = sha256(response.body);

if (httpStatus === 402) {
  try {
    const responseBody = JSON.parse(response.body);
    if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
      const offer = responseBody.accepts[0];
      const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
      const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1_000_000).toFixed(6)}` : '';
      return {
        domain: base,
        path,
        status: 'success',
        x402Version: String(responseBody.x402Version || ''),
        price: rawAmount,
        priceReadable,
        network: offer.network || candidate.network || '',
        asset: offer.asset || candidate.asset || '',
        payTo: offer.payTo || candidate.payTo || '',
        label: offer.label || candidate.label || '',
        description: offer.description || candidate.description || '',
        httpStatus: String(httpStatus),
        responseTimeMs: String(responseTime),
        errorMessage: '',
        timestamp: new Date().toISOString(),
        auditHash: bodyHash,
      };
    }
  } catch {
    // fall through to public_info
  }
}

const rawPrice = candidate.rawPrice || '';
const priceReadable = rawPrice ? `$${(parseInt(rawPrice, 10) / 1_000_000).toFixed(6)}` : '';

return {
  domain: base,
  path,
  status: 'public_info',
  x402Version: '',
  price: rawPrice,
  priceReadable,
  network: candidate.network || '',
  asset: candidate.asset || '',
  payTo: candidate.payTo || '',
  label: candidate.label || '',
  description: candidate.description || '',
  httpStatus: String(httpStatus),
  responseTimeMs: String(responseTime),
  errorMessage: '',
  timestamp: new Date().toISOString(),
  auditHash: bodyHash,
};

} catch (err) { const responseTime = Date.now() - start; return { domain: base, path, status: classifyError(err.message), x402Version: '', price: '', priceReadable: '', network: candidate.network || '', asset: candidate.asset || '', payTo: candidate.payTo || '', label: candidate.label || '', description: candidate.description || '', httpStatus: '0', responseTimeMs: String(responseTime), errorMessage: err.message, timestamp: new Date().toISOString(), auditHash: '', }; } }

// ============================================================ // Main // ============================================================ const input = await Actor.getInput() || {}; let { domain, paths: manualPaths, maxPaths = DEFAULT_MAX_PATHS, timeout = DEFAULT_TIMEOUT, includeSubdomains = false, useResidentialProxy = false, } = input;

if (!domain) { await Actor.fail('Domain is required.'); await Actor.exit(); }

domain = normalizeDomain(domain); const targetDomains = [domain]; if (includeSubdomains) targetDomains.push(api.${domain});

const allResults = []; const dict = await loadDictionary(); const manualList = parsePathsInput(manualPaths); const pathsToUse = manualList.length > 0 ? manualList : dict.slice(0, maxPaths);

console.log([SDS] Domain: ${domain}); console.log([SDS] Targets: ${targetDomains.join(', ')}); console.log([SDS] Paths to try: ${pathsToUse.length}); console.log([SDS] Residential proxy: ${Boolean(useResidentialProxy)});

for (const base of targetDomains) { let candidates = null;

candidates = await discoverFromWellKnownAgent(base, timeout); if (!candidates) candidates = await discoverFromWellKnownX402(base, timeout); if (!candidates) candidates = await discoverFromOpenAPI(base, timeout); if (!candidates) candidates = await discoverFromHealth(base, timeout); if (!candidates) candidates = await discoverFromScraper(base, timeout);

if (!candidates) { await logFailure(base, 'all-methods', { reason: 'Falling back to dictionary' }); candidates = pathsToUse.map((p) => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary' })); }

candidates = candidates .map(normalizeCandidate) .filter(isValidCandidate); candidates = uniqCandidates(candidates);

console.log([SDS] ${base} candidates: ${candidates.length});

// Parallel verification with a small concurrency cap const queue = [...candidates]; const verified = [];

async function worker() { while (queue.length > 0) { const item = queue.shift(); if (!item) continue; const result = await checkEndpoint(base, item, timeout); verified.push(result); } }

const workerCount = Math.min(DEFAULT_CONCURRENCY, Math.max(1, candidates.length)); await Promise.all(Array.from({ length: workerCount }, () => worker()));

for (const row of verified) { if (!row) continue; allResults.push(row); } }

const finalResults = allResults.map((row) => ({ ...row, download_docx: '', download_pdf: '', }));

const docxBuffer = await generateDOCX(domain, finalResults); const pdfBuffer = await generatePDF(domain, finalResults); const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); const pdfUrl = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');

const output = finalResults.map((row) => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl, }));

await Actor.pushData(output); console.log(Scan complete. ${output.length} endpoints found.); await Actor.exit();