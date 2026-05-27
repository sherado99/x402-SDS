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
import { guessPathsWithWorker } from './utils/ai.js'; // <--- TARUH DI SINI (PALING ATAS)

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

  // Gabungkan semua teks HTML yang didapat untuk dibaca oleh AI
  const combinedTextForAI = allRawContent.map(item => item.content).join('\n\n');

  // 2. SCRAPER (Gabungan Dictionary + Manual Paths + AI Guesser)
  let pathsToScrape = [];
  if (manualPathsArray && manualPathsArray.length > 0) {
    pathsToScrape = manualPathsArray.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual-ui' }));
    console.log(`[SCRAPER] Using ${pathsToScrape.length} manual paths from UI`);
  } else {
    // PANGGIL WORKER AI DI SINI (Kirim teks HTML-nya)
    const aiPaths = await guessPathsWithWorker(combinedTextForAI);
    
    // Gabungkan tebakan AI dengan Dictionary bawaan
    const combinedPaths = [...aiPaths, ...BUILT_IN_DICTIONARY];
    
    pathsToScrape = combinedPaths.slice(0, maxPaths).map(p => normalizeCandidate({ path: p, method: 'GET', source: 'dictionary-and-ai' }));
    console.log(`[SCRAPER] Using ${pathsToScrape.length} paths (${aiPaths.length} from AI)`);
  }

  
  const scrapedData = await scrapeEndpoints(base, pathsToScrape, timeout, proxyConfiguration);

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
let { 
  domain, 
  paths: manualPathsStr = '', 
  maxPaths = DEFAULT_MAX_PATHS, 
  timeout = DEFAULT_TIMEOUT,
  useResidentialProxy = false,
  includeSubdomains = false
} = input;

if (!domain) { 
  await Actor.fail('Domain is required.'); 
  await Actor.exit(); 
}

// Parse manual paths dari textarea UI
const manualPathsArray = manualPathsStr
  .split('\n')
  .map(p => p.trim())
  .filter(p => p.length > 0);

// Parse domain dan specificPath
let specificPath = null;
domain = domain.trim();
const urlMatch = domain.match(/^(https?:\/\/)?([^\/]+)(\/.*)?$/i);
if (urlMatch) {
  domain = urlMatch[2];
  if (urlMatch[3]) {
    const parsedPath = normalizePath(urlMatch[3]);
    // PERBAIKAN: Abaikan jika path-nya hanya '/' atau kosong
    if (parsedPath !== '/' && parsedPath !== '') {
      specificPath = parsedPath;
    }
  }
}


// Setup Proxy (Menghormati tombol useResidentialProxy dari UI)
const proxyAgent = getProxyAgent();
const proxyConfigOptions = useResidentialProxy ? { groups: ['RESIDENTIAL'] } : undefined;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigOptions);

const allResults = [];

if (specificPath) {
  const final = await runPipelineForDomain(domain, specificPath, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration);
  allResults.push(...final);
} else {
  const targetDomains = [domain];
  
  // Menghormati tombol includeSubdomains dari UI
  if (includeSubdomains) {
    const lowerDomain = domain.toLowerCase();
    if (!lowerDomain.endsWith('.workers.dev') && !lowerDomain.endsWith('.fly.dev')) {
      targetDomains.push(`api.${domain}`);
    }
  }

  for (const base of targetDomains) {
    const final = await runPipelineForDomain(base, null, manualPathsArray, timeout, maxPaths, proxyAgent, proxyConfiguration);
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
