// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import * as cheerio from 'cheerio';
import got from 'got';

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
 * Ekstrak endpoint dari teks menggunakan regex universal
 */
function extractEndpointsFromText(text, sourceLabel = 'direct-scrape') {
    const endpoints = [];
    const regex = /(GET|POST|PUT|DELETE)\s+(\/[^\s]+)\s+(.+?)\s+US\$([\d.]+)/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
        endpoints.push({
            path: match[2],
            method: match[1],
            label: match[3].trim(),
            rawPrice: String(Math.round(parseFloat(match[4]) * 1_000_000)),
            description: match[3].trim(),
            network: '',
            asset: '',
            source: sourceLabel
        });
    }

    return endpoints;
}

/**
 * HARVESTER: Mencari data endpoint dari berbagai sumber
 * 1. x402scan directory (via halaman utama atau API)
 * 2. Scraping langsung domain target (fallback)
 */
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Searching '${targetDomain}' in x402scan.com directory...`);
    
    const cleanDomain = targetDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    const fetchHeaders = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    // ============================================================
    // 1. COBA X402SCAN DIRECTORY (VIA HALAMAN UTAMA)
    // ============================================================
    try {
        const mainPageUrl = 'https://www.x402scan.com/';
        const mainResp = await got(mainPageUrl, {
            headers: fetchHeaders,
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 1 } // Hanya sekali coba, jangan buang waktu
        });

        if (mainResp.statusCode === 200) {
            const $ = cheerio.load(mainResp.body);
            const serverLinks = {};

            $('a[href^="/server/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                
                const uuidMatch = href.match(/\/server\/([a-f0-9-]+)/);
                if (!uuidMatch) return;
                
                const uuid = uuidMatch[1];
                const parentText = $(el).closest('div, li, tr').text() || $(el).text();
                const domainMatch = parentText.match(/([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/);
                
                if (domainMatch) {
                    const foundDomain = domainMatch[0].toLowerCase();
                    if (!serverLinks[foundDomain]) {
                        serverLinks[foundDomain] = uuid;
                    }
                }
            });

            console.log(`[HARVESTER] Found ${Object.keys(serverLinks).length} servers on main page.`);

            // Cari UUID untuk domain kita
            let matchedUUID = serverLinks[cleanDomain];
            if (!matchedUUID) {
                for (const [d, u] of Object.entries(serverLinks)) {
                    if (d.includes(cleanDomain) || cleanDomain.includes(d)) {
                        matchedUUID = u;
                        break;
                    }
                }
            }

            if (matchedUUID) {
                console.log(`[HARVESTER] UUID found: ${matchedUUID}`);
                
                // Akses halaman detail
                const detailUrl = `https://www.x402scan.com/server/${matchedUUID}`;
                const detailResp = await got(detailUrl, {
                    headers: fetchHeaders,
                    timeout: { request: Math.max(timeout, 15000) },
                    throwHttpErrors: false,
                    retry: { limit: 1 }
                });

                if (detailResp.statusCode === 200) {
                    const endpoints = extractEndpointsFromText(detailResp.body, 'x402scan-directory');
                    if (endpoints.length > 0) {
                        console.log(`[HARVESTER] Successfully extracted ${endpoints.length} endpoints from x402scan.`);
                        return endpoints;
                    }
                }
            }
        }
    } catch (err) {
        console.log(`[HARVESTER] x402scan main page error: ${err.message}`);
    }

    // ============================================================
    // 2. FALLBACK: SCRAPING LANGSUNG DOMAIN TARGET
    // ============================================================
    console.log(`[HARVESTER] Attempting direct scrape of https://${cleanDomain}...`);
    
    try {
        const directUrl = `https://${cleanDomain}`;
        const directResp = await got(directUrl, {
            headers: fetchHeaders,
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (directResp.statusCode === 200) {
            // Coba ekstrak endpoint dari halaman utama
            const endpoints = extractEndpointsFromText(directResp.body, 'direct-scrape');
            if (endpoints.length > 0) {
                console.log(`[HARVESTER] Successfully scraped ${endpoints.length} endpoints from domain.`);
                return endpoints;
            }

            // Jika tidak ada pola US$, coba cari pola harga lain
            // Misalnya: $X.XX per request, Price: $X.XX, dll.
            const altRegex = /(\/[^\s]+).*?\$([\d.]+)/gi;
            let altMatch;
            while ((altMatch = altRegex.exec(directResp.body)) !== null) {
                endpoints.push({
                    path: altMatch[1],
                    method: 'GET',
                    label: altMatch[1],
                    rawPrice: String(Math.round(parseFloat(altMatch[2]) * 1_000_000)),
                    description: altMatch[1],
                    network: '',
                    asset: '',
                    source: 'direct-scrape-fallback'
                });
            }
            
            if (endpoints.length > 0) {
                console.log(`[HARVESTER] Extracted ${endpoints.length} endpoints using alternative regex.`);
                return endpoints;
            }
        }
    } catch (err) {
        console.log(`[HARVESTER] Direct scrape error: ${err.message}`);
    }

    console.log('[HARVESTER] No data found from any source.');
    return [];
}
