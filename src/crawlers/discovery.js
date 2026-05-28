// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import got from 'got';

export async function fetchTextSource(url, timeout, label, proxyAgent) {
  try {
    const options = {
      method: 'GET',
      timeout: { request: timeout || 10000 },
      throwHttpErrors: false,
      retry: { 
        limit: 2, 
        methods: ['GET'], 
        statusCodes: [408, 413, 429, 500, 502, 503, 504] 
      },
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*' 
      },
    };
    if (proxyAgent) options.agent = { https: proxyAgent };
    const response = await got(url, options);
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

  for (const src of sources) {
    const text = await fetchTextSource(src.url, timeout, src.label, proxyAgent);
    if (text) rawPaths.push({ source: src.label, content: text });
  }
  return rawPaths;
}

export async function crawlHTMLPages(base, timeout, proxyConfiguration) {
  const startUrls = [`https://${base}`, `https://${base}/docs`, `https://${base}/api` ];
  const discovered = new Map();
  const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', 'method', 'price'];
  
  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: 30, // Ditambah agar tidak timeout
    proxyConfiguration,
    additionalMimeTypes: ['text/plain', 'application/json'], // Cegah error Content-Type
    async requestHandler({ request, response, $, enqueueLinks }) {
      const contentType = response?.headers?.['content-type'] || '';
      if (!contentType.includes('text/html')) {
        const bodyText = String(response?.body || '');
        if (bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
        return;
      }
      try {
        const bodyText = $('body').text().toLowerCase();
        if (keywords.some(kw => bodyText.includes(kw))) discovered.set(request.url, { url: request.url, html: $.html() });
        await enqueueLinks({
          transformRequestFunction: (req) => {
            const isInternal = req.url.includes(base);
            return isInternal ? req : null;
          }
        });
      } catch (err) { /* ignore */ }
    },
  });

  await crawler.run(startUrls);
  return [...discovered.values()];
}

export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
  // Fungsi ini bisa dikosongkan jika x402scan API sering 404
  return []; 
}
