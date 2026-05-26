// src/utils/proxy.js
import { HttpsProxyAgent } from 'https-proxy-agent';

export function getProxyAgent( ) {
  try {
    // Apify residential proxy tersedia otomatis di platform via environment variable
    const proxyUrl = process.env.APIFY_PROXY_PASSWORD
      ? `http://auto:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`
      : null;
    if (proxyUrl ) {
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (e) { 
    // Jika tidak tersedia (misal jalan di lokal tanpa proxy), lanjut tanpa proxy
  }
  return null;
}
