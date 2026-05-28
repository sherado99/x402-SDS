// src/crawlers/prober.js
import { BasicCrawler } from 'crawlee';
import { normalizePath } from '../utils/helpers.js';

export async function scrapeEndpoints(base, candidates, timeout, proxyConfiguration) {
  const scraped = [];

  // Prepare request list from candidates
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
    maxConcurrency: 8,
    maxRequestRetries: 0, // Prevent hanging by disabling retries
    async requestHandler({ request, sendRequest }) {
      const { candidate, start } = request.userData;
      console.log(`[PROBER] Fetching: ${request.method} ${request.url}`);
      
      try {
        // Dynamically get proxy URL if configuration is available
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

        const response = await sendRequest({
          url: request.url,
          method: request.method,
          timeout: { request: timeout },
          throwHttpErrors: false,
          proxyUrl: proxyUrl,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApifyBot/1.0)', Accept: '*/*' }
        });

        console.log(`[PROBER] Done: ${request.method} ${request.url} -> Status: ${response.statusCode}`);

        scraped.push({
          candidate,
          statusCode: response.statusCode,
          body: response.body,
          responseTime: Date.now() - start,
          error: null,
        });
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
      console.log(`[PROBER] Failed completely: ${request.method} ${request.url} -> ${error.message}`);
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
