// src/parsers/index.js
import { normalizePath, normalizeCandidate, uniqCandidates, isValidCandidate } from '../utils/helpers.js';
import { extractPrice, parseWellKnownX402, parseAgentCard, parseOpenAPI, parseHealth, parseLLMsTxt, parseJSONLike } from './extractors.js';
import { universalExtract } from './universal.js';

function cleanText(str) {
  return (str || '').replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function smartRouter(candidates, sourceLabel) {
  const cleaned = [];
  for (const candidate of candidates) {
    let cleanPath = candidate.path.replace(/[`\\\n\r<>]/g, '').trim();
    // Validasi path: hanya boleh karakter standar
    if (!/^\/[a-zA-Z0-9_\/.-]+$/.test(cleanPath)) continue;
    if (cleanPath.length < 2 || cleanPath.length > 300) continue;

    let cleanLabel = cleanText(candidate.label || '');
    let cleanDesc = cleanText(candidate.description || '');

    // Abaikan label/deskripsi yang mengandung noise instruksi MCP
    if (cleanLabel.includes('mcp__agentcash') || cleanLabel.includes('call mcp') ||
        cleanDesc.includes('mcp__agentcash') || cleanDesc.includes('call mcp')) {
      continue;
    }

    const markdownRegex = /^(\*\*|`|_)?(GET|POST|PUT|DELETE|PATCH)\s+[^*-]+(\*\*|`|_)?\s*[-—:]\s*/i;
    cleanLabel = cleanLabel.replace(markdownRegex, '').trim();
    cleanDesc = cleanDesc.replace(markdownRegex, '').trim();

    if (!cleanLabel) cleanLabel = cleanPath.split('/').filter(Boolean).pop() || cleanPath;
    if (!cleanDesc) cleanDesc = cleanLabel;

    // Filter sumber: harus punya harga untuk sumber tertentu
    if (sourceLabel === 'scraper' || sourceLabel === 'llms.txt' || sourceLabel === 'mcp.json' || sourceLabel === 'api-docs') {
      if (!candidate.rawPrice || candidate.rawPrice === '0') continue;
    }

    cleaned.push({ 
      ...candidate, 
      path: cleanPath, 
      label: cleanLabel, 
      description: cleanDesc 
    });
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
    if (!item || !item.body) continue;
    if (!item.candidate) continue;

    const { candidate, body, statusCode, bodyHash, responseTime, errorMessage } = item;
    const path = normalizePath(candidate.path);

    if (statusCode === 402) {
      try {
        const json = JSON.parse(body);
        if (json.accepts && Array.isArray(json.accepts) && json.accepts.length > 0) {
          const offer = json.accepts[0];
          
          // Ambil deskripsi dari resource.description (X402 v2) atau offer.description (v1)
          const desc = (json.resource && json.resource.description) ? json.resource.description : (offer.description || candidate.description || '');
          
          // DETEKSI VERSI OTOMATIS: Ambil dari JSON, jika tidak ada anggap versi 1
          const detectedVersion = json.x402Version ? String(json.x402Version) : '1';

          candidates.push(normalizeCandidate({
            path,
            method: candidate.method || 'GET',
            rawPrice: String(offer.amount || offer.maxAmountRequired || ''), // Mendukung v2 (amount) dan v1
            network: offer.network || candidate.network || '',
            asset: offer.asset || candidate.asset || '',
            payTo: offer.payTo || candidate.payTo || '',
            label: desc || candidate.label || '',
            description: desc,
            source: 'scraper:402',
            httpStatus: statusCode,
            auditHash: bodyHash,
            responseTimeMs: responseTime,
            errorMessage: errorMessage,
            x402Version: detectedVersion // <-- VERSI OTOMATIS DIMASUKKAN DI SINI
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
    .filter(c => c.path && c.rawPrice && c.description && c.description.length > 10)
    .map(c => ({
      domain,
      path: c.path,
      x402Version: c.x402Version || '', // <-- PASTIKAN VERSI DITERUSKAN KE OUTPUT AKHIR
      price: c.rawPrice || '',
      priceReadable: c.rawPrice ? `$${(parseInt(c.rawPrice, 10) / 1_000_000).toFixed(6)}` : '',
      network: c.network || '',
      asset: c.asset || '',
      payTo: c.payTo || '',
      label: c.label || '',
      description: c.description || '',
      source: c.source || 'unknown',
      auditHash: c.auditHash || '',
      httpStatus: c.httpStatus ? String(c.httpStatus) : 'unknown',
      responseTimeMs: c.responseTimeMs ? String(c.responseTimeMs) : '',
      errorMessage: c.errorMessage || '',
      timestamp: new Date().toISOString(),
      download_docx: '',
      download_pdf: ''
    }));
}
