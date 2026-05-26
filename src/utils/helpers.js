// src/utils/helpers.js
import crypto from 'crypto';

export function sha256(raw) { 
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex'); 
}

export function normalizePath(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p) return '';
  if (p.startsWith('http://' ) || p.startsWith('https://' )) {
    try { const url = new URL(p); p = `${url.pathname}${url.search || ''}`; } catch { /* ignore */ }
  }
  p = p.replace(/^\/api(?=\/)/i, '');
  p = p.replace(/\/+/g, '/');
  p = p.replace(/\/+$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.toLowerCase();
}

export function normalizeCandidate(raw = {}) {
  return {
    path:        normalizePath(raw.path || raw.endpoint || raw.url || ''),
    method:      String(raw.method || 'GET').toUpperCase(),
    rawPrice:    String(raw.rawPrice || raw.price || raw.amount || ''),
    network:     String(raw.network || ''),
    asset:       String(raw.asset || ''),
    payTo:       String(raw.payTo || ''),
    label:       String(raw.label || raw.name || ''),
    description: String(raw.description || ''),
    source:      String(raw.source || 'unknown'),
    httpStatus:     raw.httpStatus || '',
    auditHash:      raw.auditHash || '',
    responseTimeMs: raw.responseTimeMs || '',
    errorMessage:   raw.errorMessage || ''
  };
}

export function uniqCandidates(candidates = []) {
  const seen = new Set();
  const out  = [];
  for (const c of candidates) {
    if (!c?.path) continue;
    const key = `${String(c.method || 'GET').toUpperCase()}:${normalizePath(c.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeCandidate(c));
  }
  return out;
}

export function isValidCandidate(candidate) {
  if (!candidate?.path) return false;
  if (!candidate.path.startsWith('/')) return false;
  if (candidate.path.length > 300) return false;
  const noisePatterns = [
    /\/_next\//i, /\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i,
    /\/static\//i, /\/chunks\//i, /\/media\//i,
    /\/favicon/i, /\/logo/i, /\/merit-logo/i,
    /\/llms\.txt/i, /\/docs\/?$/i,
  ];
  if (noisePatterns.some(p => p.test(candidate.path))) return false;
  if (candidate.path.includes('\n') || candidate.path.includes('```')) return false;
  return true;
}

export function classifyError(errorMessage = '') {
  const msg = String(errorMessage).toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('blocked')) return 'blocked';
  if (msg.includes('401') || msg.includes('unauthorized')) return 'unauthorized';
  if (msg.includes('429') || msg.includes('rate limit')) return 'rate_limited';
  if (msg.includes('404') || msg.includes('not found')) return 'not_found';
  return 'network_error';
}

