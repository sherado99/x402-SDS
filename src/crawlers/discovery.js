// Fungsi bantuan untuk ekstrak endpoint dari teks (fallback)
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

/**
 * HARVESTER: Mencari data endpoint dari direktori x402scan
 * 1. Scraping halaman utama x402scan untuk mendapatkan UUID domain
 * 2. Akses halaman detail server dengan UUID tersebut
 * 3. Ekstrak endpoint menggunakan regex
 */
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Searching '${targetDomain}' in x402scan.com directory...`);
    
    const cleanDomain = targetDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    const fetchHeaders = {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    try {
        // 1. Ambil halaman utama x402scan
        const mainResp = await got('https://www.x402scan.com/', {
            headers: fetchHeaders,
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (mainResp.statusCode !== 200) {
            console.log(`[HARVESTER] Failed to fetch x402scan main page (status ${mainResp.statusCode}).`);
            return [];
        }

        const $ = cheerio.load(mainResp.body);
        let matchedUUID = null;

        // Cari semua link "Try it" yang mengarah ke /server/{uuid}
        $('a[href^="/server/"]').each((i, el) => {
            if (matchedUUID) return; // sudah ketemu
            
            const href = $(el).attr('href');
            const uuidMatch = href.match(/\/server\/([a-f0-9-]+)/);
            if (!uuidMatch) return;
            
            // Cari teks domain di sekitar link.
            // Biasanya domain berada di elemen yang sama atau di parent.
            const parentText = $(el).parent().text() || $(el).text();
            
            // Jika domain target ada di teks sekitar link, ini UUID-nya
            if (parentText.toLowerCase().includes(cleanDomain)) {
                matchedUUID = uuidMatch[1];
                console.log(`[HARVESTER] Found UUID ${matchedUUID} for domain ${cleanDomain}`);
            }
        });

        // Fallback: jika tidak ketemu lewat "Try it", coba cari semua link server
        if (!matchedUUID) {
            $('a[href^="/server/"]').each((i, el) => {
                if (matchedUUID) return;
                
                const href = $(el).attr('href');
                const uuidMatch = href.match(/\/server\/([a-f0-9-]+)/);
                if (!uuidMatch) return;
                
                // Ambil teks yang lebih luas (hingga 3 level parent)
                let contextText = $(el).text();
                let parent = $(el).parent();
                for (let i = 0; i < 3 && parent.length; i++) {
                    contextText += ' ' + parent.text();
                    parent = parent.parent();
                }
                
                if (contextText.toLowerCase().includes(cleanDomain)) {
                    matchedUUID = uuidMatch[1];
                    console.log(`[HARVESTER] Found UUID ${matchedUUID} via broader search.`);
                }
            });
        }

        if (!matchedUUID) {
            console.log(`[HARVESTER] Domain '${cleanDomain}' not found on x402scan main page.`);
            return [];
        }

        // 2. Akses halaman detail server dengan UUID
        const detailUrl = `https://www.x402scan.com/server/${matchedUUID}`;
        const detailResp = await got(detailUrl, {
            headers: fetchHeaders,
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (detailResp.statusCode !== 200) {
            console.log(`[HARVESTER] Failed to fetch server detail (status ${detailResp.statusCode}).`);
            return [];
        }

        // 3. Ekstrak endpoint dari halaman detail
        const endpoints = extractEndpointsFromText(detailResp.body, 'x402scan-directory');
        
        if (endpoints.length > 0) {
            console.log(`[HARVESTER] Successfully extracted ${endpoints.length} endpoints from x402scan.`);
            return endpoints;
        }

        console.log('[HARVESTER] No endpoints found on detail page.');
        return [];

    } catch (err) {
        console.log(`[HARVESTER] Error: ${err.message}`);
        return [];
    }
}
