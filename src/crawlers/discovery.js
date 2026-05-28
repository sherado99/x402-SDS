// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import got from 'got';

// Rotasi User-Agent untuk menghindari blokir
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export async function fetchTextSource(url, timeout, label, proxyAgent) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const options = {
                method: 'GET',
                timeout: { request: Math.max(timeout || 15000, 15000) + (attempt * 5000) },
                throwHttpErrors: false,
                retry: { limit: 0 },
                headers: { 
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'application/json, text/plain, text/html, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            };
            if (proxyAgent) options.agent = { https: proxyAgent };

            const response = await got(url, options);
            if (response.statusCode === 200 && response.body && response.body.length > 10) {
                console.log(`[FETCH] ${label}: SUCCESS (${response.body.length} bytes, attempt ${attempt + 1})`);
                return response.body;
            } else if (response.statusCode === 404) {
                console.log(`[FETCH] ${label}: Not Found (404) - skipping.`);
                return null;
            } else {
                console.log(`[FETCH] ${label}: Failed with status ${response.statusCode} (attempt ${attempt + 1}).`);
            }
        } catch (err) {
            console.log(`[FETCH] ${label}: Error "${err.message}" (attempt ${attempt + 1}).`);
        }

        if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    console.log(`[FETCH] ${label}: All attempts failed.`);
    return null;
}

export async function crawlAPISources(base, timeout, proxyAgent) {
    const rawPaths = [];
    const sources = [
        { url: `https://${base}/.well-known/x402`,                label: 'well-known-x402' },
        { url: `https://${base}/llms.txt`,                        label: 'llms.txt' },
        { url: `https://${base}/.well-known/agent-card.json`,     label: 'agent-card' },
        { url: `https://${base}/.well-known/agent.json`,          label: 'agent.json' },
        { url: `https://${base}/.well-known/agent-services.json`, label: 'agent-services' },
        { url: `https://${base}/openapi.json`,                    label: 'openapi' },
        { url: `https://${base}/swagger.json`,                    label: 'swagger' },
        { url: `https://${base}/health`,                          label: 'health' },
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
    const startUrls = [`https://${base}`, `https://${base}/docs`, `https://${base}/api`, `https://${base}/pricing`];
    const discovered = new Map();
    const keywords = ['x402', 'agent', 'payment', 'endpoint', 'pricing', 'service', '/api/', 'usdc', '$0.', 'method', 'price', 'post /', 'get /'];

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: 25,
        requestHandlerTimeoutSecs: Math.ceil((timeout || 15000) / 1000) + 15,
        proxyConfiguration,
        additionalMimeTypes: ['text/plain', 'application/json', 'application/xml'],
        async requestHandler({ request, response, $, enqueueLinks }) {
            const contentType = response?.headers?.['content-type'] || '';
            const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
            
            if (!isHtml) {
                const bodyText = String(response?.body || '');
                if (bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
                return;
            }

            try {
                const bodyText = $('body').text().toLowerCase();
                const matched = keywords.filter(kw => bodyText.includes(kw));
                if (matched.length > 0) discovered.set(request.url, { url: request.url, html: $.html() });

                await enqueueLinks({
                    transformRequestFunction(req) {
                        try {
                            if (req.url.includes(base) && keywords.some(kw => req.url.toLowerCase().includes(kw))) {
                                return req;
                            }
                        } catch { /* ignore */ }
                        return null;
                    }
                });
            } catch (err) {
                const bodyText = String(response?.body || '');
                if (bodyText.length > 10) discovered.set(request.url, { url: request.url, html: bodyText });
            }
        },
    });

    await crawler.run(startUrls);
    return [...discovered.values()];
}

/**
 * HARVESTER: Mencari data endpoint dari direktori x402scan
 * Prioritas: API tRPC -> Fallback scraping halaman HTML
 */
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Searching '${targetDomain}' in x402scan.com directory...`);
    
    // Bersihkan domain: hanya hostname, huruf kecil
    const cleanDomain = targetDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

    const fetchHeaders = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
    };

    // ============================================================
    // 1. MENDAPATKAN UUID DARI DOMAIN (API tRPC)
    // ============================================================
    let serverId = null;
    try {
        // API pencarian server x402scan (menggunakan input yang tepat)
        const searchUrl = `https://www.x402scan.com/api/trpc/server.search?input=${encodeURIComponent(JSON.stringify({ json: { query: cleanDomain } }))}`;
        const searchResp = await got(searchUrl, { 
            headers: fetchHeaders, 
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (searchResp.statusCode === 200) {
            const searchData = JSON.parse(searchResp.body);
            // Struktur respons tRPC: result.data.json adalah array server
            const servers = searchData?.result?.data?.json || [];
            const matched = servers.find(s => {
                const sDomain = (s.domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
                return sDomain === cleanDomain;
            });
            if (matched && matched.id) {
                serverId = matched.id;
                console.log(`[HARVESTER] UUID found: ${serverId}`);
            }
        } else {
            console.log(`[HARVESTER] Search API failed with status ${searchResp.statusCode}.`);
        }
    } catch (err) {
        console.log(`[HARVESTER] Error searching UUID: ${err.message}`);
    }

    // ============================================================
    // 2. MENGAMBIL DETAIL SERVER DARI API tRPC
    // ============================================================
    if (serverId) {
        try {
            const detailUrl = `https://www.x402scan.com/api/trpc/server.getById?input=${encodeURIComponent(JSON.stringify({ json: serverId }))}`;
            const detailResp = await got(detailUrl, { 
                headers: fetchHeaders, 
                timeout: { request: Math.max(timeout, 15000) },
                throwHttpErrors: false,
                retry: { limit: 2 }
            });

            if (detailResp.statusCode === 200) {
                const detailData = JSON.parse(detailResp.body);
                const resources = detailData?.result?.data?.json?.resources || [];
                
                const endpoints = resources.map(r => ({
                    path: r.path || r.endpoint || '',
                    method: r.method || 'GET',
                    label: r.name || r.label || '',
                    rawPrice: String(Math.round((r.price || 0) * 1_000_000)),
                    description: r.description || r.name || '',
                    network: r.network || r.chain || '',
                    asset: r.asset || r.token || '',
                    payTo: r.payTo || r.address || '',
                    source: 'x402scan-api'
                })).filter(ep => ep.path);

                if (endpoints.length > 0) {
                    console.log(`[HARVESTER] Successfully retrieved ${endpoints.length} endpoints via API.`);
                    return endpoints;
                }
            } else {
                console.log(`[HARVESTER] Detail API failed with status ${detailResp.statusCode}.`);
            }
        } catch (err) {
            console.log(`[HARVESTER] Error fetching server details: ${err.message}`);
        }
    }

    // ============================================================
    // 3. FALLBACK: SCRAPING HALAMAN PUBLIK (JIKA API GAGAL)
    // ============================================================
    console.log('[HARVESTER] Attempting fallback to public page scraping...');
    try {
        const pageUrl = `https://www.x402scan.com/server/${cleanDomain}`;
        const pageResp = await got(pageUrl, { 
            headers: { ...fetchHeaders, 'Accept': 'text/html' }, 
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 1 }
        });

        if (pageResp.statusCode === 200) {
            const html = pageResp.body;
            const endpoints = [];
            const regex = /(GET|POST|PUT|DELETE)\s+(\/[^\s]+)\s+(.+?)\s+US\$([\d.]+)/gi;
            let match;
            while ((match = regex.exec(html)) !== null) {
                endpoints.push({
                    path: match[2],
                    method: match[1],
                    label: match[3].trim(),
                    rawPrice: String(Math.round(parseFloat(match[4]) * 1_000_000)),
                    description: match[3].trim(),
                    network: '',
                    asset: '',
                    payTo: '',
                    source: 'x402scan-html'
                });
            }
            if (endpoints.length > 0) {
                console.log(`[HARVESTER] Successfully scraped ${endpoints.length} endpoints from HTML.`);
                return endpoints;
            }
        } else {
            console.log(`[HARVESTER] Public page returned status ${pageResp.statusCode}.`);
        }
    } catch (err) {
        console.log(`[HARVESTER] Public page scraping failed: ${err.message}`);
    }

    console.log('[HARVESTER] No data found.');
    return [];
}
