// src/main.js
import { Actor } from 'apify';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_PATHS, BUILT_IN_DICTIONARY } from './config.js';
import { normalizePath, normalizeCandidate, sha256 } from './utils/helpers.js';
import { getProxyAgent } from './utils/proxy.js';
import { crawlAPISources, crawlHTMLPages } from './crawlers/discovery.js';
import { scrapeEndpoints } from './crawlers/prober.js';
import { parseAllRawData, finalFilter } from './parsers/index.js';
import { generateDOCX } from './reporters/docx.js';
import { generatePDF } from './reporters/pdf.js';
import { saveFileToKVS } from './reporters/storage.js';

// Fungsi kecil untuk memetakan hasil scraper menjadi format scanner
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

async function runPipelineForDomain(base, specificPath, timeout, maxPaths, proxyAgent, proxyConfiguration) {
  console.log(`\n[SDS] === Pipeline for ${base}${specificPath || ''} ===\n`);

  // Mode spesifik path
  if (specificPath) {
    console.log('[SDS] Specific path mode – skipping discovery.');
    const candidate = normalizeCandidate({ path: specificPath, method: 'GET', source: 'manual' });
    const scrapedData = await scrapeEndpoints(base, [candidate], timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData([], scannedData);
    return finalFilter(parsedCandidates, base);
  }

  // Mode domain: pipeline lengkap
  // 1. CRAWLER
  const rawAPISources = await crawlAPISources(base, timeout, proxyAgent);
  const htmlPages = await crawlHTMLPages(base, timeout, proxyConfiguration);
  const allRawContent = [
    ...rawAPISources,
    ...htmlPages.map(p => ({ source: 'scraper', content: p.html })),
  ];
  console.log(`[CRAWLER] ${rawAPISources.length} API sources + ${htmlPages.length} HTML pages crawled`);

  // 2. SCRAPER
  const dictionaryCandidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary' }));
  console.log(`[SCRAPER] ${dictionaryCandidates.length} dictionary paths to scrape`);
  const scrapedData = await scrapeEndpoints(base, dictionaryCandidates, timeout, proxyConfiguration);

  // 3. SCANNER
  const scannedData = scanResponses(scrapedData);
  console.log(`[SCANNER] ${scannedData.length} responses scanned`);

  // 4. PARSER
  const parsedCandidates = parseAllRawData(allRawContent, scannedData);
  console.log(`[PARSER] ${parsedCandidates.length} total candidates after parsing`);

  // 5. FINAL FILTER
  const final = finalFilter(parsedCandidates, base);
  console.log(`[FINAL] ${final.length} complete endpoints after final filter`);

  return final;
}

// ============================================================
// MAIN EXECUTION
// ============================================================
await Actor.init();

const input = (await Actor.getInput()) || {};
let { domain, maxPaths = DEFAULT_MAX_PATHS, timeout = DEFAULT_TIMEOUT } = input;

if (!domain) { 
  await Actor.fail('Domain is required.'); 
  await Actor.exit(); 
}

// Parse domain dan specificPath
let specificPath = null;
domain = domain.trim();
const urlMatch = domain.match(/^(https?:\/\/ )?([^\/]+)(\/.*)?$/i);
if (urlMatch) {
  domain = urlMatch[2];
  if (urlMatch[3]) specificPath = normalizePath(urlMatch[3]);
}

// Setup Proxy
const proxyAgent = getProxyAgent();
const proxyConfiguration = await Actor.createProxyConfiguration(); // Bawaan Apify untuk crawlee

const allResults = [];

if (specificPath) {
  const final = await runPipelineForDomain(domain, specificPath, timeout, maxPaths, proxyAgent, proxyConfiguration);
  allResults.push(...final);
} else {
  const targetDomains = [domain];
  const lowerDomain = domain.toLowerCase();
  if (!lowerDomain.endsWith('.workers.dev') && !lowerDomain.endsWith('.fly.dev')) {
    targetDomains.push(`api.${domain}`);
  }
  for (const base of targetDomains) {
    const final = await runPipelineForDomain(base, null, timeout, maxPaths, proxyAgent, proxyConfiguration);
    allResults.push(...final);
  }
}

// Generate Reports
const finalResults = allResults.map(row => ({ ...row, domain, download_docx: '', download_pdf: '' }));
const docxBuffer = await generateDOCX(domain, finalResults);
const pdfBuffer  = await generatePDF(domain, finalResults);

const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl  = await saveFileToKVS('OUTPUT.pdf',  pdfBuffer,  'application/pdf');

const output = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`\nScan complete. ${output.length} endpoints found.`);

await Actor.exit();
