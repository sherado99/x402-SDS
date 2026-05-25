import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import got from 'got';
import crypto from 'crypto';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';

await Actor.init();

// ========== HELPERS ==========
const BUILT_IN_DICTIONARY = [
  '/x402/', '/x402/sapi', '/x402/spdet', '/x402/scdft', '/x402/v1/', '/x402/payment',
  '/x402/checkout', '/x402/status', '/x402/health', '/x402/invoice', '/x402/balance',
  '/x402/webhook', '/x402/callback', '/x402/token', '/x402/auth', '/x402/order',
  '/x402/subscription', '/x402/usage', '/x402/rate', '/x402/quote', '/api/x402/',
  '/api/x402/payment', '/api/x402/status', '/api/x402/webhook', '/v1/x402',
  '/v1/x402/payment', '/v2/x402', '/.well-known/x402',
];

function normalizeDomain(d) {
  return d.replace(/\/+$/, '').trim();
}

function sha256(raw) {
  return crypto.createHash('sha256').update(raw || '').digest('hex');
}

function normalizePath(rawPath) {
  let p = rawPath || '';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try {
      const url = new URL(p);
      p = url.pathname + (url.search || '');
    } catch (e) { /* keep as-is */ }
  }
  p = p.replace(/^\/api(?=\/)/i, '');
  return p.replace(/\/+$/, '').toLowerCase();
}

// ========== FAILURE LOGGING ==========
async function logFailure(base, stage, details) {
  try {
    const dataset = await Actor.openDataset('failed-scans');
    await dataset.pushData({
      domain: base,
      stage,
      timestamp: new Date().toISOString(),
      ...details,
    });
    console.log(`[FAIL-LOG] ${stage} failure logged for ${base}`);
  } catch (err) {
    console.error(`[FAIL-LOG] Error logging failure: ${err.message}`);
  }
}

// ========== DOCX/PDF GENERATION ==========
async function generateDOCX(domain, results) {
  const children = [
    new Paragraph({ text: 'X402 Domain Scan Report', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    new Paragraph({ text: `Domain: ${domain}`, spacing: { after: 60 } }),
    new Paragraph({ text: `Scan time: ${new Date().toISOString()}`, spacing: { after: 200 } }),
  ];

  if (results.length === 0) {
    children.push(new Paragraph({ text: 'No public X402 information found on this domain.', spacing: { after: 120 } }));
  } else {
    for (const row of results) {
      children.push(new Paragraph({ text: `${row.path} [${row.status}]`, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 60 } }));
      if (row.status === 'success' || row.status === 'public_info') {
        if (row.priceReadable) children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
        if (row.label) children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
        if (row.asset) children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
        if (row.payTo) children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
        if (row.description) children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
        if (row.auditHash) children.push(new Paragraph({ text: `Audit Hash: ${row.auditHash}`, spacing: { after: 40 } }));
      } else if (row.errorMessage) {
        children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
      }
      children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return await Packer.toBuffer(doc);
}

async function generatePDF(domain, results) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

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
        if (row.status === 'success' || row.status === 'public_info') {
          if (row.priceReadable) doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
          if (row.label) doc.fontSize(10).text(`Label: ${row.label}`);
          if (row.asset) doc.fontSize(10).text(`Asset: ${row.asset}`);
          if (row.payTo) doc.fontSize(10).text(`Pay To: ${row.payTo}`);
          if (row.description) doc.fontSize(10).text(`Description: ${row.description}`);
          if (row.auditHash) doc.fontSize(10).text(`Audit Hash: ${row.auditHash}`);
        } else if (row.errorMessage) {
          doc.fontSize(10).text(`Error: ${row.errorMessage}`);
        }
        doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`);
        doc.moveDown(0.5);
      }
    }

    doc.end();
  });
}

async function saveFileToKVS(filename, buffer, contentType) {
  const store = await Actor.openKeyValueStore();
  await store.setValue(filename, buffer, { contentType });
  return `https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true`;
}

// ========== DETERMINISTIC DISCOVERY ==========

async function discoverFromWellKnownAgent(base, timeout) {
  const paths = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/.well-known/agent-services.json'];
  for (const wkPath of paths) {
    try {
      const response = await got(`https://${base}${wkPath}`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
      if (response.statusCode !== 200) {
        await logFailure(base, `agent-card:${wkPath}`, {
          httpStatus: response.statusCode,
          contentType: response.headers['content-type'],
          bodyPreview: response.body?.substring(0, 1000),
          reason: `Non-200 status: ${response.statusCode}`
        });
        continue;
      }
      const data = JSON.parse(response.body);
      const candidates = [];
      const services = data.skills || data.services || data.endpoints || [];
      for (const svc of services) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        candidates.push({
          path, method: svc.method || 'GET', body: null, source: wkPath,
          rawPrice: String(svc.price || svc.cost || ''), network: svc.network || '',
          asset: svc.asset || '', label: svc.name || svc.id || '', description: svc.description || '',
        });
      }
      if (candidates.length > 0) return candidates;
    } catch (err) {
      console.log(`[AGENT-CARD] ${wkPath} error: ${err.message}`);
      await logFailure(base, `agent-card:${wkPath}`, {
        error: err.message,
        reason: 'Parse or network error'
      });
    }
  }
  return null;
}

async function discoverFromWellKnownX402(base, timeout) {
  try {
    const response = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (response.statusCode !== 200) {
      await logFailure(base, 'well-known-x402', {
        httpStatus: response.statusCode,
        contentType: response.headers['content-type'],
        bodyPreview: response.body?.substring(0, 1000),
        reason: `Non-200 status: ${response.statusCode}`
      });
      return null;
    }
    const data = JSON.parse(response.body);
    const candidates = [];

    const extractPrice = (pricing) => {
      if (!pricing) return '';
      if (typeof pricing.price === 'number') return String(Math.round(pricing.price * 1000000));
      if (typeof pricing.price === 'string') { const m = pricing.price.match(/\$?([\d.]+)/); if (m) return String(Math.round(parseFloat(m[1]) * 1000000)); }
      if (typeof pricing.pricePerSource === 'number') return String(Math.round(pricing.pricePerSource * 1000000));
      if (typeof pricing.inputPerMillionTokens === 'number') return String(Math.round(pricing.inputPerMillionTokens * 1000000));
      if (typeof pricing.pricePerCall === 'number') return String(Math.round(pricing.pricePerCall * 1000000));
      if (typeof pricing.perRequest === 'number') return String(Math.round(pricing.perRequest * 1000000));
      if (typeof pricing.pricePerImage === 'number') return String(Math.round(pricing.pricePerImage * 1000000));
      return '';
    };

    if (data.resources && Array.isArray(data.resources)) {
      for (const res of data.resources) {
        if (typeof res === 'object' && res.path) {
          candidates.push({ path: res.path, method: res.method || 'GET', body: null, source: '/.well-known/x402', rawPrice: extractPrice(res.pricing || res), network: res.network || data.network || '', asset: res.asset || data.asset || '', label: res.name || res.id || '', description: res.description || '' });
        } else if (typeof res === 'string') {
          const parts = res.trim().split(' ');
          const method = parts.length > 1 ? parts[0] : 'GET';
          const path = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
          candidates.push({ path, method, body: null, source: '/.well-known/x402', rawPrice: '', network: data.network || '', asset: data.asset || '', label: path, description: '' });
        }
      }
    }

    if (data.resourceDetails && Array.isArray(data.resourceDetails)) {
      for (const detail of data.resourceDetails) {
        if (detail.path || detail.endpoint) {
          candidates.push({ path: detail.path || detail.endpoint, method: detail.method || 'GET', body: null, source: '/.well-known/x402', rawPrice: extractPrice(detail.pricing || detail), network: detail.network || data.network || '', asset: detail.asset || data.asset || '', label: detail.name || detail.label || detail.path || '', description: detail.description || '' });
        }
      }
    }

    if (data.services && Array.isArray(data.services)) {
      for (const svc of data.services) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        let rawPrice = extractPrice(svc.pricing || svc.price || {});
        if (!rawPrice && svc.models && Array.isArray(svc.models) && svc.models.length > 0) {
          rawPrice = extractPrice(svc.models[0].pricing || svc.models[0].price || {});
        }
        const payment = svc.payment || {};
        candidates.push({ path, method: svc.method || 'POST', body: null, source: '/.well-known/x402', rawPrice, network: payment.network || svc.network || data.network || '', asset: payment.asset || svc.asset || data.asset || '', label: svc.name || svc.id || svc.label || '', description: svc.description || '' });
      }
    }

    const unique = []; const seen = new Set();
    for (const c of candidates) { const key = `${c.path}|${c.method}`; if (!seen.has(key)) { seen.add(key); unique.push(c); } }
    return unique.length > 0 ? unique : null;
  } catch (err) {
    console.log(`[WELL-KNOWN-X402] Error: ${err.message}`);
    await logFailure(base, 'well-known-x402', {
      error: err.message,
      reason: 'Parse or network error'
    });
    return null;
  }
}

async function discoverFromOpenAPI(base, timeout) {
  const openApiPaths = ['/openapi.json', '/swagger.json', '/api-docs.json', '/v3/api-docs'];
  for (const apiPath of openApiPaths) {
    try {
      const response = await got(`https://${base}${apiPath}`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
      if (response.statusCode !== 200) {
        await logFailure(base, `openapi:${apiPath}`, {
          httpStatus: response.statusCode,
          contentType: response.headers['content-type'],
          bodyPreview: response.body?.substring(0, 1000),
          reason: `Non-200 status: ${response.statusCode}`
        });
        continue;
      }
      const spec = JSON.parse(response.body);
      if (!spec.paths) continue;
      const candidates = [];
      for (const [path, methods] of Object.entries(spec.paths)) {
        const method = Object.keys(methods)[0] || 'GET';
        const operation = methods[method];
        let price = '', network = '', asset = '', description = '';
        if (operation['x-payment-info']) { const pi = operation['x-payment-info']; price = String(pi.price || pi.amount || ''); network = pi.network || ''; asset = pi.asset || pi.token || ''; description = pi.description || ''; }
        const resp402 = operation.responses?.['402'];
        if (resp402?.content?.['application/json']?.example?.accepts) {
          const offer = resp402.content['application/json'].example.accepts[0] || {};
          price = price || String(offer.maxAmountRequired || offer.amount || ''); network = network || offer.network || ''; asset = asset || offer.asset || ''; description = description || offer.description || operation.description || '';
        }
        if (!price && spec['x-payment-info']) { const pi = spec['x-payment-info']; price = String(pi.price || ''); network = network || pi.network || ''; asset = asset || pi.asset || ''; }
        candidates.push({ path, method: method.toUpperCase(), body: null, source: apiPath, rawPrice: price, network, asset, label: operation.summary || operation.operationId || '', description: description || operation.description || '' });
      }
      return candidates.length > 0 ? candidates : null;
    } catch (err) {
      console.log(`[OPENAPI] ${apiPath} error: ${err.message}`);
      await logFailure(base, `openapi:${apiPath}`, {
        error: err.message,
        reason: 'Parse or network error'
      });
    }
  }
  return null;
}

async function discoverFromHealth(base, timeout) {
  try {
    const response = await got(`https://${base}/health`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (response.statusCode !== 200) {
      await logFailure(base, 'health', {
        httpStatus: response.statusCode,
        contentType: response.headers['content-type'],
        bodyPreview: response.body?.substring(0, 1000),
        reason: `Non-200 status: ${response.statusCode}`
      });
      return null;
    }
    const data = JSON.parse(response.body);
    const candidates = [];
    if (data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)) {
      for (const [path, info] of Object.entries(data.endpoints)) {
        if (!path) continue;
        let rawPrice = ''; const network = data.network || '';
        if (typeof info.price === 'string') { const match = info.price.match(/\$([\d.]+)/); if (match) { rawPrice = String(Math.round(parseFloat(match[1]) * 1000000)); } else if (info.price === 'free' || info.price === '0') { rawPrice = '0'; } }
        else if (typeof info.price === 'number') { rawPrice = String(info.price); }
        candidates.push({ path, method: 'GET', body: null, source: '/health', rawPrice, network, asset: '', label: info.description || path, description: info.description || '' });
      }
    }
    if (Array.isArray(data.endpoints)) {
      for (const svc of data.endpoints) {
        const path = svc.endpoint || svc.path || svc.url; if (!path) continue;
        candidates.push({ path, method: svc.method || 'GET', body: null, source: '/health', rawPrice: String(svc.price || svc.x402Price || ''), network: svc.network || data.network || '', asset: svc.asset || '', label: svc.name || svc.id || svc.description || '', description: svc.description || '' });
      }
    }
    return candidates.length > 0 ? candidates : null;
  } catch (err) {
    console.log(`[HEALTH] Error: ${err.message}`);
    await logFailure(base, 'health', {
      error: err.message,
      reason: 'Parse or network error'
    });
    return null;
  }
}

// ========== SDS HELPER WITH DEEP LOGGING ==========
async function callSDS(content, timeout, sourceLabel = 'unknown') {
  const finalContent = content.substring(0, 15000);
  console.log(`[SDS-CALL] Sending ${finalContent.length} chars to SDS from ${sourceLabel}`);
  console.log(`[SDS-CALL] Content preview (first 500): ${finalContent.substring(0, 500)}`);
  
  let sdsResponse;
  try {
    sdsResponse = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
      json: { content: finalContent }, timeout: { request: timeout }, throwHttpErrors: false,
    });
  } catch (err) {
    console.error(`[SDS-CALL] Network error: ${err.message}`);
    return [];
  }
  
  console.log(`[SDS-CALL] Response status: ${sdsResponse.statusCode}`);
  console.log(`[SDS-CALL] Response body preview: ${sdsResponse.body?.substring(0, 500)}`);
  
  if (sdsResponse.statusCode !== 200) {
    console.error(`[SDS-CALL] Non-200 status: ${sdsResponse.statusCode}`);
    return [];
  }
  
  try {
    const parsed = JSON.parse(sdsResponse.body);
    console.log(`[SDS-CALL] Parsed ${parsed.length} endpoints`);
    return parsed;
  } catch (err) {
    console.error(`[SDS-CALL] JSON parse error: ${err.message}`);
    return [];
  }
}

// ========== ENRICHMENT ==========
async function enrichCandidatesWithAI(candidates, base, timeout) {
  console.log('[ENRICH] Trying to enrich candidates...');

  // Priority 1: /llms.txt
console.log('[ENRICH] Fetching /llms.txt...');
let rawContent = '';
try {
  const llmsRes = await got(`https://${base}/llms.txt`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
  console.log(`[ENRICH] /llms.txt status: ${llmsRes.statusCode}, length: ${llmsRes.body?.length || 0}`);
  if (llmsRes.statusCode === 200) rawContent = llmsRes.body;
} catch (err) {
  console.error(`[ENRICH] /llms.txt fetch error: ${err.message}`);
}
if (rawContent) {
  const aiEndpoints = await callSDS(rawContent, 30000, 'llms.txt');
  console.log(`[ENRICH] /llms.txt: SDS returned ${aiEndpoints.length} endpoints`);
  if (aiEndpoints.length > 0) {
    applyEnrichment(candidates, aiEndpoints);
  }
} else {
  console.log('[ENRICH] /llms.txt not available or empty');
}

  // Priority 2: /.well-known/x402
  console.log('[ENRICH] Fetching /.well-known/x402...');
  rawContent = '';
  try {
    const wkRes = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (wkRes.statusCode === 200) rawContent = wkRes.body;
  } catch (err) {}
  if (rawContent) {
    const aiEndpoints = await callSDS(rawContent, 30000);
    console.log(`[ENRICH] /.well-known/x402: SDS returned ${aiEndpoints.length} endpoints`);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
    }
  }

  // Priority 3: /health
  console.log('[ENRICH] Fetching /health...');
  rawContent = '';
  try {
    const healthRes = await got(`https://${base}/health`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (healthRes.statusCode === 200) rawContent = healthRes.body;
  } catch (err) {}
  if (rawContent) {
    const aiEndpoints = await callSDS(rawContent, 30000);
    console.log(`[ENRICH] /health: SDS returned ${aiEndpoints.length} endpoints`);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
    }
  }

  // Priority 4: Static HTML scraper (Cheerio)
  console.log('[ENRICH] Running static HTML scraper...');
  const staticPages = await scrapeStaticPages(base, timeout);
  if (staticPages.length > 0) {
    let combinedHTML = '';
    for (const page of staticPages) {
      combinedHTML += `\n--- From ${page.url} ---\n${page.html.substring(0, 15000)}`;
    }
    const aiEndpoints = await callSDS(combinedHTML, 60000);
    console.log(`[ENRICH] Static scraper: SDS returned ${aiEndpoints.length} endpoints`);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
    }
  }

  return candidates;
}

// ========== STATIC SCRAPER ==========
async function scrapeStaticPages(base, timeout) {
  const startUrls = [
    `https://${base}`,
    `https://${base}/docs`,
    `https://${base}/api`,
    `https://${base}/developers`,
    `https://${base}/pricing`
  ];
  const discoveredHTML = new Set();
  const keywords = [
    'x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method',
    'price', 'post /', 'get /', 'base url', 'api reference', 'pricing summary'
  ];

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, $, enqueueLinks }) {
      const bodyText = $('body').text().toLowerCase();
      const matched = keywords.filter(kw => bodyText.includes(kw));
      if (matched.length > 0) {
        discoveredHTML.add({ url: request.url, html: $.html() });
        console.log(`[STATIC-SCRAPER] Found: ${request.url}`);
      } else {
        await logFailure(base, 'static-scraper', {
          url: request.url,
          reason: 'No relevant keywords found in static HTML',
          bodyPreview: bodyText.substring(0, 1000),
          missingKeywords: keywords.filter(kw => !bodyText.includes(kw)).join(', '),
        });
      }
      await enqueueLinks({
        transformRequestFunction(req) {
          const linkText = ($(`a[href="${req.url}"]`).text() || '').toLowerCase();
          if (keywords.some(kw => linkText.includes(kw))) return req;
          return false;
        },
      });
    },
  });
  await crawler.run(startUrls);
  return [...discoveredHTML];
}

// ========== DISCOVERY FALLBACKS ==========
async function discoverWithAI(domain, base, timeout) {
  // Priority 1: /llms.txt
  try {
    const llmsRes = await got(`https://${base}/llms.txt`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (llmsRes.statusCode === 200 && llmsRes.body) {
      const endpoints = await callSDS(llmsRes.body, 30000);
      if (endpoints.length > 0) {
        return endpoints.map(ep => ({
          path: ep.path, method: ep.method || 'GET', body: null, source: 'sds-ai',
          rawPrice: String(Math.round((ep.price || 0) * 1000000)), network: ep.network || '', asset: ep.asset || '',
          label: ep.label || ep.path, description: ep.description || '',
        }));
      }
    }
  } catch (err) {}

  // Priority 2: /.well-known/x402
  try {
    const wkRes = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (wkRes.statusCode === 200 && wkRes.body) {
      const endpoints = await callSDS(wkRes.body, 30000);
      if (endpoints.length > 0) {
        return endpoints.map(ep => ({
          path: ep.path, method: ep.method || 'GET', body: null, source: 'sds-ai',
          rawPrice: String(Math.round((ep.price || 0) * 1000000)), network: ep.network || '', asset: ep.asset || '',
          label: ep.label || ep.path, description: ep.description || '',
        }));
      }
    }
  } catch (err) {}

  // Priority 3: agent-card
  const agentPaths = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/.well-known/agent-services.json'];
  for (const ap of agentPaths) {
    try {
      const agentRes = await got(`https://${base}${ap}`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
      if (agentRes.statusCode === 200 && agentRes.body) {
        const endpoints = await callSDS(agentRes.body, 30000);
        if (endpoints.length > 0) {
          return endpoints.map(ep => ({
            path: ep.path, method: ep.method || 'GET', body: null, source: 'sds-ai',
            rawPrice: String(Math.round((ep.price || 0) * 1000000)), network: ep.network || '', asset: ep.asset || '',
            label: ep.label || ep.path, description: ep.description || '',
          }));
        }
      }
    } catch (err) {}
  }

  return null;
}

async function discoverWithScraper(domain, base, timeout) {
  const staticPages = await scrapeStaticPages(base, timeout);
  if (staticPages.length === 0) return null;

  let combinedHTML = '';
  for (const page of staticPages) {
    combinedHTML += `\n--- From ${page.url} ---\n${page.html.substring(0, 15000)}`;
  }
  const endpoints = await callSDS(combinedHTML.substring(0, 15000), 60000);
  if (endpoints.length > 0) {
    return endpoints.map(ep => ({
      path: ep.path, method: ep.method || 'GET', body: null, source: 'scraper-ai',
      rawPrice: String(Math.round((ep.price || 0) * 1000000)), network: ep.network || '', asset: ep.asset || '',
      label: ep.label || ep.path, description: ep.description || '',
    }));
  }
  return null;
}

// ========== ENDPOINT VERIFICATION ==========
async function checkEndpoint(base, candidate, timeout) {
  let { path, method = 'GET' } = candidate;

  if (path && (path.startsWith('http://') || path.startsWith('https://'))) {
    try {
      const parsed = new URL(path);
      path = parsed.pathname + (parsed.search || '');
    } catch (e) {}
  }

  const url = `https://${base}${path}`;
  const start = Date.now();
  try {
    const response = await got(url, { method, timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
    const httpStatus = response.statusCode; const responseTime = Date.now() - start;
    const bodyHash = sha256(response.body);

    if (httpStatus === 402) {
      try {
        const responseBody = JSON.parse(response.body);
        if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
          const offer = responseBody.accepts[0];
          const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
          const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1000000).toFixed(6)}` : '';
          return { domain: base, path, status: 'success', x402Version: String(responseBody.x402Version || ''), price: rawAmount, priceReadable, network: offer.network || candidate.network || '', asset: offer.asset || candidate.asset || '', payTo: offer.payTo || candidate.payTo || '', label: offer.label || candidate.label || '', description: offer.description || candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString(), auditHash: bodyHash };
        }
      } catch (err) {}
    }

    const rawPrice = candidate.rawPrice || '';
    const priceReadable = rawPrice ? `$${(parseInt(rawPrice, 10) / 1000000).toFixed(6)}` : '';
    return { domain: base, path, status: 'public_info', x402Version: '', price: rawPrice, priceReadable, network: candidate.network || '', asset: candidate.asset || '', payTo: candidate.payTo || '', label: candidate.label || '', description: candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString(), auditHash: bodyHash };
  } catch (err) {
    return { domain: base, path, status: 'error', x402Version: '', price: '', priceReadable: '', network: '', asset: '', payTo: candidate.payTo || '', label: candidate.label || '', description: candidate.description || '', httpStatus: '0', responseTimeMs: String(Date.now() - start), errorMessage: err.message, timestamp: new Date().toISOString(), auditHash: '' };
  }
}

// ========== MAIN ==========
const input = await Actor.getInput();
let { domain, paths: manualPaths, maxPaths = 100, timeout = 5000, includeSubdomains = false } = input;
if (!domain) { await Actor.fail('Domain is required.'); await Actor.exit(); }

domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
const targetDomains = [normalizeDomain(domain)];
if (includeSubdomains) targetDomains.push(`api.${normalizeDomain(domain)}`);

const results = [];

for (const base of targetDomains) {
  let scanList = [];

  if (manualPaths && manualPaths.trim()) {
    const paths = manualPaths.split('\n').map(p => p.trim()).filter(p => p);
    scanList = paths.map(p => ({ path: p, method: 'GET', body: null }));
  } else {
    console.log(`[DISCOVERY] Starting for ${base}`);

    // 1. Deterministic
    let candidates = await discoverFromWellKnownAgent(base, timeout);
    if (!candidates) candidates = await discoverFromWellKnownX402(base, timeout);
    if (!candidates) candidates = await discoverFromOpenAPI(base, timeout);
    if (!candidates) candidates = await discoverFromHealth(base, timeout);

    if (candidates && candidates.length > 0) {
      // 1b. Enrich via SDS
      candidates = await enrichCandidatesWithAI(candidates, base, timeout);
      scanList = candidates;
      console.log(`[DISCOVERY] Deterministic + Enrich: ${candidates.length} endpoints`);
    } else {
      // 2. AI discovery
      candidates = await discoverWithAI(domain, base, timeout);
      if (candidates && candidates.length > 0) {
        scanList = candidates;
        console.log(`[DISCOVERY] AI found ${candidates.length} endpoints`);
      } else {
        // 3. Scraper
        candidates = await discoverWithScraper(domain, base, timeout);
        if (candidates && candidates.length > 0) {
          scanList = candidates;
          console.log(`[DISCOVERY] Scraper found ${candidates.length} endpoints`);
        } else {
          // 4. Dictionary fallback
          await logFailure(base, 'all-methods', {
            reason: 'All discovery methods exhausted, falling back to dictionary',
          });
          console.log('[DISCOVERY] Falling back to dictionary');
          scanList = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => ({ path: p, method: 'GET', body: null }));
        }
      }
    }
  }

  for (const item of scanList) {
    if (!item.path || item.path === '/') continue;
    const result = await checkEndpoint(base, item, timeout);
    if (result) results.push(result);
  }
}

// ========== GENERATE REPORTS ==========
const docxBuffer = await generateDOCX(domain, results);
const pdfBuffer = await generatePDF(domain, results);
const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');

const finalOutput = results.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));
await Actor.pushData(finalOutput);
console.log(`Scan complete. ${finalOutput.length} endpoints found.`);

await Actor.exit();
