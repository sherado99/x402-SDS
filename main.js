import { Actor } from 'apify';
import got from 'got';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';

await Actor.init();

// ========== HELPERS ==========

const BUILT_IN_DICTIONARY = [
  '/x402/',
  '/x402/sapi',
  '/x402/spdet',
  '/x402/scdft',
  '/x402/v1/',
  '/x402/payment',
  '/x402/checkout',
  '/x402/status',
  '/x402/health',
  '/x402/invoice',
  '/x402/balance',
  '/x402/webhook',
  '/x402/callback',
  '/x402/token',
  '/x402/auth',
  '/x402/order',
  '/x402/subscription',
  '/x402/usage',
  '/x402/rate',
  '/x402/quote',
  '/api/x402/',
  '/api/x402/payment',
  '/api/x402/status',
  '/api/x402/webhook',
  '/v1/x402',
  '/v1/x402/payment',
  '/v2/x402',
  '/.well-known/x402',
];

function normalizeDomain(d) {
  return d.replace(/\/+$/, '');
}

async function generateDOCX(domain, results) {
  const children = [
    new Paragraph({
      text: 'X402 Domain Scan Report',
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
    }),
    new Paragraph({
      text: `Domain: ${domain}`,
      spacing: { after: 60 },
    }),
    new Paragraph({
      text: `Scan time: ${new Date().toISOString()}`,
      spacing: { after: 200 },
    }),
  ];

  if (results.length === 0) {
    children.push(new Paragraph({
      text: 'No public X402 information found on this domain.',
      spacing: { after: 120 },
    }));
  } else {
    for (const row of results) {
      children.push(new Paragraph({
        text: `${row.path} [${row.status}]`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 60 },
      }));
      if (row.status === 'success' || row.status === 'public_info') {
        children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
      } else if (row.errorMessage) {
        children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
      }
      children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
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
          doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
          doc.fontSize(10).text(`Label: ${row.label}`);
          doc.fontSize(10).text(`Asset: ${row.asset}`);
          doc.fontSize(10).text(`Pay To: ${row.payTo}`);
          doc.fontSize(10).text(`Description: ${row.description}`);
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
  const baseUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true`;
  return baseUrl;
}

// ========== DETERMINISTIC DISCOVERY ==========

async function discoverFromWellKnownAgent(base, timeout) {
  const paths = [
    '/.well-known/agent-card.json',
    '/.well-known/agent.json',
  ];

  for (const wkPath of paths) {
    try {
      const response = await got(`https://${base}${wkPath}`, {
        method: 'GET',
        timeout: { request: timeout },
        throwHttpErrors: false,
        retry: { limit: 0 },
      });
      if (response.statusCode !== 200) continue;

      const data = JSON.parse(response.body);
      const candidates = [];

      const services = data.skills || data.services || data.endpoints || [];
      for (const svc of services) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        candidates.push({
          path,
          method: svc.method || 'GET',
          body: null,
          source: wkPath,
          rawPrice: String(svc.price || svc.cost || ''),
          network: svc.network || '',
          asset: svc.asset || '',
          label: svc.name || svc.id || '',
          description: svc.description || '',
        });
      }

      if (candidates.length > 0) return candidates;
    } catch (err) {
      console.log(`[AGENT-CARD] ${wkPath} error: ${err.message}`);
    }
  }
  return null;
}

async function discoverFromWellKnownX402(base, timeout) {
  try {
    const response = await got(`https://${base}/.well-known/x402`, {
      method: 'GET',
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
    });
    if (response.statusCode !== 200) return null;

    const data = JSON.parse(response.body);
    if (!data.resources || !Array.isArray(data.resources)) return null;

    const candidates = [];
    for (const res of data.resources) {
      if (!res.path) continue;
      candidates.push({
        path: res.path,
        method: 'GET',
        body: null,
        source: '/.well-known/x402',
        rawPrice: String(res.price || ''),
        network: res.network || '',
        asset: res.asset || '',
        label: res.name || res.id || '',
        description: res.description || '',
      });
    }
    return candidates.length > 0 ? candidates : null;
  } catch (err) {
    console.log(`[WELL-KNOWN-X402] Error: ${err.message}`);
    return null;
  }
}

async function discoverFromOpenAPI(base, timeout) {
  const openApiPaths = ['/openapi.json', '/swagger.json', '/api-docs.json', '/v3/api-docs'];

  for (const apiPath of openApiPaths) {
    try {
      const response = await got(`https://${base}${apiPath}`, {
        method: 'GET',
        timeout: { request: timeout },
        throwHttpErrors: false,
        retry: { limit: 0 },
      });
      if (response.statusCode !== 200) continue;

      const spec = JSON.parse(response.body);
      if (!spec.paths) continue;

      const candidates = [];

      for (const [path, methods] of Object.entries(spec.paths)) {
        const method = Object.keys(methods)[0] || 'GET';
        const operation = methods[method];

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

        candidates.push({
          path,
          method: method.toUpperCase(),
          body: null,
          source: apiPath,
          rawPrice: price,
          network,
          asset,
          label: operation.summary || operation.operationId || '',
          description: description || operation.description || '',
        });
      }
      return candidates.length > 0 ? candidates : null;
    } catch (err) {
      console.log(`[OPENAPI] ${apiPath} error: ${err.message}`);
    }
  }
  return null;
}

async function discoverFromHealth(base, timeout) {
  try {
    const response = await got(`https://${base}/health`, {
      method: 'GET',
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
    });
    if (response.statusCode !== 200) return null;

    const data = JSON.parse(response.body);
    const candidates = [];

    // Sentinel style: data.endpoints adalah OBJECT, bukan array
    if (data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)) {
      for (const [path, info] of Object.entries(data.endpoints)) {
        if (!path) continue;

        let rawPrice = '';
        const network = data.network || '';

        if (typeof info.price === 'string') {
          const match = info.price.match(/\$([\d.]+)/);
          if (match) {
            const usdc = parseFloat(match[1]);
            rawPrice = String(Math.round(usdc * 1000000));
          } else if (info.price === 'free' || info.price === '0') {
            rawPrice = '0';
          }
        } else if (typeof info.price === 'number') {
          rawPrice = String(info.price);
        }

        candidates.push({
          path,
          method: 'GET',
          body: null,
          source: '/health',
          rawPrice,
          network,
          asset: '',
          label: info.description || path,
          description: info.description || '',
        });
      }
    }

    // Fallback: jika endpoints adalah array
    if (Array.isArray(data.endpoints)) {
      for (const svc of data.endpoints) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        candidates.push({
          path,
          method: svc.method || 'GET',
          body: null,
          source: '/health',
          rawPrice: String(svc.price || svc.x402Price || ''),
          network: svc.network || data.network || '',
          asset: svc.asset || '',
          label: svc.name || svc.id || svc.description || '',
          description: svc.description || '',
        });
      }
    }

    return candidates.length > 0 ? candidates : null;
  } catch (err) {
    console.log(`[HEALTH] Error: ${err.message}`);
    return null;
  }
}

// ========== AI DISCOVERY via SDS ==========

function filterRelevantContent(rawContent) {
  const keywords = ['x402', 'payment', 'price', 'usdc', 'network', 'agent', 'endpoint', 'accepts'];
  const lowerContent = rawContent.toLowerCase();
  const hasKeyword = keywords.some(kw => lowerContent.includes(kw));
  if (!hasKeyword) return null;

  if (rawContent.length <= 3000) return rawContent;

  // Potong dengan cerdas: ambil baris yang mengandung keyword
  const lines = rawContent.split('\n');
  const relevantLines = lines.filter(line => {
    const lowerLine = line.toLowerCase();
    return keywords.some(kw => lowerLine.includes(kw));
  });
  return relevantLines.join('\n').substring(0, 3000);
}

async function discoverWithAI(domain, base, timeout) {
  const discoveryUrls = [
    `https://${base}/.well-known/agent-card.json`,
    `https://${base}/.well-known/agent.json`,
    `https://${base}/.well-known/x402`,
    `https://${base}/openapi.json`,
    `https://${base}/health`,
  ];

  let combinedContent = '';

  for (const url of discoveryUrls) {
    try {
      const response = await got(url, {
        method: 'GET',
        timeout: { request: timeout },
        throwHttpErrors: false,
        retry: { limit: 0 },
      });
      if (response.statusCode === 200) {
        const filtered = filterRelevantContent(response.body);
        if (filtered) {
          combinedContent += `\n--- From ${url} ---\n${filtered}`;
          console.log(`[AI-DISCOVERY] Filtered content from ${url}: ${filtered.length} chars`);
        }
      }
    } catch (err) {
      console.log(`[AI-DISCOVERY] Fetch error ${url}: ${err.message}`);
    }
  }

  if (!combinedContent.trim()) {
    console.log('[AI-DISCOVERY] No relevant content found for AI');
    return null;
  }

  try {
    const sdsResponse = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
      json: { content: combinedContent },
      timeout: { request: 30000 },
      throwHttpErrors: false,
    });

    if (sdsResponse.statusCode !== 200) {
      console.log(`[AI-DISCOVERY] SDS returned ${sdsResponse.statusCode}`);
      return null;
    }

    const endpoints = JSON.parse(sdsResponse.body);
    console.log(`[AI-DISCOVERY] SDS extracted ${endpoints.length} endpoints`);

    return endpoints.map(ep => ({
      path: ep.path,
      method: ep.method || 'GET',
      body: null,
      source: 'sds-ai',
      rawPrice: String(Math.round((ep.price || 0) * 1000000)),
      network: ep.network || '',
      asset: ep.asset || '',
      label: ep.label || ep.path,
      description: ep.description || '',
    }));
  } catch (err) {
    console.log(`[AI-DISCOVERY] SDS call failed: ${err.message}`);
    return null;
  }
}

// ========== ENDPOINT VERIFICATION ==========

async function checkEndpoint(base, candidate, timeout) {
  const { path, method = 'GET' } = candidate;
  const url = `https://${base}${path}`;
  const start = Date.now();

  try {
    const response = await got(url, {
      method,
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      }
    });
    const httpStatus = response.statusCode;
    const responseTime = Date.now() - start;

    // Jika 402, verifikasi penuh
    if (httpStatus === 402) {
      try {
        const responseBody = JSON.parse(response.body);
        if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
          const offer = responseBody.accepts[0];
          const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
          const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1000000).toFixed(6)}` : '';

          return {
            domain: base,
            path,
            status: 'success',
            x402Version: responseBody.x402Version !== undefined ? String(responseBody.x402Version) : '',
            price: rawAmount,
            priceReadable,
            network: offer.network || candidate.network || '',
            asset: offer.asset || candidate.asset || '',
            payTo: offer.payTo || '',
            label: offer.label || candidate.label || '',
            description: offer.description || candidate.description || '',
            httpStatus: String(httpStatus),
            responseTimeMs: String(responseTime),
            errorMessage: '',
            timestamp: new Date().toISOString(),
          };
        }
      } catch (err) {
        // 402 tapi JSON tidak valid, lanjut ke bawah
      }
    }

    // Jika bukan 402, tapi kita punya metadata dari discovery, laporkan sebagai public_info
    if (candidate.rawPrice || candidate.network || candidate.asset) {
      const priceReadable = candidate.rawPrice
        ? `$${(parseInt(candidate.rawPrice, 10) / 1000000).toFixed(6)}`
        : '';
      return {
        domain: base,
        path,
        status: 'public_info',
        x402Version: '',
        price: String(candidate.rawPrice || ''),
        priceReadable,
        network: candidate.network || '',
        asset: candidate.asset || '',
        payTo: '',
        label: candidate.label || '',
        description: candidate.description || '',
        httpStatus: String(httpStatus),
        responseTimeMs: String(responseTime),
        errorMessage: '',
        timestamp: new Date().toISOString(),
      };
    }

    return null; // tidak ada informasi sama sekali
  } catch (err) {
    console.log(`[CHECK] ${method} ${url} → ${err.message}`);
    return null;
  }
}

// ========== MAIN ==========
const input = await Actor.getInput();
let {
  domain,
  paths: manualPaths,
  maxPaths = 100,
  timeout = 5000,
  includeSubdomains = false,
} = input;

if (!domain) {
  await Actor.fail('Domain is required. Please provide a root domain to scan.');
  await Actor.exit();
}

domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

const targetDomains = [normalizeDomain(domain)];
if (includeSubdomains) {
  targetDomains.push(`api.${normalizeDomain(domain)}`);
}

const results = [];

for (const base of targetDomains) {
  let scanList = [];

  if (manualPaths && manualPaths.trim()) {
    const paths = manualPaths.split('\n').map(p => p.trim()).filter(p => p);
    scanList = paths.map(p => ({ path: p, method: 'GET', body: null }));
  } else {
    console.log(`[DISCOVERY] Starting for ${base}`);

    // PRIORITAS 1: Deterministic discovery
    let candidates = await discoverFromWellKnownAgent(base, timeout);
    if (!candidates) candidates = await discoverFromWellKnownX402(base, timeout);
    if (!candidates) candidates = await discoverFromOpenAPI(base, timeout);
    if (!candidates) candidates = await discoverFromHealth(base, timeout);

    // === STRATEGI FINAL: VALIDASI HARGA ===
    // Jika kandidat deterministik ada, tapi harga tidak valid → fallback ke AI
    let useAIFallback = false;
    if (candidates && candidates.length > 0) {
      const firstRawPrice = candidates[0].rawPrice;
      if (!firstRawPrice || typeof firstRawPrice !== 'string' || firstRawPrice === '' || firstRawPrice === '[object Object]') {
        console.log('[DISCOVERY] Deterministic candidates have invalid price. Falling back to AI via SDS.');
        useAIFallback = true;
        candidates = null; // Reset candidates agar AI dipicu
      } else {
        console.log(`[DISCOVERY] Deterministic found ${candidates.length} valid endpoints`);
        scanList = candidates;
      }
    }

    // PRIORITAS 2: AI Discovery via SDS (jika deterministik gagal atau harga tidak valid)
    if (!candidates) {
      if (!useAIFallback) {
        console.log('[DISCOVERY] Deterministic failed, trying AI via SDS');
      }
      candidates = await discoverWithAI(domain, base, timeout);
      if (candidates && candidates.length > 0) {
        scanList = candidates;
        console.log(`[DISCOVERY] AI found ${candidates.length} endpoints`);
      }
    }

    // Jika setelah AI juga tidak ada, fallback ke dictionary
    if (!candidates || candidates.length === 0) {
      console.log('[DISCOVERY] No endpoints found, falling back to dictionary');
      scanList = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => ({
        path: p,
        method: 'GET',
        body: null,
      }));
    }
  }

  for (const item of scanList) {
    if (!item.path || item.path === '/') {
      console.log(`[SKIP] Invalid path: ${JSON.stringify(item)}`);
      continue;
    }
    const result = await checkEndpoint(base, item, timeout);
    if (result) results.push(result);
  }
}

// ========== GENERATE REPORTS ==========
const docxBuffer = await generateDOCX(domain, results);
const pdfBuffer = await generatePDF(domain, results);

const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');

const finalOutput = results.map(row => ({
  ...row,
  download_docx: docxUrl,
  download_pdf: pdfUrl,
}));

await Actor.pushData(finalOutput);
console.log(`Scan complete. ${finalOutput.length} endpoints found. Public info: ${finalOutput.filter(r => r.status === 'public_info').length}, Verified 402: ${finalOutput.filter(r => r.status === 'success').length}`);

await Actor.exit();
