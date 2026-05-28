// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import * as cheerio from 'cheerio';
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
 * Fungsi bantuan untuk ekstrak endpoint dari teks (fallback)
 */
function extractEndpointsFromText(text, sourceLabel = 'unknown') {
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
            network: '', asset: '',
            source: sourceLabel
        });
    }
    return endpoints;
}

export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Searching '${targetDomain}' in x402scan.com directory...`);
    
    const cleanDomain = targetDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    const fetchHeaders = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };

    try {
        // 1. Cari UUID domain menggunakan public.origins.search
        const searchInput = encodeURIComponent(JSON.stringify({
            "0": { "json": { "search": cleanDomain, "limit": 5 } },
            "1": { "json": { "search": cleanDomain, "limit": 5 } }
        }));
        
        const searchUrl = `https://www.x402scan.com/api/trpc/public.origins.search,public.resources.search?batch=1&input=${searchInput}`;
        
        const searchResp = await got(searchUrl, {
            headers: fetchHeaders,
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (searchResp.statusCode !== 200) {
            console.log(`[HARVESTER] Search API failed with status ${searchResp.statusCode}.`);
            return [];
        }

        const searchData = JSON.parse(searchResp.body);
        
        // Bagian 0: origins.search (berisi UUID dan resource dasar)
        const originsResult = searchData?.[0]?.result?.data?.json || [];
        // Bagian 1: resources.search (berisi resource lengkap dengan harga)
        const resourcesResult = searchData?.[1]?.result?.data?.json || [];

        console.log(`[HARVESTER] API returned ${originsResult.length} origins, ${resourcesResult.length} resources.`);

        // Cari origin yang cocok dengan domain kita
        let matchedOrigin = null;
        for (const origin of originsResult) {
            const originDomain = (origin.origin || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
            if (originDomain === cleanDomain) {
                matchedOrigin = origin;
                break;
            }
        }

        // Fallback: jika tidak cocok, coba dengan domain yang mengandung
        if (!matchedOrigin) {
            for (const origin of originsResult) {
                const originDomain = (origin.origin || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
                if (originDomain.includes(cleanDomain) || cleanDomain.includes(originDomain)) {
                    matchedOrigin = origin;
                    break;
                }
            }
        }

        if (!matchedOrigin) {
            console.log(`[HARVESTER] Domain '${cleanDomain}' not found in API response.`);
            return [];
        }

        console.log(`[HARVESTER] Found origin: ${matchedOrigin.origin} (${matchedOrigin.resources?.length || 0} resources)`);

        // 2. Proses resource dari origins (cukup untuk sebagian besar data)
        const endpoints = [];
        
        if (matchedOrigin.resources) {
            for (const resource of matchedOrigin.resources) {
                // Ekstrak path dari URL resource
                const resourceUrl = resource.resource || '';
                const pathMatch = resourceUrl.match(/https?:\/\/[^\/]+(\/.*)/);
                const path = pathMatch ? pathMatch[1] : resourceUrl;
                
                // Ambil harga dari resourcesResult yang cocok
                let price = '';
                let description = '';
                let network = '';
                let asset = '';
                let payTo = '';
                
                const matchedResource = resourcesResult.find(r => r.id === resource.id);
                if (matchedResource?.accepts?.[0]) {
                    const accept = matchedResource.accepts[0];
                    price = String(accept.maxAmountRequired || '');
                    description = accept.description || '';
                    network = accept.network || '';
                    asset = accept.asset || '';
                    payTo = accept.payTo || '';
                }
                
                endpoints.push({
                    path: path || resourceUrl,
                    method: 'GET',
                    label: description || path,
                    rawPrice: price,
                    description: description,
                    network: network,
                    asset: asset,
                    payTo: payTo,
                    source: 'x402scan-api'
                });
            }
        }

        console.log(`[HARVESTER] Successfully extracted ${endpoints.length} endpoints from API.`);
        return endpoints;

    } catch (err) {
        console.log(`[HARVESTER] API error: ${err.message}`);
        return [];
    }
}
