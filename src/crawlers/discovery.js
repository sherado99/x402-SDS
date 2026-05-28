// src/crawlers/discovery.js — hanya fungsi crawlDirectoryPlatform yang baru

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
        
        // Struktur respons tRPC batch: array of { result: { data: { json: ... } } }
        const originsResult = searchData?.[0]?.result?.data?.json || [];
        const resourcesResult = searchData?.[1]?.result?.data?.json || [];

        console.log(`[HARVESTER] API returned ${originsResult.length} origins, ${resourcesResult.length} resources.`);

        // Cari UUID dari origins
        let matchedUUID = null;
        for (const origin of originsResult) {
            const originDomain = (origin.domain || origin.url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
            if (originDomain === cleanDomain) {
                matchedUUID = origin.id;
                break;
            }
        }

        if (!matchedUUID) {
            console.log(`[HARVESTER] Domain '${cleanDomain}' not found in API response.`);
            return [];
        }

        console.log(`[HARVESTER] Found UUID via API: ${matchedUUID}`);

        // 2. Akses halaman detail server dengan UUID
        const detailUrl = `https://www.x402scan.com/server/${matchedUUID}`;
        const detailResp = await got(detailUrl, {
            headers: { ...fetchHeaders, 'Accept': 'text/html' },
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (detailResp.statusCode !== 200) {
            console.log(`[HARVESTER] Failed to fetch server detail (status ${detailResp.statusCode}).`);
            return [];
        }

        // 3. Ekstrak endpoint dari halaman detail
        const endpoints = [];
        const regex = /(GET|POST|PUT|DELETE)\s+(\/[^\s]+)\s+(.+?)\s+US\$([\d.]+)/gi;
        let match;

        while ((match = regex.exec(detailResp.body)) !== null) {
            endpoints.push({
                path: match[2],
                method: match[1],
                label: match[3].trim(),
                rawPrice: String(Math.round(parseFloat(match[4]) * 1_000_000)),
                description: match[3].trim(),
                network: '',
                asset: '',
                source: 'x402scan-directory'
            });
        }

        console.log(`[HARVESTER] Successfully extracted ${endpoints.length} endpoints from x402scan.`);
        return endpoints;

    } catch (err) {
        console.log(`[HARVESTER] API error: ${err.message}`);
        return [];
    }
}
