// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import * as cheerio from 'cheerio'; // pastikan cheerio terinstal
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
        additionalMimeTypes: ['text/plain', 'application/json'],
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
 * HARVESTER: Scrape halaman publik x402scan untuk mendapatkan data lengkap endpoint
 */
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Scraping x402scan public page for ${targetDomain}...`);
    
    const url = `https://www.x402scan.com/server/${targetDomain}`;
    
    try {
        const options = {
            method: 'GET',
            timeout: { request: Math.max(timeout || 15000, 20000) },
            throwHttpErrors: false,
            retry: { limit: 3, methods: ['GET'] },
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        };

        const response = await got(url, options);
        
        if (response.statusCode !== 200) {
            console.log(`[HARVESTER] x402scan page returned ${response.statusCode}`);
            return [];
        }

        const $ = cheerio.load(response.body);
        const endpoints = [];

        // Cari semua resource card di halaman x402scan
        // Setiap resource biasanya dalam elemen dengan class tertentu
        $('a[href^="/server/"]').each((i, el) => {
            // Ini link ke resource lain, bukan endpoint API
        });

        // Cari teks yang mengandung endpoint pattern
        const bodyText = $('body').text();
        
        // Pattern untuk mengekstrak informasi endpoint dari halaman x402scan
        // Format: METHOD /path Label Price: $X.XX Network: network
        const endpointPattern = /(GET|POST|PUT|DELETE)\s+(\/[^\s]+)\s+(.+?)\s+US\$([\d.]+)/gi;
        let match;
        
        while ((match = endpointPattern.exec(bodyText)) !== null) {
            const method = match[1];
            const path = match[2];
            const label = match[3].trim();
            const price = String(Math.round(parseFloat(match[4]) * 1_000_000));
            
            endpoints.push({
                path,
                method,
                label,
                rawPrice: price,
                description: label,
                network: '', // Akan diisi dari sumber lain
                asset: '',   // Akan diisi dari sumber lain
                source: 'x402scan-directory'
            });
        }

        console.log(`[HARVESTER] Extracted ${endpoints.length} endpoints from x402scan.`);
        return endpoints;

    } catch (err) {
        console.log(`[HARVESTER] Failed to scrape x402scan: ${err.message}`);
        return [];
    }
}
