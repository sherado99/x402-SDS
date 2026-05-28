// src/parsers/universal.js
import { normalizePath } from '../utils/helpers.js';
import { extractPrice } from './extractors.js';

/**
 * Fungsi bantuan untuk memotong teks menjadi ringkasan pendek.
 */
function summarizeDescription(text = '') {
  if (!text) return '';
  const firstParagraph = text.split(/\n\n|\r\n\r\n/)[0] || text;
  if (firstParagraph.length <= 200) return firstParagraph.trim();
  const truncated = firstParagraph.substring(0, 200);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastExclamation = truncated.lastIndexOf('!');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);
  if (lastSentenceEnd > 100) {
    return truncated.substring(0, lastSentenceEnd + 1).trim();
  }
  return truncated.trim() + '...';
}

export function universalExtract(text, sourceLabel = 'unknown') {
  const candidates = [];
  const raw = String(text || '');
  
  // ============================================================
  // 1. EKSTRAK TABEL HARGA (Markdown table)
  // ============================================================
  const priceTable = new Map();
  const tableRegex = /\|\s*([^|]+?)\s*\|\s*\$?([\d.]+)\s*\|/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(raw)) !== null) {
    const name = tableMatch[1].trim().toLowerCase();
    const price = String(Math.round(parseFloat(tableMatch[2]) * 1_000_000));
    if (name.includes('api') || name.includes('/') || name.includes('search') || name.includes('enrich') || name.includes('verify') || name.includes('scrape') || name.includes('crawl') || name.includes('resolve') || name.includes('lookup') || name.includes('render') || name.includes('shopping') || name.includes('news') || name.includes('image')) {
      priceTable.set(name, price);
    }
  }
  
  // ============================================================
  // 2. PROSES KHUSUS UNTUK llms.txt
  // ============================================================
  if (sourceLabel === 'llms.txt') {
    const docBlocks = raw.split(/\n---\n|\n## /);
    
    for (const block of docBlocks) {
      const pathMatches = [...block.matchAll(/(?:\/api\/|\/)([a-zA-Z0-9_\/-]+)/g)];
      if (pathMatches.length === 0) continue;
      
      let extractedPath = '';
      for (const pm of pathMatches) {
        const candidate = '/' + pm[1].replace(/\/$/, '');
        if (candidate.length > 3 && !candidate.includes(' ') && !candidate.includes('\n')) {
          extractedPath = normalizePath(candidate);
          break;
        }
      }
      if (!extractedPath) continue;
      
      let price = '';
      const blockLower = block.toLowerCase();
      for (const [tableName, tablePrice] of priceTable.entries()) {
        if (blockLower.includes(tableName)) {
          price = tablePrice;
          break;
        }
      }
      
      if (!price) {
        const inlinePrice = block.match(/\$([\d.]+)/);
        if (inlinePrice) {
          price = extractPrice(inlinePrice[1]);
        }
      }
      
      let label = '';
      const headingMatch = block.match(/^#+\s*(.+)/m);
      if (headingMatch) {
        label = headingMatch[1].trim();
      } else {
        const boldMatch = block.match(/\*\*(.+?)\*\*/);
        if (boldMatch) label = boldMatch[1].trim();
      }
      if (!label) {
        label = extractedPath.split('/').filter(Boolean).pop() || extractedPath;
      }
      
      let description = '';
      const lines = block.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('|') || trimmed.startsWith('-')) continue;
        if (trimmed === label) continue;
        if (trimmed.length > 30) {
          description = trimmed;
          break;
        }
      }
      
      description = summarizeDescription(description);
      
      candidates.push({
        path: extractedPath,
        method: 'POST',
        rawPrice: price,
        network: '',
        asset: '',
        payTo: '',
        label: label,
        description: description,
        source: `llms.txt:${sourceLabel}`
      });
    }
    
    return candidates;
  }
  
  // ============================================================
  // 3. PROSES STANDARD UNTUK SUMBER LAIN
  // ============================================================
  
  // --- 3a. Ekstraksi <li> dari HTML ---
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(raw)) !== null) {
    const liContent = liMatch[1];
    let path = '';
    const codeMatch = liContent.match(/<code>(\/[^<]+)<\/code>/i) || liContent.match(/<span[^>]*>(\/[^<]+)<\/span>/i);
    const hrefMatch = liContent.match(/href="(\/[^"]+)"/i);
    if (codeMatch) path = codeMatch[1].trim();
    else if (hrefMatch) path = hrefMatch[1].trim();
    if (!path || !path.startsWith('/')) {
      const pathMatch = liContent.match(/(\/[a-zA-Z0-9_\/.-]+)/);
      if (pathMatch) path = pathMatch[1].trim();
    }
    if (!path || !path.startsWith('/')) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    
    const priceMatch = liContent.match(/\$\s*([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[1] : '');
    if (!price) continue;
    
    let description = '';
    const descMatch = liContent.match(/>([^<]{10,100})<\/li>/) || liContent.match(/- ([^<]{10,100})/);
    if (descMatch) description = descMatch[1].trim();
    else {
      const stripped = liContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      description = stripped.substring(0, 120);
    }
    // Bersihkan newline dari path
    path = path.replace(/[\n\r]/g, '');
    candidates.push({
      path, method: 'GET', rawPrice: price,
      network: '', asset: '', payTo: '',
      label: description || path,
      description: description || path,
      source: `universal:html-li:${sourceLabel}`
    });
  }
  
  // --- 3b. Blok Markdown dengan heading dan method HTTP ---
  const mdBlocks = raw.split(/(?=^#{1,3}\s)/m);
  let previousHeading = '';
  for (const block of mdBlocks) {
    const headingMatch = block.match(/^#{1,3}\s+(.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : '';
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s\n]+)/i);
    if (!pathMatch) {
      if (heading) previousHeading = heading;
      continue;
    }
    const method = pathMatch[0].split(/\s+/)[0].toUpperCase();
    const path = pathMatch[1].replace(/[\n\r]/g, ''); // Bersihkan path dari newline
    let price = extractPrice(block.match(/Price:\s*\$?([\d.]+)/i) ? block.match(/Price:\s*\$?([\d.]+)/i)[0] : '');
    if (!price && heading) {
      const headingLower = heading.toLowerCase();
      for (const [name, p] of priceTable.entries()) {
        if (headingLower.includes(name) || name.includes(headingLower)) {
          price = p;
          break;
        }
      }
    }
    const cleanHeading = heading.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '').trim();
    let label = cleanHeading || previousHeading || '';
    if (label.includes('\n') || label.includes('#')) label = previousHeading || '';
    if (!label) label = path.split('/').filter(Boolean).slice(-2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    
    const lines = block.split('\n');
    let description = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.includes('Price:')) continue;
      if (trimmed.length > 15) { description = trimmed; break; }
    }
    if (!description) description = label;
    description = summarizeDescription(description);
    
    // Bersihkan label dan deskripsi dari newline
    label = label.replace(/[\n\r]/g, ' ');
    description = description.replace(/[\n\r]/g, ' ');
    
    candidates.push({
      path, method, rawPrice: price,
      network: '', asset: '', payTo: '',
      label, description,
      source: `universal:md:${sourceLabel}`
    });
    if (heading) previousHeading = heading;
  }
  
  // --- 3c. Ekstraksi plain text dengan method HTTP ---
  const cleanRaw = raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*\$/g, '&lt; $')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n\s*\n/g, '\n')
    .replace(/[\n\r]+/g, ' ') // TAMBAHAN: ganti semua newline dengan spasi untuk mencegah kata menyambung
    .replace(/\s+/g, ' ')
    .trim();
  
  const blocks = cleanRaw.split(/(?=\b(?:GET|POST|PUT|DELETE|PATCH)\b[\s\n]*\/)/i);
  
  for (const block of blocks) {
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)?[\s\n]*(\/[a-zA-Z0-9_/\-{}.:]+)/i);
    if (!pathMatch) continue;
    
    let path = pathMatch[1].trim();
    // Bersihkan newline jika masih ada
    path = path.replace(/[\n\r]/g, '');
    if (!path.startsWith('/') || path.length < 3) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;
    
    const methodMatch = block.match(/(GET|POST|PUT|DELETE|PATCH)/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
    
    const context = block.substring(0, 1500);
    const priceMatch = context.match(/\$([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[1] : '');
    
    const lines = context.split(/\s+/).filter(Boolean); // Sudah tidak ada newline, pakai spasi
    let description = '';
    let label = '';
    
    // Karena sudah bersih dari newline, kita cari teks panjang sebagai deskripsi
    const words = context.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (word === method || word === path || word.match(/^\$[\d.]+$/)) continue;
      current += (current ? ' ' : '') + word;
      if (current.length > 35 && !description) {
        description = current;
        current = '';
      } else if (current.length >= 4 && current.length <= 35 && !label && !/^v\d+$/i.test(current)) {
        label = current;
        current = '';
      }
    }
    if (!description && current.length > 10) description = current;
    
    description = summarizeDescription(description || '');
    label = label || description || path;
    
    // Bersihkan label dan deskripsi dari newline
    label = label.replace(/[\n\r]/g, ' ');
    description = description.replace(/[\n\r]/g, ' ');
    
    candidates.push({
      path, method, rawPrice: price,
      network: '', asset: '', payTo: '',
      label: label || description || path,
      description: description || label || path,
      source: `universal:block:${sourceLabel}`
    });
  }
  
  return candidates;
}
