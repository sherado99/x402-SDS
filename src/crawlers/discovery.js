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
    proxyConfiguration,
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
// THE HARVESTER: Platform-Specific Directory Scraper (UPGRADED)
// ============================================================
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
  console.log(`\n[HARVESTER] Searching map '${targetDomain}' at x402scan.com via Sitemap...`);
  const discoveredPaths = [];
  let serverUrls = [];

  // 1. Ambil semua link dari Sitemap secara instan (Bypass JavaScript)
  try {
    const sitemapResponse = await got('https://x402scan.com/sitemap.xml', { timeout: { request: timeout }, throwHttpErrors: false } );
    if (sitemapResponse.body) {
      const matches = sitemapResponse.body.match(/<loc>(https:\/\/[^<]*x402scan\.com\/server\/[^<]+ )<\/loc>/gi);
      if (matches) {
        serverUrls = matches.map(m => m.replace(/<\/?loc>/g, ''));
      }
    }
  } catch (e) {
    console.log(`[HARVESTER] Fail take sitemap: ${e.message}`);
  }

  // Jika sitemap gagal, gunakan halaman depan sebagai cadangan
  if (serverUrls.length === 0) {
    serverUrls = ['https://www.x402scan.com/'];
  } else {
    console.log(`[HARVESTER] Find ${serverUrls.length} link server in sitemap. Start inspection...` );
  }

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 500, // Dinaikkan agar bisa mengecek semua server di sitemap
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 5,
    proxyConfiguration,
    async requestHandler({ request, $ }) {
      const url = request.url;

      if (url.includes('/server/')) {
        // X-RAY VISION: Ambil seluruh HTML mentah, termasuk data JSON yang disembunyikan React
        const pageText = $.html(); 
        
        // Cek apakah halaman ini milik domain target kita
        if (pageText.toLowerCase().includes(targetDomain.toLowerCase())) {
          console.log(`[HARVESTER] Target ditemukan di direktori: ${url}`);
          
          // Ekstrak semua path (misal: POST /api/v1/chat) dari HTML/JSON mentah
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
    await crawler.run(serverUrls);
  } catch (err) {
    console.log(`[HARVESTER] Fail run crawler at directory: ${err.message}`);
  }

  if (discoveredPaths.length > 0) {
    console.log(`[HARVESTER] Success ${discoveredPaths.length} path form directory!`);
  } else {
    console.log(`[HARVESTER] Target not found at directory, or no path.`);
  }

  return discoveredPaths;
}
