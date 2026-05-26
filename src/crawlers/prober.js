// src/crawlers/prober.js
import { BasicCrawler } from 'crawlee';
import { normalizePath } from '../utils/helpers.js';

export async function scrapeEndpoints(base, candidates, timeout, proxyConfiguration) {
  const scraped = [];
  
  // Menyiapkan daftar request dari candidates
  const requests = candidates.map(item => {
    const path = normalizePath(item.path);
    return {
      url: `https://${base}${path}`,
      userData: { candidate: item, start: Date.now( ) },
      method: String(item.method || 'GET').toUpperCase(),
    };
  });

  const crawler = new BasicCrawler({
    requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 2,
    maxConcurrency: 8,
    // HAPUS proxyConfiguration dari sini
    async requestHandler({ request, sendRequest }) {
      const { candidate, start } = request.userData;
      try {
        // Ambil URL proxy secara dinamis jika proxyConfiguration tersedia
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

        const response = await sendRequest({
          url: request.url,
          method: request.method,
          timeout: { request: timeout },
          throwHttpErrors: false,
          proxyUrl: proxyUrl, // Masukkan proxy di sini
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' }
        });
        
        scraped.push({
          candidate,
          statusCode: response.statusCode,
          body: response.body,
          responseTime: Date.now() - start,
          error: null,
        });
      } catch (err) {
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
