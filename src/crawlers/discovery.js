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
// THE HARVESTER: tRPC API Scraper (Fast & Cost-Effective)
// ============================================================
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
  console.log(`\n[HARVESTER] Searching for '${targetDomain}' map on x402scan.com via tRPC API...`);
  const discoveredPaths = [];

  // Headers penyamaran agar kita terlihat seperti browser asli
  const fakeHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.x402scan.com/',
    'Origin': 'https://www.x402scan.com'
  };

  try {
    // 1. Fetch the list of all servers from the tRPC API
    const listUrl = `https://www.x402scan.com/api/trpc/public.server.list?batch=1&input=${encodeURIComponent('{"0":{"json":{}}}' )}`;
    const listResponse = await got(listUrl, { 
      headers: fakeHeaders,
      timeout: { request: timeout }, 
      throwHttpErrors: false 
    });
    
    if (listResponse.statusCode === 200 && listResponse.body) {
      const listData = JSON.parse(listResponse.body);
      // tRPC batch response usually returns an array
      const servers = listData[0]?.result?.data?.json || [];
      
      // 2. Find the server whose URL matches our target domain
      const targetServer = servers.find(s => s.url && s.url.toLowerCase().includes(targetDomain.toLowerCase()));
      
      if (targetServer && targetServer.id) {
        console.log(`[HARVESTER] Target found! Server ID: ${targetServer.id}`);
        
        // 3. Fetch endpoint details for that specific server via tRPC API
        const detailUrl = `https://www.x402scan.com/api/trpc/public.server.get?batch=1&input=${encodeURIComponent(`{"0":{"json":{"id":"${targetServer.id}"}}}` )}`;
        const detailResponse = await got(detailUrl, { 
          headers: fakeHeaders,
          timeout: { request: timeout }, 
          throwHttpErrors: false 
        });
        
        if (detailResponse.statusCode === 200 && detailResponse.body) {
          const detailData = JSON.parse(detailResponse.body);
          const resources = detailData[0]?.result?.data?.json?.resources || [];
          
          console.log(`[HARVESTER] Found ${resources.length} resources in the API!`);
          
          // 4. Extract the paths beserta HARGA dan DESKRIPSI
          for (const res of resources) {
            if (res.path) {
              discoveredPaths.push({
                method: res.method || 'GET',
                path: res.path,
                rawPrice: res.price ? String(res.price) : '',
                label: res.name || res.label || res.title || '',
                description: res.description || '',
                network: res.network || '',
                asset: res.asset || '',
                source: 'harvester:x402scan-api'
              });
            }
          }
