// src/main.js
import { Actor } from 'apify';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_PATHS, BUILT_IN_DICTIONARY } from './config.js';
import { normalizePath, normalizeCandidate, sha256 } from './utils/helpers.js';
import { getProxyAgent, getProxyConfiguration } from './utils/proxy.js';
import { crawlAPISources, crawlHTMLPages, crawlDirectoryPlatform } from './crawlers/discovery.js';
import { scrapeEndpoints } from './crawlers/prober.js';
import { parseAllRawData, finalFilter } from './parsers/index.js';
import { generateDOCX } from './reporters/docx.js';
import { generatePDF } from './reporters/pdf.js';
import { saveFileToKVS } from './reporters/storage.js';

function scanResponses(scraped) {
  return scraped.map(({ candidate, statusCode, body, responseTime, error }) => {
    const bodyHash = body ? sha256(body) : '';
    return { candidate, statusCode, body, bodyHash, responseTime, errorMessage: error || '' };
  });
}

async function runPipelineForDomain(base, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration) {
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

  // 1. CRAWLER
  const rawAPISources = await crawlAPISources(base, timeout, proxyAgent);
  const htmlPages = await crawlHTMLPages(base, timeout, proxyConfiguration);
  const allRawContent = [...rawAPISources, ...htmlPages.map(p => ({ source: 'scraper', content: p.html }))];
  console.log(`[CRAWLER] ${rawAPISources.length} API sources + ${htmlPages.length} HTML pages crawled`);

  // 2. HARVESTER (API x402scan)
  const harvestedPaths = await crawlDirectoryPlatform(base, timeout, proxyConfiguration);

  // 3. PROSES LANGSUNG DATA HARVESTER YANG LENGKAP
  let directFromHarvester = [];
  if (harvestedPaths.length > 0) {
    // Filter yang punya harga dan deskripsi
    const completeHarvested = harvestedPaths.filter(p => p.rawPrice && p.description);
    directFromHarvester = finalFilter(completeHarvested, base);
    console.log(`[HARVESTER] ${directFromHarvester.length} complete endpoints from API data.`);
  }

  // 4. SCRAPER UNTUK PROBING (endpoint target + dictionary)
  let probedResults = [];
  if (manualPathsArray && manualPathsArray.length > 0) {
    const candidates = manualPathsArray.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual-ui' }));
    const scrapedData = await scrapeEndpoints(base, candidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
  } else if (harvestedPaths.length === 0) {
    // Fallback ke dictionary hanya jika Harvester kosong
    const dictionaryCandidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary-backup' }));
    const scrapedData = await scrapeEndpoints(base, dictionaryCandidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
  }

  // 5. GABUNGKAN SEMUA HASIL
  const allResults = [...directFromHarvester, ...probedResults];
  // Deduplikasi berdasarkan path
  const uniqueResults = Array.from(new Map(allResults.map(item => [item.path, item])).values());
  
  console.log(`[FINAL] ${uniqueResults.length} total unique endpoints.`);
  return uniqueResults;
}

// ============================================================
// MAIN EXECUTION
// ============================================================
await Actor.init();

const input = (await Actor.getInput()) || {};
let { 
  domain, 
  paths: manualPathsStr = '', 
  maxPaths = DEFAULT_MAX_PATHS, 
  timeout = DEFAULT_TIMEOUT,
  useResidentialProxy = false
} = input;

if (!domain) { 
  await Actor.fail('Domain is required.'); 
  await Actor.exit(); 
}

const manualPathsArray = manualPathsStr
  .split('\n')
  .map(p => p.trim())
  .filter(p => p.startsWith('/'));

let specificPath = null;
domain = domain.trim();
const urlMatch = domain.match(/^(https?:\/\/)?([^\/]+)(\/.*)?$/i);
if (urlMatch) {
  domain = urlMatch[2];
  if (urlMatch[3]) {
    const parsedPath = normalizePath(urlMatch[3]);
    if (parsedPath !== '/' && parsedPath !== '') {
      specificPath = parsedPath;
    }
  }
}

const proxyAgent = getProxyAgent(useResidentialProxy);
const proxyConfiguration = await getProxyConfiguration(useResidentialProxy);

const allResults = [];
const targetDomains = [domain]; // Hanya domain yang diinput, tanpa tambahan subdomain

for (const base of targetDomains) {
  const final = await runPipelineForDomain(base, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration);
  allResults.push(...final);
}

// ============================================================
// OUTPUT
// ============================================================
const finalResults = allResults.map(row => ({ ...row, domain, download_docx: '', download_pdf: '' }));
const docxBuffer = await generateDOCX(domain, finalResults);
const pdfBuffer  = await generatePDF(domain, finalResults);
const docxUrl    = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl     = await saveFileToKVS('OUTPUT.pdf',  pdfBuffer,  'application/pdf');
const output     = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`\nScan complete. ${output.length} endpoints found.`);
await Actor.exit();
