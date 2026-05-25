import { Actor } from 'apify';
import { CheerioCrawler, PuppeteerCrawler } from 'crawlee';
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
    const dataset = await Actor.openDataset('failed_scans');
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
async function generateDOCX(domain, results) { /* unchanged */ }
async function generatePDF(domain, results) { /* unchanged */ }
async function saveFileToKVS(filename, buffer, contentType) { /* unchanged */ }

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
    // ... rest of extraction logic (unchanged) ...
  } catch (err) {
    console.log(`[WELL-KNOWN-X402] Error: ${err.message}`);
    await logFailure(base, 'well-known-x402', {
      error: err.message,
      reason: 'Parse or network error'
    });
    return null;
  }
}

// ========== AI DISCOVERY via SDS ==========

async function callSDS(content, timeout) {
  const finalContent = content.substring(0, 15000);
  const sdsResponse = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
    json: { content: finalContent }, timeout: { request: timeout }, throwHttpErrors: false,
  });
  if (sdsResponse.statusCode !== 200) return [];
  return JSON.parse(sdsResponse.body);
}

// ========== SCRAPER with deep failure logging ==========
async function scrapeStaticPages(base, timeout) {
  const startUrls = [ `https://${base}`, `https://${base}/docs`, `https://${base}/api`, `https://${base}/developers`, `https://${base}/pricing` ];
  const discoveredHTML = new Set();
  const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /', 'base url', 'api reference', 'pricing summary'];

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
        // Log failure for this page
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

async function scrapeDynamicPages(base, timeout) {
  const startUrls = [ `https://${base}`, `https://${base}/docs`, `https://${base}/api`, `https://${base}/developers`, `https://${base}/pricing` ];
  const discoveredHTML = new Set();
  const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /', 'base url', 'api reference', 'pricing summary'];

  const crawler = new PuppeteerCrawler({
    maxRequestsPerCrawl: 10,
    requestHandlerTimeoutSecs: 60,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },
    async requestHandler({ request, page, enqueueLinks }) {
      await page.waitForTimeout(5000);
      const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
      const matched = keywords.filter(kw => bodyText.includes(kw));
      if (matched.length > 0) {
        const html = await page.content();
        discoveredHTML.add({ url: request.url, html });
        console.log(`[DYNAMIC-SCRAPER] Found: ${request.url}`);
      } else {
        // Log failure for dynamic page
        await logFailure(base, 'dynamic-scraper', {
          url: request.url,
          reason: 'No relevant keywords found in JS-rendered HTML',
          bodyPreview: bodyText.substring(0, 1000),
          missingKeywords: keywords.filter(kw => !bodyText.includes(kw)).join(', '),
        });
      }
      await enqueueLinks({
        transformRequestFunction(req) {
          return req; // follow all links
        },
      });
    },
  });
  await crawler.run(startUrls);
  return [...discoveredHTML];
}

// ========== ENRICHMENT & DISCOVERY ==========
// ... (unchanged applyEnrichment, enrichCandidatesWithAI, discoverWithAI, discoverWithScraper) ...

// ========== ENDPOINT VERIFICATION ==========
async function checkEndpoint(base, candidate, timeout) {
  // ... (unchanged, but with auditHash) ...
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

    // Deterministic
    let candidates = await discoverFromWellKnownAgent(base, timeout);
    if (!candidates) candidates = await discoverFromWellKnownX402(base, timeout);
    if (!candidates) candidates = await discoverFromOpenAPI(base, timeout);
    if (!candidates) candidates = await discoverFromHealth(base, timeout);

    if (candidates && candidates.length > 0) {
      candidates = await enrichCandidatesWithAI(candidates, base, timeout);
      scanList = candidates;
    } else {
      // AI
      candidates = await discoverWithAI(domain, base, timeout);
      if (candidates && candidates.length > 0) {
        scanList = candidates;
      } else {
        // Scraper
        candidates = await discoverWithScraper(domain, base, timeout);
        if (candidates && candidates.length > 0) {
          scanList = candidates;
        } else {
          // Dictionary fallback + log total failure
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
