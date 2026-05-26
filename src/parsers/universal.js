// src/parsers/universal.js
import { normalizePath } from '../utils/helpers.js';
import { extractPrice } from './extractors.js';

export function universalExtract(text, sourceLabel = 'unknown') {
  const candidates = [];
  const raw = String(text || '');
  const tablePrices = new Map();
  const tableRegex = /\|\s*([A-Za-z][\w\s/-]+?)\s*\|\s*\$?([\d.]+)\s*\|/gi;
  let tm;
  while ((tm = tableRegex.exec(raw)) !== null) tablePrices.set(tm[1].trim().toLowerCase(), String(Math.round(parseFloat(tm[2]) * 1_000_000)));

  // <li> extraction
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(raw)) !== null) {
    const liContent = liMatch[1];
    let path = '';
    const codeMatch = liContent.match(/<code>(\/[^<]+)<\/code>/i) || liContent.match(/<span[^>]*>(\/[^<]+)<\/span>/i);
    const hrefMatch = liContent.match(/href="(\/[^"]+)"/i);
    if (codeMatch) path = codeMatch[1].trim();
    else if (hrefMatch) path = hrefMatch[1].trim();
    if (!path || !path.startsWith('/')) { const pathMatch = liContent.match(/(\/[a-zA-Z0-9_\/.-]+)/); if (pathMatch) path = pathMatch[1].trim(); }
    if (!path || !path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    const price = extractPrice(liContent.match(/\$\s*([\d.]+)/) ? liContent.match(/\$\s*([\d.]+)/)[0] : '');
    if (!price) continue;
    let description = '';
    const descMatch = liContent.match(/>([^<]{10,100})<\/li>/) || liContent.match(/- ([^<]{10,100})/);
    if (descMatch) description = descMatch[1].trim();
    else { const stripped = liContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); description = stripped.substring(0, 120); }
    candidates.push({ path, method: 'GET', rawPrice: price, network: '', asset: '', payTo: '', label: description || path, description: description || path, source: `universal:html-li:${sourceLabel}` });
  }

  // Markdown blocks
  const mdBlocks = raw.split(/(?=^#{1,3}\s)/m);
  let previousHeading = '';
  for (const block of mdBlocks) {
    const headingMatch = block.match(/^#{1,3}\s+(.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : '';
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/i);
    if (!pathMatch) { if (heading) previousHeading = heading; continue; }
    const method = pathMatch[0].split(/\s+/)[0].toUpperCase();
    const path   = pathMatch[1];
    const price = extractPrice(block.match(/Price:\s*\$?([\d.]+)/i) ? block.match(/Price:\s*\$?([\d.]+)/i)[0] : '');
    let finalPrice = price;
    if (!finalPrice) { const headingLower = heading.toLowerCase(); for (const [key, val] of tablePrices) if (headingLower.includes(key) || key.includes(headingLower)) { finalPrice = val; break; } }
    const cleanHeading = heading.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
    let label = cleanHeading || previousHeading || '';
    if (label.includes('\n') || label.includes('#')) label = previousHeading || '';
    if (!label) label = path.split('/').filter(Boolean).slice(-2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const lines = block.split('\n');
    let description = '';
    for (const line of lines) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.includes('Price:')) continue; if (trimmed.length > 15) { description = trimmed; break; } }
    if (!description) description = label;
    candidates.push({ path, method, rawPrice: finalPrice, network: '', asset: '', payTo: '', label, description, source: `universal:md:${sourceLabel}` });
    if (heading) previousHeading = heading;
  }

  // Alternative llms.txt
  const llmsAltPattern = /-\s+(.+?)\s*\(\$?([\d.]+)\)\s*:\s*(.+)/gi;
  let llmsAltMatch;
  while ((llmsAltMatch = llmsAltPattern.exec(raw)) !== null) {
    candidates.push({ path: normalizePath('/tools/' + llmsAltMatch.trim().toLowerCase().replace(/\s+/g, '_')), method: 'GET', rawPrice: String(Math.round(parseFloat(llmsAltMatch) * 1_000_000)), network: '', asset: '', payTo: '', label: llmsAltMatch.trim(), description: llmsAltMatch.trim(), source: `universal:llms-alt:${sourceLabel}` });
  }

    // HTML href extraction
  const htmlPathMatches = raw.matchAll(/(?:href|src|action)=["'](\/[^"']+)["']/gi);
  for (const match of htmlPathMatches) {
    const path = match[1]; // PERBAIKAN: Tambahkan [1]
    if (!path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;
    const context = raw.substring(Math.max(0, match.index - 200), match.index + 300);
    const priceMatch = context.match(/\$([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[0] : ''); // PERBAIKAN: Tambahkan [0]
    const labelMatch = context.match(/>([^<]{5,50})<\/a>/);
    candidates.push({ path, method: 'GET', rawPrice: price, network: '', asset: '', payTo: '', label: labelMatch ? labelMatch[1].trim() : '', description: '', source: `universal:html:${sourceLabel}` });
  }

    // Plain text & Block UI extraction
  const plainMatches = raw.matchAll(/(?:GET|POST|PUT|DELETE|PATCH)\s*\n?\s*(\/[a-zA-Z0-9_/-]+)/gi);
  for (const match of plainMatches) {
    const path = match[1];
    if (!path.startsWith('/')) continue;
    
    // Ambil teks setelah path ditemukan (sekitar 400 karakter ke depan)
    const contextAfter = raw.substring(match.index + match[0].length, match.index + 400);
    
    const priceMatch = contextAfter.match(/\$([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[1] : '');
    
    // Bersihkan HTML tags dan pisahkan berdasarkan baris baru
    const lines = contextAfter.split('\n').map(l => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    
    let description = '';
    let label = '';
    
    // Cari baris yang panjangnya lebih dari 20 huruf sebagai deskripsi
    for (const line of lines) {
      if (line.includes('$') || line.length < 4) continue;
      if (line.length > 25 && !description) {
        description = line;
      } else if (!label && line.length >= 4 && line.length <= 25) {
        label = line;
      }
    }
    
    // Fallback jika regex lama menangkap format Markdown
    const fallbackDescMatch = raw.substring(Math.max(0, match.index - 50), match.index + 200).match(/-\s*(.{15,100})$/m);
    if (!description && fallbackDescMatch) description = fallbackDescMatch[1].trim();

    candidates.push({ 
      path, 
      method: 'GET', 
      rawPrice: price, 
      network: '', asset: '', payTo: '', 
      label: label || description || path, 
      description: description || label || path, 
      source: `universal:text:${sourceLabel}` 
    });
  }

  return candidates;
}
