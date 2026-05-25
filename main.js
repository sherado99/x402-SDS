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

// ... (generateDOCX, generatePDF, saveFileToKVS tidak berubah) ...

// ========== DETERMINISTIC DISCOVERY ==========
// ... (discoverFromWellKnownAgent, discoverFromWellKnownX402, discoverFromOpenAPI, discoverFromHealth) ...
// Fungsi-fungsi ini tidak diubah.

// ========== AI DISCOVERY via SDS ==========

async function callSDS(content, timeout) {
  const finalContent = content.substring(0, 15000);
  const sdsResponse = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
    json: { content: finalContent }, timeout: { request: timeout }, throwHttpErrors: false,
  });
  if (sdsResponse.statusCode !== 200) return [];
  return JSON.parse(sdsResponse.body);
}

/**
 * Mencoba melengkapi kandidat (path, method, dll) dengan harga, label, deskripsi
 * menggunakan SDS. Strategi:
 * 1. Kirim well-known/x402 (jika ada).
 * 2. Kirim /health (jika ada).
 * 3. Jika masih kosong, lakukan scraping halaman dokumentasi.
 */
async function enrichCandidatesWithAI(candidates, base, timeout) {
  // Cek apakah ada kandidat yang masih miskin data
  const needsEnrichment = candidates.some(c => !c.rawPrice && !c.label && !c.description);
  if (!needsEnrichment) return candidates;

  // --- Langkah 1: Coba well-known/x402 ---
  let rawContent = '';
  try {
    const wkRes = await got(`https://${base}/.well-known/x402`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (wkRes.statusCode === 200) rawContent = wkRes.body;
  } catch (err) {}
  if (rawContent) {
    const aiEndpoints = await callSDS(rawContent, 30000);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
      if (!candidates.some(c => !c.rawPrice && !c.label && !c.description)) return candidates;
    }
  }

  // --- Langkah 2: Coba /health ---
  rawContent = '';
  try {
    const healthRes = await got(`https://${base}/health`, { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } });
    if (healthRes.statusCode === 200) rawContent = healthRes.body;
  } catch (err) {}
  if (rawContent) {
    const aiEndpoints = await callSDS(rawContent, 30000);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
      if (!candidates.some(c => !c.rawPrice && !c.label && !c.description)) return candidates;
    }
  }

  // --- Langkah 3: Scraping halaman-halaman yang mungkin ---
  console.log('[ENRICH] Well-known dan health tidak cukup, memulai scraping...');
  const scrapedHTML = await scrapeHTMLPages(base, timeout);
  if (scrapedHTML.length > 0) {
    let combinedHTML = '';
    for (const page of scrapedHTML) {
      combinedHTML += `\n--- From ${page.url} ---\n${page.html.substring(0, 15000)}`;
    }
    const aiEndpoints = await callSDS(combinedHTML, 60000);
    if (aiEndpoints.length > 0) {
      applyEnrichment(candidates, aiEndpoints);
    }
  }

  return candidates;
}

/**
 * Cocokkan hasil AI dengan kandidat berdasarkan path, isi field yang kosong.
 */
function applyEnrichment(candidates, aiEndpoints) {
  for (const candidate of candidates) {
    const match = aiEndpoints.find(ai => ai.path === candidate.path);
    if (match) {
      if (!candidate.rawPrice && match.price) candidate.rawPrice = String(Math.round(match.price * 1000000));
      if (!candidate.label && match.label) candidate.label = match.label;
      if (!candidate.description && match.description) candidate.description = match.description;
      if (!candidate.network && match.network) candidate.network = match.network;
      if (!candidate.asset && match.asset) candidate.asset = match.asset;
      candidate.source = `${candidate.source}+sds-enrich`;
    }
  }
}

// ========== SCRAPER HTML ==========
// Versi fleksibel yang bisa dipanggil tanpa domain (pakai base)
async function scrapeHTMLPages(base, timeout) {
  const startUrls = [
    `https://${base}`,
    `https://${base}/docs`,
    `https://${base}/api`,
    `https://${base}/developers`,
    `https://${base}/pricing`
  ];
  const discoveredHTML = new Set();

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: 30,
    async requestHandler({ request, $, enqueueLinks }) {
      const bodyText = $('body').text().toLowerCase();
      const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method'];
      if (keywords.some(kw => bodyText.includes(kw))) {
        discoveredHTML.add({ url: request.url, html: $.html() });
        console.log(`[SCRAPER] Found relevant HTML: ${request.url}`);
        await enqueueLinks({
          transformRequestFunction(req) {
            const linkText = ($(`a[href="${req.url}"]`).text() || '').toLowerCase();
            if (keywords.some(kw => linkText.includes(kw))) return req;
            return false;
          },
        });
      }
    },
  });
  await crawler.run(startUrls);
  return [...discoveredHTML];
}

// Fungsi discoverWithScraper dan discoverWithAI tidak berubah dari versi sebelumnya.

// ========== ENDPOINT VERIFICATION ==========
// ... (checkEndpoint tidak berubah) ...

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
      // 1b. Enrich dengan SDS (well-known → health → scraper)
      candidates = await enrichCandidatesWithAI(candidates, base, timeout);
      scanList = candidates;
      console.log(`[DISCOVERY] Deterministic + Enrich: ${candidates.length} endpoints`);
    } else {
      // 2. AI discovery langsung (jika deterministic tidak dapat apa-apa)
      candidates = await discoverWithAI(domain, base, timeout);
      if (candidates && candidates.length > 0) {
        scanList = candidates;
        console.log(`[DISCOVERY] AI found ${candidates.length} endpoints`);
      } else {
        // 3. Scraper + SDS
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

// ... (generate reports, push data, exit) ...
