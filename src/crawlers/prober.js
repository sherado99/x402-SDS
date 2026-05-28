// src/crawlers/prober.js
import { BasicCrawler } from 'crawlee';
import { normalizePath } from '../utils/helpers.js';

export async function scrapeEndpoints(base, candidates, timeout, proxyConfiguration) {
  const scraped = [];

  const requests = candidates.map(item => {
    const path = normalizePath(item.path);
    return {
      url: `https://${base}${path}`,
      userData: { candidate: item, start: Date.now() },
      method: String(item.method || 'GET').toUpperCase(),
    };
  });

  const crawler = new BasicCrawler({
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 2,
    // RATE LIMITER: Hanya jalankan maksimal 2 request bersamaan (sebelumnya 8)
    maxConcurrency: 2, 
    maxRequestRetries: 0, 
    async requestHandler({ request, sendRequest }) {
      const { candidate, start } = request.userData;
      console.log(`[PROBER] Fetching: ${request.method} ${request.url}`);
      
      try {
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

        const response = await sendRequest({
          url: request.url,
          method: request.method,
          timeout: { request: timeout },
          throwHttpErrors: false,
          proxyUrl: proxyUrl,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' }
        });

        let finalBody = response.body;

        // BASE64 DECODER UNTUK X402 VERSI 2
        if (response.statusCode === 402 && response.headers['payment-required']) {
            try {
                // Buka "kardus" Base64
                const decoded = Buffer.from(response.headers['payment-required'], 'base64').toString('utf-8');
                console.log(`[PROBER] Success decoded X402 v2 header for ${request.url}`);
                // Timpa body kosong dengan data JSON yang sudah di-decode agar mudah dibaca Parser
                finalBody = decoded; 
            } catch (e) {
                console.log(`[PROBER] Failed to decode Base64: ${e.message}`);
            }
        }

        console.log(`[PROBER] Done: ${request.method} ${request.url} -> Status: ${response.statusCode}`);

        scraped.push({
          candidate,
          statusCode: response.statusCode,
          body: finalBody, // Menggunakan body yang sudah berisi data tagihan
          responseTime: Date.now() - start,
          error: null,
        });

        // RATE LIMITER: Beri jeda napas 1.5 detik sebelum lanjut ke request berikutnya
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (err) {
        console.log(`[PROBER] Error: ${request.method} ${request.url} -> ${err.message}`);
        scraped.push({
          candidate,
          statusCode: 0,
          body: '',
          responseTime: Date.now() - start,
          error: err.message,
        });
      }
    },
    async failedRequestHandler({ request, error }) {
      const { candidate, start } = request.userData;
      scraped.push({
        candidate,
        statusCode: 0,
        body: '',
        responseTime: Date.now() - start,
        error: error.message,
      });
    }
  });

  await crawler.run(requests);
  console.log(`[SCRAPER] ${scraped.length} endpoints scraped`);
  return scraped;
}
