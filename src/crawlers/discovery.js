// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import got from 'got';

export async function fetchTextSource(url, timeout, label, proxyAgent) {
  try {
    const options = {
      method: 'GET',
      timeout: { request: timeout },
      throwHttpErrors: false,
      retry: { limit: 0 },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' },
    };
    if (proxyAgent) options.agent = { https: proxyAgent };
    const response = await got(url, options );
    if (response.statusCode === 200 && response.body) {
      console.log(`[FETCH] ${label}: ${response.body.length} bytes`);
      return response.body;
    }
  } catch (err) {
    console.log(`[FETCH] ${label} error: ${err.message}`);
  }
  return null;
}

export async function crawlAPISources(base, timeout, proxyAgent) {
  const rawPaths = [];
  const sources = [
    { url: `https://${base}/.well-known/x402`,                label: 'well-known-x402' },
    { url: `https://${base}/.well-known/agent-card.json`,     label: 'agent-card' },
    { url: `https://${base}/.well-known/agent.json`,          label: 'agent.json' },
    { url: `https://${base}/.well-known/agent-services.json`, label: 'agent-services' },
    { url: `https://${base}/openapi.json`,                    label: 'openapi' },
    { url: `https://${base}/swagger.json`,                    label: 'swagger' },
    { url: `https://${base}/health`,                          label: 'health' },
    { url: `https://${base}/llms.txt`,                        label: 'llms.txt' },
    { url: `https://${base}/.well-known/mcp.json`,            label: 'mcp.json' },
    { url: `https://${base}/api-docs.json`,                   label: 'api-docs' },
    // TAMBAHKAN BARIS INI UNTUK MENANGKAP API INTERNAL BLOCKRUN:
    { url: `https://${base}/api/models`,                      label: 'api-models' },
    { url: `https://${base}/api/services`,                    label: 'api-services' },
  ];

  for (const src of sources ) {
    const text = await fetchTextSource(src.url, timeout, src.label, proxyAgent);
    if (text) rawPaths.push({ source: src.label, content: text });
  }
  return rawPaths;
}

export async function crawlHTMLPages(base, timeout, proxyConfiguration) {
  const startUrls = [
    `https://${base}`,
    `https://${base}/docs`,
    `https://${base}/api`,
    `https://${base}/developers`,
    `https://${base}/pricing`,
  ];
  const discovered = new Map( );
  const keywords = [
    'x402', 'agent', 'payment', 'endpoint', 'pricing', 'service',
    '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /',
    'base url', 'api reference', 'pricing summary',
  ];
  
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 5,
    proxyConfiguration, // Menggunakan proxy bawaan Apify
    async requestHandler({ request, response, $, enqueueLinks }) {
      const contentType = response?.headers?.['content-type'] || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        try {
          const bodyText = String(response?.body || '');
          if (bodyText && bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
        } catch (err) { /* ignore */ }
        return;
      }
      try {
        const bodyText = $('body').text().toLowerCase();
        const matched = keywords.filter((kw) => bodyText.includes(kw));
        if (matched.length > 0) discovered.set(request.url, { url: request.url, html: $.html() });
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
        const bodyText = String(response?.body || '');
        if (bodyText && bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
      }
    },
  });

  
  await crawler.run(startUrls);
  return [...discovered.values()];
}

// ============================================================
// THE HARVESTER: Platform-Specific Directory Scraper
// ============================================================
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
  console.log(`\n[HARVESTER] Mencari peta '${targetDomain}' di x402scan.com...`);
  const discoveredPaths = [];

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20, // Batasi agar tidak terlalu lama
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 5,
    proxyConfiguration,
    async requestHandler({ request, $, enqueueLinks }) {
      const url = request.url;

      // 1. Jika di halaman utama, cari semua link yang menuju ke halaman /server/
      if (url === 'https://www.x402scan.com/' || url === 'https://x402scan.com/' ) {
        await enqueueLinks({
          selector: 'a[href*="/server/"]',
          baseUrl: 'https://www.x402scan.com',
        } );
        return;
      }

      // 2. Jika masuk ke halaman detail server
      if (url.includes('/server/')) {
        const pageText = $('body').text();
        
        // Cek apakah halaman ini benar-benar milik domain target kita
        if (pageText.toLowerCase().includes(targetDomain.toLowerCase())) {
          console.log(`[HARVESTER] Target ditemukan di direktori: ${url}`);
          
          // Ekstrak semua path (misal: POST /api/v1/chat) dari halaman direktori
          const pathMatches = pageText.match(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9_/\-{}.:]+)/gi);
          
          if (pathMatches) {
            for (const match of pathMatches) {
              const parts = match.trim().split(/\s+/);
              if (parts.length >= 2) {
                discoveredPaths.push({
                  method: parts[0].toUpperCase(),
                  path: parts[1],
                  source: 'harvester:x402scan'
                });
              }
            }
          }
        }
      }
    }
  });

  try {
    // Mulai pencarian dari halaman depan direktori
    await crawler.run(['https://www.x402scan.com/'] );
  } catch (err) {
    console.log(`[HARVESTER] Gagal mengakses direktori: ${err.message}`);
  }

  if (discoveredPaths.length > 0) {
    console.log(`[HARVESTER] Berhasil memanen ${discoveredPaths.length} path dari direktori!`);
  } else {
    console.log(`[HARVESTER] Target tidak ditemukan di direktori, atau tidak ada path.`);
  }

  return discoveredPaths;
}


