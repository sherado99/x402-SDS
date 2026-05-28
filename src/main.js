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

  // Mode spesifik path (dari URL)
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

  // 2. THE HARVESTER (Cari di Direktori x402scan.com)
  const harvestedPaths = await crawlDirectoryPlatform(base, timeout, proxyConfiguration);

  // 3. SCRAPER (Gabungan Harvester + Manual Paths + Cadangan Dictionary)
  let pathsToScrape = [];
  
  if (manualPathsArray && manualPathsArray.length > 0) {
    pathsToScrape = manualPathsArray.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual-ui' }));
    console.log(`[SCRAPER] Using ${pathsToScrape.length} manual paths from UI`);
  } else {
    // Normalisasi hasil panen dari direktori (Bawa semua datanya!)
    const cleanHarvested = harvestedPaths.map(p => normalizeCandidate({ 
      path: p.path, 
      method: p.method, 
      rawPrice: p.rawPrice,
      label: p.label,
      description: p.description,
      network: p.network,
      asset: p.asset,
      source: p.source 
    }));
    
    // Gabungkan hasil panen dengan Dictionary sebagai cadangan
    const combinedPaths = [...cleanHarvested, ...BUILT_IN_DICTIONARY.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary-backup' }))];
    
    // Hapus duplikat agar mesin tidak mengetuk pintu yang sama dua kali
    const uniquePaths = Array.from(new Map(combinedPaths.map(item => [item.path, item])).values());
    
    pathsToScrape = uniquePaths.slice(0, maxPaths);
    console.log(`[SCRAPER] Using ${pathsToScrape.length} paths (${cleanHarvested.length} from Harvester, rest from Dictionary Backup)`);
  }

  const scrapedData = await scrapeEndpoints(base, pathsToScrape, timeout, proxyConfiguration);

  // 4. SCANNER
  const scannedData = scanResponses(scrapedData);
  console.log(`[SCANNER] ${scannedData.length} responses scanned`);

  // 5. PARSER
  const parsedCandidates = parseAllRawData(allRawContent, scannedData);
  console.log(`[PARSER] ${parsedCandidates.length} total candidates after parsing`);

  // 6. FINAL FILTER
  const final = finalFilter(parsedCandidates, base);
  console.log(`[FINAL] ${final.length} complete endpoints after final filter`);

  return final;
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

// Parse manual paths dari UI
const manualPathsArray = manualPathsStr
  .split('\n')
  .map(p => p.trim())
  .filter(p => p.startsWith('/'));

// Parse domain dan specificPath
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

// Setup Proxy
const proxyAgent = getProxyAgent(useResidentialProxy);
const proxyConfiguration = await getProxyConfiguration(useResidentialProxy);

const allResults = [];

if (specificPath) {
  const final = await runPipelineForDomain(domain, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration);
  allResults.push(...final);
} else {
  // Mode domain: tambahkan subdomain hanya jika domain bukan subdomain dan bukan workers.dev/fly.dev
  const targetDomains = [domain];
  const lowerDomain = domain.toLowerCase();
  if (!lowerDomain.startsWith('api.') && !lowerDomain.endsWith('.workers.dev') && !lowerDomain.endsWith('.fly.dev')) {
    targetDomains.push(`api.${domain}`);
  }
  for (const base of targetDomains) {
    const final = await runPipelineForDomain(base, null, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration);
    allResults.push(...final);
  }
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
