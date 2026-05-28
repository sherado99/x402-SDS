// src/parsers/index.js
import { normalizePath, normalizeCandidate, uniqCandidates, isValidCandidate } from '../utils/helpers.js';
import { extractPrice, parseWellKnownX402, parseAgentCard, parseOpenAPI, parseHealth, parseLLMsTxt, parseJSONLike } from './extractors.js';
import { universalExtract } from './universal.js';

function smartRouter(candidates, sourceLabel) {
  const cleaned = [];
  for (const candidate of candidates) {
    let cleanPath = candidate.path.replace(/[`\\\n\r<>]/g, '').trim();
    if (!cleanPath.startsWith('/') || cleanPath.length < 2) continue;
    if (cleanPath.includes('<') || cleanPath.includes('>')) continue;
    if (candidate.label && (candidate.label.includes('<html') || candidate.label.includes('<pre>') || candidate.label.includes('<code>'))) continue;
    
    let cleanLabel = (candidate.label || '').replace(/<[^>]+>/g, '').replace(/[`\\]/g, '').trim();
    let cleanDesc = (candidate.description || '').replace(/<[^>]+>/g, '').trim();
    
    const markdownRegex = /^(\*\*|`|_)?(GET|POST|PUT|DELETE|PATCH)\s+[^*-]+(\*\*|`|_)?\s*[-—:]\s*/i;
    cleanLabel = cleanLabel.replace(markdownRegex, '').trim();
    cleanDesc = cleanDesc.replace(markdownRegex, '').trim();

    if (!cleanLabel) cleanLabel = cleanPath.split('/').filter(Boolean).pop() || cleanPath;
    
    if (sourceLabel === 'scraper' || sourceLabel === 'llms.txt' || sourceLabel === 'mcp.json' || sourceLabel === 'api-docs') {
      if (!candidate.rawPrice || candidate.rawPrice === '0') continue;
    }
    cleaned.push({ ...candidate, path: cleanPath, label: cleanLabel, description: cleanDesc });
  }
  return cleaned;
}

export function parseAllRawData(rawPaths, scrapedData) {
  const candidates = [];

  // 1. Parse raw API sources
  for (const { source, content } of rawPaths) {
    let parsed = [];
    if (source === 'well-known-x402') parsed = parseWellKnownX402(content);
    else if (source.startsWith('agent-')) parsed = parseAgentCard(content);
    else if (source === 'openapi' || source === 'swagger') parsed = parseOpenAPI(content);
    else if (source === 'health') parsed = parseHealth(content);
    else if (source === 'llms.txt') parsed = parseLLMsTxt(content, source);
    else if (source === 'mcp.json' || source === 'api-docs') parsed = parseJSONLike(content, source);

    if (parsed.length === 0) {
      parsed = universalExtract(content, source);
    }
    const cleaned = smartRouter(parsed, source);
    candidates.push(...cleaned);
  }

  // 2. Parse body respons dari scraper
  for (const item of scrapedData) {
    if (!item.body) continue;
    const { candidate, body, statusCode, bodyHash, responseTime, errorMessage } = item;
    const path = normalizePath(candidate.path);

    if (statusCode === 402) {
      try {
        const json = JSON.parse(body);
        if (json.accepts && Array.isArray(json.accepts) && json.accepts.length > 0) {
          const offer = json.accepts[0];
          candidates.push(normalizeCandidate({
            path,
            method: candidate.method || 'GET',
            rawPrice: String(offer.maxAmountRequired || offer.amount || ''),
            network: offer.network || candidate.network || '',
            asset: offer.asset || candidate.asset || '',
            payTo: offer.payTo || candidate.payTo || '',
            label: offer.label || candidate.label || '',
            description: offer.description || candidate.description || '',
            source: 'scraper:402',
            httpStatus: statusCode,
            auditHash: bodyHash,
            responseTimeMs: responseTime,
            errorMessage: errorMessage
          }));
          continue;
        }
      } catch { /* not JSON */ }
    }

    const extracted = universalExtract(body, `scraper:${path}`);
    const cleaned = smartRouter(extracted, 'scraper');
    const cleanedWithMeta = cleaned.map(c => ({
      ...c,
      httpStatus: statusCode,
      auditHash: bodyHash,
      responseTimeMs: responseTime,
      errorMessage: errorMessage
    }));
    if (cleanedWithMeta.length > 0) candidates.push(...cleanedWithMeta);
  }

  return uniqCandidates(candidates).filter(isValidCandidate);
}

export function finalFilter(parsedCandidates, domain) {
  return parsedCandidates
    .filter(c => c.path) // hanya yang punya path
    .map(c => ({
      domain,
      path: c.path,
      status: c.httpStatus ? String(c.httpStatus) : 'unknown',
      x402Version: '',
      price: c.rawPrice || '',
      priceReadable: c.rawPrice ? `$${(parseInt(c.rawPrice, 10) / 1_000_000).toFixed(6)}` : '',
      network: c.network || '',
      asset: c.asset || '',
      payTo: c.payTo || '',
      label: c.label || '',
      description: c.description || '',
      source: c.source || 'unknown',
      httpStatus: c.httpStatus ? String(c.httpStatus) : '',
      responseTimeMs: c.responseTimeMs ? String(c.responseTimeMs) : '',
      errorMessage: c.errorMessage || '',
      auditHash: c.auditHash || '',
      timestamp: new Date().toISOString(),
    }));
}
