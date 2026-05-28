// src/crawlers/discovery.js
import { CheerioCrawler } from 'crawlee';
import * as cheerio from 'cheerio';
import got from 'got';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ... (fungsi fetchTextSource, crawlAPISources, crawlHTMLPages tetap sama seperti sebelumnya) ...

/**
 * HARVESTER: Mendapatkan UUID domain dari halaman utama x402scan,
 * lalu scraping halaman detail server.
 */
export async function crawlDirectoryPlatform(targetDomain, timeout, proxyConfiguration) {
    console.log(`[HARVESTER] Mencari data untuk '${targetDomain}' melalui x402scan...`);
    
    const cleanDomain = targetDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

    try {
        // 1. Ambil halaman utama x402scan
        const mainPageUrl = 'https://www.x402scan.com/';
        const mainResp = await got(mainPageUrl, {
            headers: { 'User-Agent': getRandomUserAgent(), 'Accept': 'text/html' },
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (mainResp.statusCode !== 200) {
            console.log(`[HARVESTER] Gagal mengambil halaman utama x402scan (status ${mainResp.statusCode}).`);
            return [];
        }

        const $ = cheerio.load(mainResp.body);
        
        // 2. Cari semua link server (format: /server/{uuid})
        const serverLinks = {};
        $('a[href^="/server/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            
            const uuidMatch = href.match(/\/server\/([a-f0-9-]+)/);
            if (!uuidMatch) return;
            
            const uuid = uuidMatch[1];
            // Cari teks domain di sekitar link (biasanya dalam elemen yang sama atau bersebelahan)
            const parentText = $(el).parent().text() || $(el).text();
            const domainMatch = parentText.match(/([a-zA-Z0-9-]+\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/);
            
            if (domainMatch) {
                const foundDomain = domainMatch[0].toLowerCase();
                serverLinks[foundDomain] = uuid;
            }
        });

        console.log(`[HARVESTER] Ditemukan ${Object.keys(serverLinks).length} server di halaman utama.`);

        // 3. Cari UUID untuk domain kita
        const matchedUUID = serverLinks[cleanDomain] || 
                           Object.values(serverLinks).find(uuid => uuid); // Fallback: ambil UUID pertama jika tidak cocok
        
        if (!matchedUUID) {
            console.log(`[HARVESTER] Domain '${cleanDomain}' tidak ditemukan di halaman utama x402scan.`);
            return [];
        }

        console.log(`[HARVESTER] UUID ditemukan: ${matchedUUID}`);

        // 4. Akses halaman detail server
        const detailUrl = `https://www.x402scan.com/server/${matchedUUID}`;
        const detailResp = await got(detailUrl, {
            headers: { 'User-Agent': getRandomUserAgent(), 'Accept': 'text/html' },
            timeout: { request: Math.max(timeout, 15000) },
            throwHttpErrors: false,
            retry: { limit: 2 }
        });

        if (detailResp.statusCode !== 200) {
            console.log(`[HARVESTER] Gagal mengambil halaman detail (status ${detailResp.statusCode}).`);
            return [];
        }

        // 5. Ekstrak endpoint dengan regex
        const html = detailResp.body;
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
                source: 'x402scan-directory'
            });
        }

        console.log(`[HARVESTER] Berhasil mengekstrak ${endpoints.length} endpoint.`);
        return endpoints;

    } catch (err) {
        console.log(`[HARVESTER] Error: ${err.message}`);
        return [];
    }
}
