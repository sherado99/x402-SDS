// src/parsers/extractors.js
import { normalizeCandidate, normalizePath } from '../utils/helpers.js';

export function extractPrice(pricing) {
  if (!pricing) return '';
  const raw = String(pricing).trim();
  if (!raw) return '';
  const patterns = [
    /US\$\s*([\d.]+)/i,
    /\$\s*([\d.]+)\s*(?:USD|USDC|usd|usdc)/i,
    /([\d.]+)\s*(?:USDC|USD|usd|usdc)/i,
    /\$\s*([\d.]+)/,
    /Price:\s*([\d.]+)/i,
    /([\d.]+)\s*per\s+request/i,
    /^([\d.]+)$/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return String(Math.round(parseFloat(match[1]) * 1_000_000));
  }
  if (typeof pricing === 'number') return String(Math.round(pricing * 1_000_000));
  if (typeof pricing === 'string' && !isNaN(parseFloat(pricing))) return String(Math.round(parseFloat(pricing) * 1_000_000));
  return '';
}

export function extractEndpointFromObject(obj) {
  return normalizeCandidate({
    path:        obj.path || obj.endpoint || obj.url || obj.route || '',
    method:      obj.method || obj.verb || obj.type || 'GET',
    rawPrice:    extractPrice(obj.price || obj.cost || obj.amount || obj.pricing || ''),
    network:     obj.network || obj.chain || '',
    asset:       obj.asset || obj.token || '',
    payTo:       obj.payTo || obj.address || obj.wallet || '',
    label:       obj.label || obj.name || obj.title || obj.id || obj.summary || '',
    description: obj.description || obj.summary || obj.detail || obj.info || '',
    source:      'agent-card',
  });
}

export function parseWellKnownX402(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.resources)) {
      for (const res of data.resources) {
        if (typeof res === 'object' && res) {
          const path = res.path || res.endpoint || res.url;
          if (!path) continue;
          candidates.push(normalizeCandidate({
            path, method: res.method || 'GET',
            rawPrice: extractPrice(res.pricing || res.price || res.amount || res.cost || ''),
            network: res.network || data.network || '',
            asset: res.asset || data.asset || '',
            label: res.name || res.id || res.label || '',
            description: res.description || '',
            source: 'well-known-x402',
          }));
        } else if (typeof res === 'string') {
          const parts = res.trim().split(/\s+/);
          candidates.push(normalizeCandidate({
            path: parts.length > 1 ? parts.slice(1).join(' ') : parts[0],
            method: parts.length > 1 ? parts[0] : 'GET',
            rawPrice: '',
            network: data.network || '', asset: data.asset || '',
            label: parts[0], description: '',
            source: 'well-known-x402',
          }));
        }
      }
    }
    if (Array.isArray(data.services)) {
      for (const svc of data.services) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        let rawPrice = extractPrice(svc.pricing || svc.price || svc.amount || svc.cost || '');
        if (!rawPrice && Array.isArray(svc.models) && svc.models.length > 0) {
          rawPrice = extractPrice(svc.models[0].pricing || svc.models[0].price || svc.models[0].amount || svc.models[0].cost || '');
        }
        const payment = svc.payment || {};
        candidates.push(normalizeCandidate({
          path, method: svc.method || 'POST', rawPrice,
          network: payment.network || svc.network || data.network || '',
          asset: payment.asset || svc.asset || data.asset || '',
          label: svc.name || svc.id || svc.label || '',
          description: svc.description || '',
          source: 'well-known-x402',
        }));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}

export function parseAgentCard(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    const possibleServiceKeys = [
      'skills', 'services', 'endpoints', 'actions', 'capabilities',
      'tools', 'functions', 'methods', 'apis', 'resources',
      'offers', 'listings', 'items', 'entries',
    ];
    for (const key of possibleServiceKeys) {
      if (data[key] && Array.isArray(data[key])) {
        for (const item of data[key]) {
          if (typeof item === 'object') candidates.push(extractEndpointFromObject(item));
        }
      }
    }
    if (candidates.length === 0) {
      function deepScan(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(item => { if (typeof item === 'object') candidates.push(extractEndpointFromObject(item)); });
          return;
        }
        if (obj.path || obj.endpoint || obj.url) candidates.push(extractEndpointFromObject(obj));
        Object.values(obj).forEach(val => deepScan(val));
      }
      deepScan(data);
    }
  } catch { /* not JSON */ }
  return candidates;
}

export function parseOpenAPI(text) {
  const candidates = [];
  try {
    const spec = JSON.parse(text);
    if (!spec.paths) return candidates;
    for (const [path, methods] of Object.entries(spec.paths)) {
      const methodKey = Object.keys(methods || {})[0] || 'get';
      const operation = methods?.[methodKey] || {};
      let price = '', network = '', asset = '', description = '';
      if (operation['x-payment-info']) {
        const pi = operation['x-payment-info'];
        price = extractPrice(pi.price || pi.amount || '');
        network = pi.network || ''; asset = pi.asset || pi.token || '';
        description = pi.description || '';
      }
      const resp402 = operation.responses?.['402'];
      if (resp402?.content?.['application/json']?.example?.accepts) {
        const offer = resp402.content['application/json'].example.accepts[0] || {};
        price = price || extractPrice(offer.maxAmountRequired || offer.amount || '');
        network = network || offer.network || '';
        asset = asset || offer.asset || '';
        description = description || offer.description || operation.description || '';
      }
      if (!price && spec['x-payment-info']) {
        const pi = spec['x-payment-info'];
        price = extractPrice(pi.price || '');
        network = network || pi.network || '';
        asset = asset || pi.asset || '';
      }
      candidates.push(normalizeCandidate({
        path, method: methodKey.toUpperCase(),
        rawPrice: price, network, asset,
        label: operation.summary || operation.operationId || '',
        description: description || operation.description || '',
        source: 'openapi',
      }));
    }
  } catch { /* not JSON */ }
  return candidates;
}

export function parseHealth(text) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (data.endpoints && typeof data.endpoints === 'object' && !Array.isArray(data.endpoints)) {
      for (const [path, info] of Object.entries(data.endpoints)) {
        let rawPrice = ''; const network = data.network || '';
        if (typeof info.price === 'string') rawPrice = extractPrice(info.price);
        else if (typeof info.price === 'number') rawPrice = String(info.price);
        candidates.push(normalizeCandidate({
          path, method: 'GET', rawPrice, network, asset: '',
          label: info.description || path, description: info.description || '', source: '/health',
        }));
      }
    }
    if (Array.isArray(data.endpoints)) {
      for (const svc of data.endpoints) {
        const path = svc.endpoint || svc.path || svc.url;
        if (!path) continue;
        candidates.push(normalizeCandidate({
          path, method: svc.method || 'GET',
          rawPrice: extractPrice(svc.price || svc.x402Price || ''),
          network: svc.network || data.network || '',
          asset: svc.asset || '',
          label: svc.name || svc.id || svc.description || '',
          description: svc.description || '',
          source: '/health',
        }));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}

export function parseLLMsTxt(text, sourceLabel) {
  const candidates = [];
  const raw = String(text || '');
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let match;
  while ((match = llmsAltPattern.exec(raw)) !== null) {
    candidates.push(normalizeCandidate({
      path: normalizePath('/tools/' + match[1].trim().toLowerCase().replace(/\s+/g, '_')),
      method: 'GET',
      rawPrice: String(Math.round(parseFloat(match[2]) * 1_000_000)),
      label: match[1].trim(),
      description: match[3].trim(),
      source: `llms.txt:${sourceLabel}`,
    }));
  }
  return candidates;
}

export function parseJSONLike(text, sourceLabel) {
  const candidates = [];
  try {
    const data = JSON.parse(text);
    if (data.path || data.endpoint || data.url) candidates.push(extractEndpointFromObject(data));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'object') candidates.push(extractEndpointFromObject(item));
      }
    }
    if (typeof data === 'object' && data !== null) {
      for (const val of Object.values(data)) {
        if (val && typeof val === 'object' && (val.path || val.endpoint || val.url)) candidates.push(extractEndpointFromObject(val));
      }
    }
  } catch { /* not JSON */ }
  return candidates;
}
