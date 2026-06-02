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

async function runPipelineForDomain(base, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration, limit) {
  console.log(`\n[DFS] === Pipeline for ${base}${specificPath || ''} ===\n`);

  if (specificPath) {
    console.log('[DFS] Specific path mode – skipping discovery.');
    const candidate = normalizeCandidate({ path: specificPath, method: 'GET', source: 'manual' });
    const scrapedData = await scrapeEndpoints(base, [candidate], timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData([], scannedData);
    return { results: finalFilter(parsedCandidates, base), totalFound: 1, totalProbed: 1 };
  }

  const rawAPISources = await crawlAPISources(base, timeout, proxyAgent);
  const htmlPages = await crawlHTMLPages(base, timeout, proxyConfiguration);
  const allRawContent = [...rawAPISources, ...htmlPages.map(p => ({ source: 'scraper', content: p.html }))];
  
  const harvestedPaths = await crawlDirectoryPlatform(base, timeout, proxyConfiguration);
  
  let directFromHarvester = [];
  let pathsToProbe = []; 
  let totalFound = harvestedPaths.length; // Simpan total asli yang ditemukan

  if (harvestedPaths.length > 0) {
    const completeHarvested = harvestedPaths.filter(p => p.rawPrice && p.description);
    directFromHarvester = finalFilter(completeHarvested, base);
    
    pathsToProbe = harvestedPaths.filter(p => !p.rawPrice || !p.description);
    
    // STRATEGI TEASER: Potong jumlah yang akan di-probe sesuai limit user!
    if (pathsToProbe.length > limit) {
      console.log(`[HARVESTER] Limiting probes from ${pathsToProbe.length} to ${limit} based on user limit.`);
      pathsToProbe = pathsToProbe.slice(0, limit);
    }
  }

  let probedResults = [];
  if (manualPathsArray && manualPathsArray.length > 0) {
    const candidates = manualPathsArray.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual-ui' }));
    const scrapedData = await scrapeEndpoints(base, candidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
    totalFound = manualPathsArray.length;
  } else if (pathsToProbe.length > 0) {
    console.log(`[PROBER] Fetching ${pathsToProbe.length} incomplete paths from Harvester to get 402 data...`);
    const candidates = pathsToProbe.map(p => normalizeCandidate({ path: p.path, method: p.method || 'GET', source: 'harvester-probe' }));
    const scrapedData = await scrapeEndpoints(base, candidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
  } else if (harvestedPaths.length === 0) {
    console.log(`[PROBER] Harvester empty. Fallback to built-in dictionary...`);
    const dictionaryCandidates = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary-backup' }));
    const scrapedData = await scrapeEndpoints(base, dictionaryCandidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
    totalFound = probedResults.length;
  }

  const allResults = [...directFromHarvester, ...probedResults];
  const uniqueResults = Array.from(new Map(allResults.map(item => [item.path, item])).values());

  console.log(`[FINAL] ${uniqueResults.length} total unique endpoints verified.`);
  return { results: uniqueResults, totalFound, totalProbed: uniqueResults.length };
}

await Actor.init();

const input = (await Actor.getInput()) || {};
let { 
  domain, 
  paths: manualPathsStr = '', 
  maxPaths = DEFAULT_MAX_PATHS, 
  timeout = DEFAULT_TIMEOUT,
  useResidentialProxy = false,
  limit = 100 // Default limit jika tidak dikirim dari Cloudflare
} = input;

if (!domain) { 
  await Actor.fail('Domain is required.'); 
  await Actor.exit(); 
}

const manualPathsArray = manualPathsStr.split('\n').map(p => p.trim()).filter(p => p.startsWith('/'));
let specificPath = null;
domain = domain.trim();
const urlMatch = domain.match(/^(https?:\/\/ )?([^\/]+)(\/.*)?$/i);
if (urlMatch) {
  domain = urlMatch[2];
  if (urlMatch[3]) {
    const parsedPath = normalizePath(urlMatch[3]);
    if (parsedPath !== '/' && parsedPath !== '') specificPath = parsedPath;
  }
}

const proxyAgent = getProxyAgent(useResidentialProxy);
const proxyConfiguration = await getProxyConfiguration(useResidentialProxy);

const allResults = [];
let globalTotalFound = 0;
let globalTotalProbed = 0;

for (const base of [domain]) {
  const { results, totalFound, totalProbed } = await runPipelineForDomain(base, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration, limit);
  allResults.push(...results);
  globalTotalFound += totalFound;
  globalTotalProbed += totalProbed;
}

const finalResults = allResults.map(row => ({ ...row, domain, download_docx: '', download_pdf: '' }));

// Kirim statistik ke pembuat PDF/DOCX
const docxBuffer = await generateDOCX(domain, finalResults, globalTotalFound, globalTotalProbed);
const pdfBuffer  = await generatePDF(domain, finalResults, globalTotalFound, globalTotalProbed);

const docxUrl    = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl     = await saveFileToKVS('OUTPUT.pdf',  pdfBuffer,  'application/pdf');
const output     = finalResults.map(row => ({ ...row, download_docx: docxUrl, download_pdf: pdfUrl }));

await Actor.pushData(output);
console.log(`\nScan complete. ${output.length} endpoints verified out of ${globalTotalFound} found.`);
await Actor.exit();
