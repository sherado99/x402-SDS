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
  const startUrls = [`https://${base}`, `https://${base}/docs`, `https://${base}/api`];
  const discovered = new Map();
  const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', 'method', 'price'];

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 20,
    requestHandlerTimeoutSecs: 30,
    proxyConfiguration,
    additionalMimeTypes: ['text/plain', 'application/json'],
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

// ============================================================
// THE HARVESTER — x402scan.com Directory Scraper
// Sumber paling kaya: direktori publik berisi domain, path,
// harga, dan deskripsi yang sudah terindeks komunitas.
// ============================================================
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
  console.log(`\n[HARVESTER] Searching '${targetDomain}' in x402scan.com directory...`);
  const discoveredPaths = [];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.x402scan.com/',
    'Origin': 'https://www.x402scan.com',
  };

  const gotOptions = {
    headers,
    timeout: { request: timeout || 10000 },
    throwHttpErrors: false,
    retry: { limit: 1 },
  };

  try {
    // LANGKAH 1: Ambil daftar semua server dari direktori
    const listUrl = `https://www.x402scan.com/api/trpc/public.server.list?batch=1&input=${encodeURIComponent('{"0":{"json":{}}}') }`;
    const listResponse = await got(listUrl, gotOptions);

    if (listResponse.statusCode !== 200 || !listResponse.body) {
      console.log(`[HARVESTER] Directory API rejected. Status: ${listResponse.statusCode}`);
      return [];
    }

    const listData = JSON.parse(listResponse.body);
    const servers = listData[0]?.result?.data?.json || [];

    if (!Array.isArray(servers) || servers.length === 0) {
      console.log('[HARVESTER] No servers found in directory.');
      return [];
    }

    // LANGKAH 2: Cari server yang cocok dengan domain target
    const targetServer = servers.find(s => {
      const serverUrl = String(s.url || s.domain || s.host || '').toLowerCase();
      return serverUrl.includes(targetDomain.toLowerCase());
    });

    if (!targetServer?.id) {
      console.log(`[HARVESTER] '${targetDomain}' not found in directory (${servers.length} servers indexed).`);
      return [];
    }

    console.log(`[HARVESTER] Found! Server ID: ${targetServer.id}`);

    // LANGKAH 3: Ambil detail server beserta semua resourcenya
    const detailUrl = `https://www.x402scan.com/api/trpc/public.server.get?batch=1&input=${encodeURIComponent(`{"0":{"json":{"id":"${targetServer.id}"}}}`) }`;
    const detailResponse = await got(detailUrl, gotOptions);

    if (detailResponse.statusCode !== 200 || !detailResponse.body) {
      console.log(`[HARVESTER] Failed to get server detail. Status: ${detailResponse.statusCode}`);
      return [];
    }

    const detailData = JSON.parse(detailResponse.body);
    const resources = detailData[0]?.result?.data?.json?.resources || [];

    console.log(`[HARVESTER] ${resources.length} resources found in directory.`);

    // LANGKAH 4: Parse resources — handle 3 kemungkinan format
    for (const res of resources) {
      let path = '';
      let method = 'GET';
      let rawPrice = '';
      let label = '';
      let description = '';
      let network = '';
      let asset = '';

      // Format A: String URL penuh → "https://domain.com/api/endpoint"
      if (typeof res === 'string') {
        try {
          path = new URL(res).pathname;
        } catch {
          path = res.startsWith('/') ? res : `/${res}`;
        }

      // Format B: Object dengan field path/url/endpoint
      } else if (typeof res === 'object' && res !== null) {
        const rawPath = res.path || res.endpoint || res.url || res.route || '';

        // Kalau path adalah URL penuh, extract pathname-nya
        if (rawPath.startsWith('http')) {
          try {
            path = new URL(rawPath).pathname;
          } catch {
            path = rawPath;
          }
        } else {
          path = rawPath;
        }

        method      = res.method || res.verb || 'GET';
        label       = res.name  || res.label || res.title || res.id || '';
        description = res.description || res.summary || res.detail || '';
        network     = res.network || res.chain || '';
        asset       = res.asset  || res.token || '';

        // Parse harga — bisa number (dalam USDC) atau string
        if (typeof res.price === 'number') {
          rawPrice = String(Math.round(res.price * 1_000_000));
        } else if (typeof res.price === 'string' && res.price) {
          const m = res.price.match(/([\d.]+)/);
          if (m) rawPrice = String(Math.round(parseFloat(m[1]) * 1_000_000));
        } else if (typeof res.amount === 'number') {
          rawPrice = String(Math.round(res.amount * 1_000_000));
        } else if (typeof res.maxAmountRequired === 'string') {
          rawPrice = res.maxAmountRequired;
        }
      }

      // Validasi: path harus ada dan mulai dari '/'
      if (!path || !path.startsWith('/')) continue;

      discoveredPaths.push({
        path,
        method: String(method).toUpperCase(),
        rawPrice,
        label,
        description,
        network,
        asset,
        source: 'harvester:x402scan-api',
      });
    }

    console.log(`[HARVESTER] Successfully harvested ${discoveredPaths.length} valid paths.`);

  } catch (err) {
    console.log(`[HARVESTER] Error: ${err.message}`);
  }

  return discoveredPaths;
}
