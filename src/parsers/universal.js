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

            // ============================================================
  // SMART BLOCK UI & PLAIN TEXT EXTRACTION (UPGRADE V3)
  // ============================================================
  // 1. Hapus <script> dan <style> beserta isinya agar teks tidak tertimbun kode JS
  let cleanRaw = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  
  // 2. Lindungi simbol "< $" agar tidak dianggap sebagai tag HTML
  cleanRaw = cleanRaw.replace(/<\s*\$/g, '&lt; $');
  
  // 3. Hapus semua tag HTML yang tersisa dan rapikan baris baru
  cleanRaw = cleanRaw.replace(/<[^>]+>/g, '\n').replace(/\n\s*\n/g, '\n').trim();
  
  // 4. Pecah teks menjadi "Kartu" berdasarkan kata kunci HTTP Method
  let blocks = cleanRaw.split(/(?=\b(?:GET|POST|PUT|DELETE|PATCH)\b[\s\n]*\/)/i);
  
  if (blocks.length <= 1) {
    blocks = cleanRaw.split(/(?=\n[\s\n]*\/api\/|\n[\s\n]*\/x402\/|\n[\s\n]*\/v[1-9]\/)/i);
  }

  for (const block of blocks) {
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)?[\s\n]*(\/[a-zA-Z0-9_/\-{}.:]+)/i);
    if (!pathMatch) continue;
    
    const path = pathMatch[1].trim();
    if (!path.startsWith('/') || path.length < 3) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;

    const methodMatch = block.match(/(GET|POST|PUT|DELETE|PATCH)/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

    // Perlebar jarak bacaan menjadi 1500 karakter untuk keamanan
    const context = block.substring(0, 1500);
    
    const priceMatch = context.match(/\$([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[1] : '');
    
    const lines = context.split('\n').map(l => l.trim()).filter(Boolean);
    let description = '';
    let label = '';
    
    for (let line of lines) {
      // Abaikan baris harga, termasuk yang memiliki simbol < atau &lt;
      if (line === method || line === path || /^(<|>|&lt;|&gt;)?\s*\$[\d.]+$/.test(line)) continue;
      
      let cleanLine = line.replace(path, '').replace(/(<|>|&lt;|&gt;)?\s*\$[\d.]+/, '').replace(new RegExp(`^${method}\\s*`, 'i'), '').replace(/^[-—:\s]+/, '').trim();
      if (cleanLine.length < 4) continue;

      if (cleanLine.length > 35 && !description) {
        description = cleanLine;
      } 
      else if (cleanLine.length >= 4 && cleanLine.length <= 35 && !label && !/^v\d+$/i.test(cleanLine)) {
        label = cleanLine;
      }
    }

    candidates.push({ 
      path, 
      method, 
      rawPrice: price, 
      network: '', asset: '', payTo: '', 
      label: label || description || path, 
      description: description || label || path, 
      source: `universal:block:${sourceLabel}` 
    });
  }

  return candidates;
}
