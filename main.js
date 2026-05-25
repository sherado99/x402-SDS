import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import got from 'got';
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
      if (response.statusCode !== 200) continue;
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
    } catch (err) { console.log(`[AGENT-CARD] ${wkPath} error: ${err.message}`); }
  }
  return null;
}

async function discoverFromWellKnownX402(base, timeout) {
  try {
    const response = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (response.statusCode !== 200) return null;
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
  } catch (err) { console.log(`[WELL-KNOWN-X402] Error: ${err.message}`); return null; }
}

async function discoverFromOpenAPI(base, timeout) {
  const openApiPaths = ['/openapi.json', '/swagger.json', '/api-docs.json', '/v3/api-docs'];
  for (const apiPath of openApiPaths) {
    try {
      const response = await got(`https://${base}${apiPath}`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
      if (response.statusCode !== 200) continue;
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
    } catch (err) { console.log(`[OPENAPI] ${apiPath} error: ${err.message}`); }
  }
  return null;
}

async function discoverFromHealth(base, timeout) {
  try {
    const response = await got(`https://${base}/health`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (response.statusCode !== 200) return null;
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
  } catch (err) { console.log(`[HEALTH] Error: ${err.message}`); return null; }
}

// ========== AI DISCOVERY via SDS (umum) ==========

function filterRelevantContent(rawContent, maxLength = 6000) {
  // Tiga kata kunci: nama/deskripsi, path, harga
  const nameKeywords = ['service', 'agent', 'api', 'endpoint', 'description', 'label', 'name'];
  const pathKeywords = ['/api/', '/v1/', '/x402/', '/verify/', '/proxy/', '/summarize', '/translate', 'path', 'endpoint', 'url'];
  const priceKeywords = ['$0.', '$1.', 'usdc', 'price', 'pricing', 'amount', 'free'];

  const lowerContent = rawContent.toLowerCase();
  
  // Cek apakah setidaknya dua dari tiga kategori muncul
  const hasName = nameKeywords.some(kw => lowerContent.includes(kw));
  const hasPath = pathKeywords.some(kw => lowerContent.includes(kw));
  const hasPrice = priceKeywords.some(kw => lowerContent.includes(kw));

  if (!hasName || !hasPath || !hasPrice) return null;

  if (rawContent.length <= maxLength) return rawContent;

  // Potong dengan cerdas: ambil baris yang mengandung setidaknya dua kategori
  const lines = rawContent.split('\n');
  const relevantLines = lines.filter(line => {
    const lowerLine = line.toLowerCase();
    const hasN = nameKeywords.some(kw => lowerLine.includes(kw));
    const hasP = pathKeywords.some(kw => lowerLine.includes(kw));
    const hasPr = priceKeywords.some(kw => lowerLine.includes(kw));
    return (hasN && hasP) || (hasN && hasPr) || (hasP && hasPr);
  });
  
  return relevantLines.join('\n').substring(0, maxLength);
}

async function callSDS(content, timeout) {
  const finalContent = content.substring(0, 15000);
  const sdsResponse = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
    json: { content: finalContent }, timeout: { request: timeout }, throwHttpErrors: false,
  });
  if (sdsResponse.statusCode !== 200) return [];
  return JSON.parse(sdsResponse.body);
}

async function discoverWithAI(domain, base, timeout) {
  try {
    // Coba ambil well-known/x402
    const wkResponse = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (wkResponse.statusCode === 200) {
      const data = JSON.parse(wkResponse.body);
      // Jika ada services, kirim models dari layanan pertama
      if (data.services && Array.isArray(data.services)) {
        const serviceWithModels = data.services.find(svc => svc.models && Array.isArray(svc.models) && svc.models.length > 0);
        if (serviceWithModels) {
          const modelsContent = JSON.stringify({ endpoint: serviceWithModels.endpoint, models: serviceWithModels.models.slice(0, 10) });
          console.log(`[AI-DISCOVERY] Sending models array: ${modelsContent.length} chars`);
          const models = await callSDS(modelsContent, 30000);
          if (models.length > 0) {
            const candidates = [];
            for (const svc of data.services.slice(0, 10)) {
              if (svc.models && Array.isArray(svc.models)) {
                for (const model of svc.models) {
                  const aiModel = models.find(m => m.label && m.label.includes(model.name || model.id || ''));
                  candidates.push({
                    path: svc.endpoint || svc.path || '', method: svc.method || 'POST', body: null, source: 'sds-ai',
                    rawPrice: aiModel ? String(Math.round((aiModel.price || 0) * 1000000)) : '',
                    network: (svc.payment || {}).network || data.network || '', asset: (svc.payment || {}).asset || data.asset || '',
                    label: `${svc.name || ''} - ${model.name || model.id || ''}`, description: model.description || svc.description || '',
                  });
                }
              } else {
                candidates.push({
                  path: svc.endpoint || svc.path || '', method: svc.method || 'POST', body: null, source: 'sds-ai',
                  rawPrice: '', network: (svc.payment || {}).network || data.network || '', asset: (svc.payment || {}).asset || data.asset || '',
                  label: svc.name || svc.id || '', description: svc.description || '',
                });
              }
            }
            if (candidates.length > 0) return candidates;
          }
        }
      }
    }

    // Fallback umum: kumpulkan konten dari berbagai sumber
    const discoveryUrls = [
      `https://${base}/.well-known/agent-card.json`, `https://${base}/.well-known/agent.json`,
      `https://${base}/.well-known/agent-services.json`, `https://${base}/.well-known/x402`,
      `https://${base}/openapi.json`, `https://${base}/health`,
    ];
    let combinedContent = '';
    for (const url of discoveryUrls) {
      try {
        const resp = await got(url, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
        if (resp.statusCode === 200) {
          const filtered = filterRelevantContent(resp.body, 6000);
          if (filtered) combinedContent += `\n--- From ${url} ---\n${filtered}`;
        }
      } catch (err) {}
    }
    if (combinedContent.trim()) {
      const endpoints = await callSDS(combinedContent, 60000);
      if (endpoints.length > 0) {
        return endpoints.map(ep => ({
          path: ep.path, method: ep.method || 'GET', body: null, source: 'sds-ai',
          rawPrice: String(Math.round((ep.price || 0) * 1000000)), network: ep.network || '', asset: ep.asset || '',
          label: ep.label || ep.path, description: ep.description || '',
        }));
      }
    }

    return null;
  } catch (err) { console.log(`[AI-DISCOVERY] Error: ${err.message}`); return null; }
}

// ========== SCRAPER UNTUK DOMAIN HTML ==========
async function scrapeHTMLPages(domain, base, timeout) {
  const startUrls = [`https://${base}`, `https://${base}/docs`, `https://${base}/api`, `https://${base}/developers`];
  const discoveredHTML = new Set();

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20, requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, $, enqueueLinks }) {
      const bodyText = $('body').text();
      if (bodyText.toLowerCase().includes('x402') || bodyText.toLowerCase().includes('agent') || bodyText.toLowerCase().includes('payment')) {
        discoveredHTML.add({ url: request.url, html: $.html().substring(0, 12000) });
        console.log(`[SCRAPER] Found relevant HTML: ${request.url}`);
        await enqueueLinks({
          transformRequestFunction(req) {
            const linkText = $(`a[href="${req.url}"]`).text() || '';
            if (linkText.toLowerCase().includes('api') || linkText.toLowerCase().includes('x402') || linkText.toLowerCase().includes('payment')) return req;
            return false;
          },
        });
      }
    },
  });
  await crawler.run(startUrls);
  return [...discoveredHTML];
}

async function discoverWithScraper(domain, base, timeout) {
  const htmlPages = await scrapeHTMLPages(domain, base, timeout);
  if (htmlPages.length === 0) return null;

  let combinedHTML = '';
  for (const page of htmlPages) {
    combinedHTML += `\n--- From ${page.url} ---\n${page.html}`;
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

  // ✅ Pembersihan: kalau path masih berbentuk URL lengkap, ambil bagian path-nya saja
  if (path && (path.startsWith('http://') || path.startsWith('https://'))) {
    try {
      const parsed = new URL(path);
      path = parsed.pathname + (parsed.search || '');
    } catch (e) {
      // Jika gagal di-parse, biarkan apa adanya
    }
  }

  const url = `https://${base}${path}`;
  const start = Date.now();
  try {
    const response = await got(url, { method, timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 }, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
    const httpStatus = response.statusCode; const responseTime = Date.now() - start;

    if (httpStatus === 402) {
      try {
        const responseBody = JSON.parse(response.body);
        if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
          const offer = responseBody.accepts[0];
          const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
          const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1000000).toFixed(6)}` : '';
          return { domain: base, path, status: 'success', x402Version: String(responseBody.x402Version || ''), price: rawAmount, priceReadable, network: offer.network || candidate.network || '', asset: offer.asset || candidate.asset || '', payTo: offer.payTo || '', label: offer.label || candidate.label || '', description: offer.description || candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString() };
        }
      } catch (err) {}
    }

    // Tampilkan sebagai public_info (harga opsional)
    const rawPrice = candidate.rawPrice || '';
    const priceReadable = rawPrice ? `$${(parseInt(rawPrice, 10) / 1000000).toFixed(6)}` : '';
    return { domain: base, path, status: 'public_info', x402Version: '', price: rawPrice, priceReadable, network: candidate.network || '', asset: candidate.asset || '', payTo: '', label: candidate.label || '', description: candidate.description || '', httpStatus: String(httpStatus), responseTimeMs: String(responseTime), errorMessage: '', timestamp: new Date().toISOString() };
  } catch (err) {
    console.log(`[CHECK] ${method} ${url} → ${err.message}`);
    return { domain: base, path, status: 'error', x402Version: '', price: '', priceReadable: '', network: '', asset: '', payTo: '', label: candidate.label || '', description: candidate.description || '', httpStatus: '0', responseTimeMs: String(Date.now() - start), errorMessage: err.message, timestamp: new Date().toISOString() };
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
      scanList = candidates;
      console.log(`[DISCOVERY] Deterministic found ${candidates.length} endpoints`);
    } else {
      // 2. AI via SDS
      candidates = await discoverWithAI(domain, base, timeout);
      if (candidates && candidates.length > 0) {
        scanList = candidates;
        console.log(`[DISCOVERY] AI found ${candidates.length} endpoints`);
      } else {
        // 3. Scraper untuk domain HTML
        candidates = await discoverWithScraper(domain, base, timeout);
        if (candidates && candidates.length > 0) {
          scanList = candidates;
          console.log(`[DISCOVERY] Scraper found ${candidates.length} endpoints`);
        } else {
          // 4. Dictionary fallback
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
console.log(`Scan complete. ${finalOutput.length} endpoints found. Public info: ${finalOutput.filter(r => r.status === 'public_info').length}, Success: ${finalOutput.filter(r => r.status === 'success').length}, Error: ${finalOutput.filter(r => r.status === 'error').length}`);

await Actor.exit();
