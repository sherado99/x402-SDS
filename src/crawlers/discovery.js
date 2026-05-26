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
