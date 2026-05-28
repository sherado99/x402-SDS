// src/utils/proxy.js
import { Actor } from 'apify';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function getProxyAgent(useResidential = false) {
  try {
    const proxyUrl = process.env.APIFY_PROXY_PASSWORD
      ? `http://auto:${process.env.APIFY_PROXY_PASSWORD}@proxy.apify.com:8000`
      : null;
    if (proxyUrl) {
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (e) { /* tidak tersedia, lanjut tanpa proxy */ }
  return null;
}

export async function getProxyConfiguration(useResidential = false) {
  try {
    if (useResidential) {
      return await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
      });
    } else {
      return await Actor.createProxyConfiguration();
    }
  } catch (e) {
    return undefined;
  }
}