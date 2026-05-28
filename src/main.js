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

  // 3. PISAHKAN DATA HARVESTER
  let directFromHarvester = [];
  let pathsToProbe = []; // Path yang butuh di-fetch untuk dapat harga

  if (harvestedPaths.length > 0) {
    // Yang sudah lengkap (ada harga & deskripsi) langsung masuk hasil
    const completeHarvested = harvestedPaths.filter(p => p.rawPrice && p.description);
    directFromHarvester = finalFilter(completeHarvested, base);
    console.log(`[HARVESTER] ${directFromHarvester.length} complete endpoints from API data.`);

    // Yang belum lengkap (hanya path) kita kumpulkan untuk di-fetch
    pathsToProbe = harvestedPaths.filter(p => !p.rawPrice || !p.description);
  }

  // 4. SCRAPER UNTUK PROBING (Fetch ke endpoint)
  let probedResults = [];
  if (manualPathsArray && manualPathsArray.length > 0) {
    const candidates = manualPathsArray.map(p => normalizeCandidate({ path: p, method: 'GET', source: 'manual-ui' }));
    const scrapedData = await scrapeEndpoints(base, candidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
  } else if (pathsToProbe.length > 0) {
    // PERBAIKAN: Fetch 19 path dari Harvester yang belum punya harga!
    console.log(`[PROBER] Fetching ${pathsToProbe.length} incomplete paths from Harvester to get 402 data...`);
    const candidates = pathsToProbe.map(p => normalizeCandidate({ path: p.path, method: p.method || 'GET', source: 'harvester-probe' }));
    const scrapedData = await scrapeEndpoints(base, candidates, timeout, proxyConfiguration);
    const scannedData = scanResponses(scrapedData);
    const parsedCandidates = parseAllRawData(allRawContent, scannedData);
    probedResults = finalFilter(parsedCandidates, base);
  } else if (harvestedPaths.length === 0) {
    // Fallback ke dictionary hanya jika Harvester benar-benar kosong
    console.log(`[PROBER] Harvester empty. Fallback to built-in dictionary...`);
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
