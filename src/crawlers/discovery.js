// src/crawlers/discovery.js (hanya bagian crawlDirectoryPlatform yang baru)

export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Mencari data domain '${targetDomain}' melalui direktori x402scan...`);
    
    // Bersihkan domain: ambil hanya hostname, huruf kecil
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
        // Endpoint pencarian server x402scan (API publik yang sudah terverifikasi)
        const searchUrl = `https://www.x402scan.com/api/trpc/server.search?input=${encodeURIComponent(JSON.stringify({ query: cleanDomain }))}`;
        const searchResp = await got(searchUrl, { 
            headers: fetchHeaders, 
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false 
        });

        if (searchResp.statusCode === 200) {
            const searchData = JSON.parse(searchResp.body);
            // Cari server yang domainnya cocok persis
            const servers = searchData?.result?.data?.json || [];
            const matched = servers.find(s => {
                const sDomain = (s.domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
                return sDomain === cleanDomain;
            });
            if (matched && matched.id) {
                serverId = matched.id;
                console.log(`[HARVESTER] UUID ditemukan: ${serverId}`);
            }
        } else {
            console.log(`[HARVESTER] Pencarian API gagal (status ${searchResp.statusCode}).`);
        }
    } catch (err) {
        console.log(`[HARVESTER] Error mencari UUID: ${err.message}`);
    }

    // ============================================================
    // 2. MENGAMBIL DETAIL SERVER (ENDPOINT) DARI API tRPC
    // ============================================================
    if (serverId) {
        try {
            const detailUrl = `https://www.x402scan.com/api/trpc/server.getById?input=${encodeURIComponent(JSON.stringify({ id: serverId }))}`;
            const detailResp = await got(detailUrl, { 
                headers: fetchHeaders, 
                timeout: { request: Math.max(timeout, 15000) },
                throwHttpErrors: false 
            });

            if (detailResp.statusCode === 200) {
                const detailData = JSON.parse(detailResp.body);
                const resources = detailData?.result?.data?.json?.resources || [];
                
                // Format data endpoint
                const endpoints = resources.map(r => ({
                    path: r.path || r.endpoint || '',
                    method: r.method || 'GET',
                    label: r.name || r.label || '',
                    rawPrice: String(Math.round((r.price || 0) * 1_000_000)),
                    description: r.description || r.name || '',
                    network: r.network || '',
                    asset: r.asset || r.token || '',
                    payTo: r.payTo || r.address || '',
                    source: 'x402scan-api'
                })).filter(ep => ep.path);

                if (endpoints.length > 0) {
                    console.log(`[HARVESTER] Berhasil mendapatkan ${endpoints.length} endpoint melalui API.`);
                    return endpoints;
                }
            }
        } catch (err) {
            console.log(`[HARVESTER] Gagal mengambil detail server: ${err.message}`);
        }
    }

    // ============================================================
    // 3. FALLBACK: SCRAPING HALAMAN PUBLIK (JIKA API GAGAL)
    // ============================================================
    console.log('[HARVESTER] Mencoba scraping halaman publik sebagai fallback...');
    try {
        const pageUrl = `https://www.x402scan.com/server/${cleanDomain}`;
        const pageResp = await got(pageUrl, { 
            headers: { ...fetchHeaders, 'Accept': 'text/html' }, 
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false 
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
                    source: 'x402scan-html'
                });
            }
            if (endpoints.length > 0) {
                console.log(`[HARVESTER] Berhasil scraping ${endpoints.length} endpoint dari HTML.`);
                return endpoints;
            }
        }
    } catch (err) {
        console.log(`[HARVESTER] Scraping halaman publik gagal: ${err.message}`);
    }

    console.log('[HARVESTER] Tidak ada data ditemukan.');
    return [];
}
