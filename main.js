import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
import got from 'got';
import crypto from 'crypto';
import fs from 'fs/promises';
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
  if (!candidate.rawPrice || candidate.rawPrice === '0') return false;
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
// INTELLIGENT UNIVERSAL EXTRACTION ENGINE (UPGRADED)
// ============================================================
function universalExtract(text, sourceLabel = 'unknown') {
  const candidates = [];
  const raw = String(text || '');

  // -------- Pre‑extract pricing table fallback --------
  const tablePrices = new Map();
  const tableRegex = /\|\s*([A-Za-z][\w\s/-]+?)\s*\|\s*\$?([\d.]+)\s*\|/gi;
  let tm;
  while ((tm = tableRegex.exec(raw)) !== null) {
    tablePrices.set(tm[1].trim().toLowerCase(), String(Math.round(parseFloat(tm[2]) * 1_000_000)));
  }

  // ============================================================
  // NEW: Strategy 0 - HTML list items with code + price + description
  // Matches: <li><code>/path</code> - <strong>$0.01</strong> - Description</li>
  // ============================================================
  const htmlListPattern = /<li>\s*<code>(\/[^<]+)<\/code>\s*-\s*<strong>\$([\d.]+)<\/strong>\s*-\s*([^<]+)<\/li>/gi;
  let htmlListMatch;
  while ((htmlListMatch = htmlListPattern.exec(raw)) !== null) {
    const path = htmlListMatch[1].trim();
    const price = String(Math.round(parseFloat(htmlListMatch[2]) * 1_000_000));
    const description = htmlListMatch[3].trim();
    candidates.push({
      path, method: 'GET', rawPrice: price,
      network: '', asset: '', payTo: '',
      label: description, description,
      source: `universal:html-list:${sourceLabel}`,
    });
  }

  // ============================================================
  // Strategy 0.5 - Alternative llms.txt formats
  // Matches: - tool_name ($0.01): description
  // ============================================================
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let llmsMatch;
  while ((llmsMatch = llmsAltPattern.exec(raw)) !== null) {
    const name = llmsMatch[1].trim();
    const price = String(Math.round(parseFloat(llmsMatch[2]) * 1_000_000));
    const description = llmsMatch[3].trim();
    const path = normalizePath('/tools/' + name.toLowerCase().replace(/\s+/g, '_'));
    candidates.push({
      path, method: 'GET', rawPrice: price,
      network: '', asset: '', payTo: '',
      label: name, description,
      source: `universal:llms-alt:${sourceLabel}`,
    });
  }

  // -------- Strategy 1: Markdown blocks --------
  const mdBlocks = raw.split(/(?=^#{1,3}\s)/m);
  let previousHeading = '';
  for (const block of mdBlocks) {
    const headingMatch = block.match(/^#{1,3}\s+(.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : '';

    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/i);
    if (!pathMatch) {
      if (heading) previousHeading = heading;
      continue;
    }
    const method = pathMatch[0].split(/\s+/)[0].toUpperCase();
    const path   = pathMatch[1];

    const priceMatch = block.match(/Price:\s*\$?([\d.]+)/i);
    let price = priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '';
    if (!price) {
      const headingLower = heading.toLowerCase();
      for (const [key, val] of tablePrices) {
        if (headingLower.includes(key) || key.includes(headingLower)) { price = val; break; }
      }
    }

    const cleanHeading = heading.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
    let label = cleanHeading || previousHeading || '';
    if (label.includes('\n') || label.includes('#')) label = previousHeading || '';
    if (!label) label = path.split('/').filter(Boolean).slice(-2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');

    const lines = block.split('\n');
    let description = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.includes('Price:')) continue;
      if (trimmed.length > 15) { description = trimmed; break; }
    }
    if (!description) description = label;

    candidates.push({
      path, method, rawPrice: price,
      network: '', asset: '', payTo: '',
      label, description,
      source: `universal:md:${sourceLabel}`,
    });
    if (heading) previousHeading = heading;
  }

  // -------- Strategy 2: JSON objects (including non-standard keys) --------
  try {
    const json = JSON.parse(raw);
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      
      // Non-standard well-known format where keys are URLs
      for (const [key, value] of Object.entries(obj)) {
        if (typeof key === 'string' && (key.startsWith('http://') || key.startsWith('https://'))) {
          const path = normalizePath(key);
          const meta = value && typeof value === 'object' ? value : {};
          const price = meta.price || meta.amount || meta.cost || '';
          const method = meta.method || 'GET';
          candidates.push({
            path, method,
            rawPrice: price ? String(Math.round(parseFloat(String(price).replace(/[^0-9.]/g, '')) * 1_000_000)) : '',
            network: meta.network || '', asset: meta.asset || '', payTo: meta.payTo || '',
            label: meta.label || meta.name || meta.id || meta.summary || '',
            description: meta.description || meta.summary || '',
            source: `universal:json-key:${sourceLabel}`,
          });
        }
      }
      
      // Standard walk: look for objects with path/endpoint/url property
      const path = obj.path || obj.endpoint || obj.url;
      if (path && typeof path === 'string' && path.startsWith('/')) {
        const method = obj.method || 'GET';
        const price = obj.price || obj.amount || obj.cost || '';
        candidates.push({
          path, method,
          rawPrice: price ? String(Math.round(parseFloat(String(price).replace(/[^0-9.]/g, '')) * 1_000_000)) : '',
          network: obj.network || '', asset: obj.asset || '', payTo: obj.payTo || '',
          label: obj.label || obj.name || obj.id || obj.summary || '',
          description: obj.description || obj.summary || '',
          source: `universal:json:${sourceLabel}`,
        });
      }
      
      Object.values(obj).forEach(walk);
    };
    walk(json);
  } catch { /* not JSON */ }

  // -------- Strategy 3: HTML extraction (filtered) --------
  const htmlPathMatches = raw.matchAll(/(?:href|src|action)=["'](\/[^"']+)["']/gi);
  for (const match of htmlPathMatches) {
    const path = match[1];
    if (!path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;

    const context = raw.substring(Math.max(0, match.index - 200), match.index + 300);
    const priceMatch = context.match(/\$([\d.]+)/);
    const labelMatch = context.match(/>([^<]{5,50})<\/a>/);
    candidates.push({
      path, method: 'GET',
      rawPrice: priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '',
      network: '', asset: '', payTo: '',
      label: labelMatch ? labelMatch[1].trim() : '',
      description: '',
      source: `universal:html:${sourceLabel}`,
    });
  }

  // -------- Strategy 4: Plain text --------
  const plainMatches = raw.matchAll(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/gi);
  for (const match of plainMatches) {
    const method = match[1].toUpperCase();
    const path   = match[2];
    const context = raw.substring(Math.max(0, match.index - 50), match.index + 200);
    const priceMatch = context.match(/\$([\d.]+)/);
    const descMatch  = context.match(/-\s*(.{10,100})$/m);
    candidates.push({
      path, method,
      rawPrice: priceMatch ? String(Math.round(parseFloat(priceMatch[1]) * 1_000_000)) : '',
      network: '', asset: '', payTo: '',
      label: descMatch ? descMatch[1].trim() : '',
      description: descMatch ? descMatch[1].trim() : '',
      source: `universal:text:${sourceLabel}`,
    });
  }

  return uniqCandidates(candidates);
}

// ============================================================
// Discovery Sources
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
  } catch (err) { console.log(`[FETCH] ${label} error: ${err.message}`); }
  return null;
}

async function discoverFromAllSources(base, timeout) {
  const allCandidates = [];
  const sources = [
    { url: `https://${base}/llms.txt`,                              label: 'llms.txt' },
    { url: `https://${base}/.well-known/x402`,                      label: 'well-known-x402' },
    { url: `https://${base}/.well-known/agent-card.json`,           label: 'agent-card' },
    { url: `https://${base}/.well-known/agent.json`,                label: 'agent.json' },
    { url: `https://${base}/.well-known/agent-services.json`,       label: 'agent-services' },
    { url: `https://${base}/.well-known/mcp.json`,                  label: 'mcp.json' },
    { url: `https://${base}/openapi.json`,                          label: 'openapi' },
    { url: `https://${base}/swagger.json`,                          label: 'swagger' },
    { url: `https://${base}/api-docs.json`,                         label: 'api-docs' },
    { url: `https://${base}/health`,                                label: 'health' },
  ];

  for (const src of sources) {
    const text = await fetchTextSource(src.url, timeout, src.label);
    if (!text) continue;
    const extracted = universalExtract(text, src.label);
    console.log(`[EXTRACT] ${src.label}: ${extracted.length} candidates`);
    allCandidates.push(...extracted);
  }

  const staticPages = await scrapeStaticPages(base, timeout);
  for (const page of staticPages) {
    const extracted = universalExtract(page.html, `scraper:${page.url}`);
    console.log(`[EXTRACT] scraper:${page.url}: ${extracted.length} candidates`);
    allCandidates.push(...extracted);
  }

  return uniqCandidates(allCandidates);
}

// ============================================================
// Static Scraper
// ============================================================
async function scrapeStaticPages(base, timeout) {
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
          if (bodyText) {
            const extracted = universalExtract(bodyText, `scraper:${request.url}`);
            if (extracted.length > 0) {
              discovered.set(request.url, { url: request.url, html: bodyText });
              console.log(`[SCRAPER] Found JSON/Text endpoint data: ${request.url}`);
              return;
            }
          }
        } catch (err) { console.log(`[SCRAPER] Error handling non-HTML response: ${err.message}`); }
        return;
      }
      
      try {
        const bodyText = $('body').text().toLowerCase();
        const matched = keywords.filter((kw) => bodyText.includes(kw));
        if (matched.length > 0) {
          discovered.set(request.url, { url: request.url, html: $.html() });
          console.log(`[SCRAPER] Found: ${request.url}`);
        }
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
        console.log(`[SCRAPER] Cheerio parsing failed for ${request.url}: ${err.message}`);
        try {
          const bodyText = String(response?.body || '');
          if (bodyText) {
            const extracted = universalExtract(bodyText, `scraper:${request.url}`);
            if (extracted.length > 0) {
              discovered.set(request.url, { url: request.url, html: bodyText });
              console.log(`[SCRAPER] Extracted endpoints from raw body: ${request.url}`);
            }
          }
        } catch (rawErr) { console.log(`[SCRAPER] Failed to extract from raw body: ${rawErr.message}`); }
      }
    },
  });
  await crawler.run(startUrls);
  return [...discovered.values()];
}

// ============================================================
// Verification
// ============================================================
async function checkEndpoint(base, candidate, timeout) {
  const path   = normalizePath(candidate.path);
  const method = String(candidate.method || 'GET').toUpperCase();
  const url    = `https://${base}${path}`;
  const start  = Date.now();

  try {
    const response     = await got(url, {
      method,
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' },
    });
    const httpStatus   = response.statusCode;
    const responseTime = Date.now() - start;
    const bodyHash     = sha256(response.body);

    if (httpStatus === 402) {
      try {
        const responseBody = JSON.parse(response.body);
        if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
          const offer     = responseBody.accepts[0];
          const rawAmount = String(offer.maxAmountRequired || offer.amount || candidate.rawPrice || '');
          const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1_000_000).toFixed(6)}` : '';
          return {
            domain: base, path, status: 'success',
            x402Version:   String(responseBody.x402Version || ''),
            price:         rawAmount, priceReadable,
            network:       offer.network     || candidate.network     || '',
            asset:         offer.asset       || candidate.asset       || '',
            payTo:         offer.payTo       || candidate.payTo       || '',
            label:         offer.label       || candidate.label       || '',
            description:   offer.description || candidate.description || '',
            httpStatus:    String(httpStatus), responseTimeMs: String(responseTime),
            errorMessage:  '', timestamp: new Date().toISOString(), auditHash: bodyHash,
          };
        }
      } catch { /* fall through */ }
    }

    const rawPrice      = candidate.rawPrice || '';
    const priceReadable = rawPrice ? `$${(parseInt(rawPrice, 10) / 1_000_000).toFixed(6)}` : '';
    return {
      domain: base, path, status: 'public_info',
      x402Version: '', price: rawPrice, priceReadable,
      network:       candidate.network     || '',
      asset:         candidate.asset       || '',
      payTo:         candidate.payTo       || '',
      label:         candidate.label       || '',
      description:   candidate.description || '',
      httpStatus:    String(httpStatus), responseTimeMs: String(responseTime),
      errorMessage:  '', timestamp: new Date().toISOString(), auditHash: bodyHash,
    };
  } catch (err) {
    return {
      domain: base, path, status: classifyError(err.message),
      x402Version: '', price: '', priceReadable: '',
      network:       candidate.network     || '',
      asset:         candidate.asset       || '',
      payTo:         candidate.payTo       || '',
      label:         candidate.label       || '',
      description:   candidate.description || '',
      httpStatus:    '0', responseTimeMs: String(Date.now() - start),
      errorMessage:  err.message, timestamp: new Date().toISOString(), auditHash: '',
    };
  }
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
  if (results.length === 0) {
    children.push(new Paragraph({ text: 'No public X402 information found on this domain.', spacing: { after: 120 } }));
  } else {
    for (const row of results) {
      children.push(new Paragraph({ text: `${row.path} [${row.status}]`, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 60 } }));
      if (row.priceReadable) children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
      if (row.label)         children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
      if (row.asset)         children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
      if (row.payTo)         children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
      if (row.description)   children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
      if (row.auditHash)     children.push(new Paragraph({ text: `Audit Hash: ${row.auditHash}`, spacing: { after: 40 } }));
      if (row.errorMessage)  children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
    }
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function generatePDF(domain, results) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
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
        if (row.priceReadable) doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
        if (row.label)         doc.fontSize(10).text(`Label: ${row.label}`);
        if (row.asset)         doc.fontSize(10).text(`Asset: ${row.asset}`);
        if (row.payTo)         doc.fontSize(10).text(`Pay To: ${row.payTo}`);
        if (row.description)   doc.fontSize(10).text(`Description: ${row.description}`);
        if (row.auditHash)     doc.fontSize(10).text(`Audit Hash: ${row.auditHash}`);
        if (row.errorMessage)  doc.fontSize(10).text(`Error: ${row.errorMessage}`);
        doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`);
        doc.moveDown(0.5);
      }
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
  if (!lowerDomain.endsWith('.workers.dev') && !lowerDomain.endsWith('.fly.dev')) {
    targetDomains.push(`api.${domain}`);
  } else {
    console.log('[SDS] Workers/Fly domain detected. Skipping "api." subdomain addition.');
  }
}

const allResults = [];
const manualList = (manualPaths || '').split(/\r?\n/g).map(x => x.trim()).filter(Boolean).map(normalizePath);

for (const base of targetDomains) {
  console.log(`[SDS] Starting discovery for ${base}`);

  let candidates = await discoverFromAllSources(base, timeout);

  if (candidates.length === 0 && manualList.length > 0) {
    candidates = manualList.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual' }));
  }
  if (candidates.length === 0) {
    candidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary' }));
  }

  candidates = candidates.filter(isValidCandidate);
  candidates = uniqCandidates(candidates);
  console.log(`[SDS] ${base}: ${candidates.length} candidates to verify`);

  const queue = [...candidates];
  const verified = [];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      verified.push(await checkEndpoint(base, item, timeout));
    }
  }
  await Promise.all(Array.from({ length: DEFAULT_CONCURRENCY }, () => worker()));

  for (const row of verified) { if (row) allResults.push(row); }
}

const finalResults = allResults.map(row => ({ ...row, download_docx: '', download_pdf: '' }));
const docxBuffer = await generateDOCX(domain, finalResults);
const pdfBuffer  = await generatePDF(domain, finalResults);
const docxUrl    = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl     = await saveFileToKVS('OUTPUT.pdf',  pdfBuffer,  'application/pdf');
const output = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`Scan complete. ${output.length} endpoints found.`);
await Actor.exit();
