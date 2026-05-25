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

function normalizeDomain(d) { return d.replace(/\/+$/, '').trim(); }
function sha256(raw) { return crypto.createHash('sha256').update(raw || '').digest('hex'); }

function normalizePath(rawPath) {
  let p = rawPath || '';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try { const url = new URL(p); p = url.pathname + (url.search || ''); } catch (e) {}
  }
  p = p.replace(/^\/api(?=\/)/i, '');
  return p.replace(/\/+$/, '').toLowerCase();
}

// ========== FAILURE LOGGING ==========
async function logFailure(base, stage, details) {
  try {
    const dataset = await Actor.openDataset('failed-scans');
    await dataset.pushData({ domain: base, stage, timestamp: new Date().toISOString(), ...details });
  } catch (err) { console.error(`[FAIL-LOG] ${err.message}`); }
}

// ========== REPORT GENERATION ==========
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

async function generatePDF(domain, results) { /* unchanged */ }
async function saveFileToKVS(filename, buffer, contentType) { /* unchanged */ }

// ========== DETERMINISTIC DISCOVERY ==========
async function discoverFromWellKnownAgent(base, timeout) { /* unchanged */ }
async function discoverFromWellKnownX402(base, timeout) { /* unchanged */ }
async function discoverFromOpenAPI(base, timeout) { /* unchanged */ }
async function discoverFromHealth(base, timeout) { /* unchanged */ }

// ========== CHEAP EXTRACTION ==========
function cheapExtractPrice(text) {
  const match = text.match(/\$([\d.]+)/);
  return match ? String(Math.round(parseFloat(match[1]) * 1000000)) : '';
}

function cheapExtractLabel(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ========== SDS HELPER (batched + cached) ==========
async function callSDSBatched(endpoints, timeout) {
  // Build a compact prompt with up to 20 endpoints
  const chunk = endpoints.slice(0, 20);
  const promptLines = chunk.map((ep, i) => `${i+1}. ${ep.method || 'GET'} ${ep.path}`).join('\n');
  const prompt = `For each API endpoint below, return a JSON object with "label" (short name) and "description" (brief). Endpoints:\n${promptLines}\n\nReturn ONLY a JSON array of objects with "index" (matching the number), "label", and "description".`;
  const content = prompt.substring(0, 15000);
  const key = sha256(content);
  const cache = await Actor.openKeyValueStore('sds-cache');
  const cached = await cache.getValue(key);
  if (cached) return JSON.parse(cached);

  const res = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
    json: { content }, timeout: { request: timeout }, throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return [];
  const parsed = JSON.parse(res.body);
  await cache.setValue(key, JSON.stringify(parsed));
  return parsed;
}

async function enrichWithCheapHybrid(candidates, base, timeout) {
  // 1. Apply cheap extraction first
  for (const c of candidates) {
    if (!c.rawPrice) c.rawPrice = cheapExtractPrice(c.description || '') || cheapExtractPrice(c.label || '');
    if (!c.label) c.label = cheapExtractLabel(c.path);
  }

  // 2. Identify candidates that still need AI (missing description or too generic)
  const needAI = candidates.filter(c => !c.description || c.description.length < 20);
  if (needAI.length === 0) return candidates;

  // 3. Deduplicate by pattern (cluster similar paths)
  const clusters = new Map();
  for (const ep of needAI) {
    const parts = ep.path.split('/').filter(Boolean);
    const verb = parts[parts.length-1]?.toLowerCase();
    const key = verb || ep.path;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(ep);
  }

  // 4. Send only one representative per cluster to AI (batched)
  const representatives = Array.from(clusters.values()).map(g => g[0]);
  const aiResults = await callSDSBatched(representatives, timeout);

  // 5. Apply AI results to all members of the cluster
  if (aiResults.length > 0) {
    for (const ai of aiResults) {
      const idx = ai.index ? ai.index - 1 : -1;
      if (idx >= 0 && idx < representatives.length) {
        const rep = representatives[idx];
        const cluster = clusters.get(rep.path.split('/').filter(Boolean).pop()?.toLowerCase() || '');
        if (cluster) {
          for (const ep of cluster) {
            if (!ep.label || ep.label === cheapExtractLabel(ep.path)) ep.label = ai.label || ep.label;
            if (!ep.description || ep.description.length < 20) ep.description = ai.description || ep.description;
            ep.source = `${ep.source}+ai-batch`;
          }
        }
      }
    }
  }

  return candidates;
}

// ========== SCRAPER (unchanged static) ==========
async function scrapeStaticPages(base, timeout) { /* unchanged */ }

// ========== MAIN ==========
const input = await Actor.getInput();
let { domain, paths: manualPaths, maxPaths = 100, timeout = 5000, includeSubdomains = false } = input;
if (!domain) { await Actor.fail('Domain is required.'); await Actor.exit(); }

domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
const targetDomains = [normalizeDomain(domain)];
if (includeSubdomains) targetDomains.push(`api.${normalizeDomain(domain)}`);

const results = [];
for (const base of targetDomains) {
  let candidates = await discoverFromWellKnownAgent(base, timeout);
  if (!candidates) candidates = await discoverFromWellKnownX402(base, timeout);
  if (!candidates) candidates = await discoverFromOpenAPI(base, timeout);
  if (!candidates) candidates = await discoverFromHealth(base, timeout);
  if (!candidates) candidates = await discoverWithAI(domain, base, timeout);
  if (!candidates) candidates = await discoverWithScraper(domain, base, timeout);
  if (!candidates) {
    await logFailure(base, 'all-methods', { reason: 'Falling back to dictionary' });
    candidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => ({ path: p, method: 'GET', body: null }));
  }

  candidates = await enrichWithCheapHybrid(candidates, base, timeout);

  for (const item of candidates) {
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