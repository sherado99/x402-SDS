import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
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
      text: 'No X402 endpoints found on this domain.',
      spacing: { after: 120 },
    }));
  } else {
    for (const row of results) {
      children.push(new Paragraph({
        text: `${row.path} [${row.status}]`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 60 },
      }));
      if (row.status === 'success') {
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
      doc.fontSize(12).text('No X402 endpoints found on this domain.');
    } else {
      for (const row of results) {
        doc.fontSize(12).text(`${row.path} [${row.status}]`, { underline: true });
        if (row.status === 'success') {
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

// ========== KEYWORD FILTER ==========
function containsX402Keywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('x402') || lower.includes('agent');
}

// ========== PHASE 1: CRAWLER ==========
async function crawlDocumentation(domain, timeout) {
  const startUrls = [
    `https://${domain}/docs`,
    `https://${domain}/api`,
    `https://${domain}/reference`,
    `https://${domain}/developers`,
  ];

  // Also crawl the root domain for links
  startUrls.push(`https://${domain}`);

  const discoveredPages = new Set();

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 50,
    requestHandlerTimeoutSecs: 30,

    async requestHandler({ request, $, enqueueLinks }) {
      const bodyText = $('body').text();
      if (containsX402Keywords(bodyText)) {
        discoveredPages.add(request.url);
        console.log(`[CRAWL] Found relevant page: ${request.url}`);

        // Enqueue links that contain keywords
        await enqueueLinks({
          transformRequestFunction(req) {
            const linkText = $(`a[href="${req.url}"]`).text() || '';
            if (containsX402Keywords(req.url) || containsX402Keywords(linkText)) {
              return req;
            }
            return false; // skip
          },
        });
      }
    },
  });

  await crawler.run(startUrls);
  return [...discoveredPages];
}

// ========== PHASE 2: SCRAPER ==========
function extractEndpointCandidates(pageHtml, pageUrl) {
  const candidates = [];

  // Regex to find API endpoints (paths, URLs)
  const endpointPatterns = [
    // Common path patterns like /api/v1/users, /x402/sapi
    /['"](\/[a-zA-Z0-9_\-\/\.]+)['"]/g,
    // Markdown links: [text](/path)
    /\[([^\]]+)\]\((\/[a-zA-Z0-9_\-\/\.]+)\)/g,
    // HTML href values
    /href="(\/[a-zA-Z0-9_\-\/\.]+)"/g,
  ];

  // Extract potential endpoints from text that also contains "x402" or "agent" nearby
  const textBlocks = pageHtml.split(/<[^>]+>/).filter(Boolean); // crude text extraction
  for (const block of textBlocks) {
    if (!containsX402Keywords(block)) continue;

    for (const pattern of endpointPatterns) {
      let match;
      while ((match = pattern.exec(block)) !== null) {
        const path = match[2] || match[1];
        if (path && path.startsWith('/') && path.length > 1) {
          candidates.push({
            path,
            method: 'GET', // default, will be overridden by scanner
            body: null,
            source: pageUrl,
          });
        }
      }
    }
  }

  // Deduplicate
  const unique = [];
  const seen = new Set();
  for (const cand of candidates) {
    const key = `${cand.path}::${cand.method}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cand);
    }
  }

  return unique;
}

// ========== PHASE 3: SCANNER (existing, enhanced) ==========
async function checkEndpoint(base, path, method, body, timeout) {
  const url = `https://${base}${path}`;
  const start = Date.now();
  
  const options = {
    method,
    timeout: { request: timeout },
    throwHttpErrors: false,
    retry: { limit: 0 },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  };

  if (method === 'POST' && body) {
    options.json = body;
  }

  try {
    const response = await got(url, options);
    const httpStatus = response.statusCode;
    const responseTime = Date.now() - start;

    if (httpStatus !== 402) {
      console.log(`[DEBUG] Non-402 body (first 200 chars): ${response.body?.slice(0, 200)}`);
      return null;
    }

    try {
      const responseBody = JSON.parse(response.body);
      if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
        const offer = responseBody.accepts[0];
        
        const rawAmount = offer.maxAmountRequired || offer.amount || '';
        const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1000000).toFixed(6)}` : '';

        return {
          domain: base,
          path,
          status: 'success',
          x402Version: responseBody.x402Version !== undefined ? String(responseBody.x402Version) : '',
          price: rawAmount,
          priceReadable: priceReadable,
          network: offer.network || '',
          asset: offer.asset || '',
          payTo: offer.payTo || '',
          label: offer.label || '',
          description: offer.description || '',
          httpStatus: String(httpStatus),
          responseTimeMs: String(responseTime),
          errorMessage: '',
          timestamp: new Date().toISOString(),
        };
      } else {
        return {
          domain: base,
          path,
          status: 'error',
          x402Version: responseBody.x402Version !== undefined ? String(responseBody.x402Version) : '',
          price: '',
          priceReadable: '',
          network: '',
          asset: '',
          payTo: '',
          label: '',
          description: '',
          httpStatus: String(httpStatus),
          responseTimeMs: String(responseTime),
          errorMessage: 'Missing accepts array in 402 response',
          timestamp: new Date().toISOString(),
        };
      }
    } catch (parseErr) {
      return {
        domain: base,
        path,
        status: 'error',
        x402Version: '',
        price: '',
        priceReadable: '',
        network: '',
        asset: '',
        payTo: '',
        label: '',
        description: '',
        httpStatus: String(httpStatus),
        responseTimeMs: String(responseTime),
        errorMessage: 'Invalid JSON in 402 body',
        timestamp: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.log(`[ERROR] ${method} ${url} → ${err.message}`);
    return {
      domain: base,
      path,
      status: 'error',
      x402Version: '',
      price: '',
      priceReadable: '',
      network: '',
      asset: '',
      payTo: '',
      label: '',
      description: '',
      httpStatus: '0',
      responseTimeMs: String(Date.now() - start),
      errorMessage: err.message,
      timestamp: new Date().toISOString(),
    };
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

domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

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
    console.log(`[HYBRID] Starting discovery for ${base}`);

    // Phase 1: Crawl documentation
    const docPages = await crawlDocumentation(base, timeout);
    console.log(`[HYBRID] Crawled ${docPages.length} relevant pages`);

    // Phase 2: Scrape endpoints from pages
    const candidateEndpoints = [];
    for (const pageUrl of docPages) {
      try {
        const response = await got(pageUrl, {
          method: 'GET',
          timeout: { request: timeout },
          throwHttpErrors: false,
          retry: { limit: 0 },
        });
        if (response.statusCode === 200) {
          const candidates = extractEndpointCandidates(response.body, pageUrl);
          candidateEndpoints.push(...candidates);
          console.log(`[SCRAPE] Extracted ${candidates.length} candidates from ${pageUrl}`);
        }
      } catch (err) {
        console.log(`[SCRAPE ERROR] ${pageUrl}: ${err.message}`);
      }
    }

    // Phase 3: Scan all candidates + dictionary fallback
    if (candidateEndpoints.length > 0) {
      scanList = candidateEndpoints;
      console.log(`[HYBRID] Total candidates: ${scanList.length}`);
    } else {
      console.log('[HYBRID] No candidates found, falling back to dictionary');
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
    const result = await checkEndpoint(base, item.path, item.method, item.body, timeout);
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
console.log(`Scan complete. ${finalOutput.length} endpoints found. Success: ${finalOutput.filter(r => r.status === 'success').length}, Errors: ${finalOutput.filter(r => r.status === 'error').length}`);

await Actor.exit();