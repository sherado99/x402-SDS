// src/parsers/universal.js
import { normalizePath } from '../utils/helpers.js';
import { extractPrice } from './extractors.js';

/**
 * Fungsi bantuan untuk memotong teks menjadi ringkasan pendek.
 * Mengambil kalimat pertama (hingga 200 karakter) dari teks dokumentasi panjang.
 */
function summarizeDescription(text = '') {
  if (!text) return '';
  // Ambil paragraf pertama (sampai baris kosong atau newline ganda)
  const firstParagraph = text.split(/\n\n|\r\n\r\n/)[0] || text;
  // Ambil maksimal 200 karakter, berhenti di akhir kalimat terakhir yang utuh
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
  const priceTable = new Map(); // key: nama endpoint (lowercase), value: harga atomik
  const tableRegex = /\|\s*([^|]+?)\s*\|\s*\$?([\d.]+)\s*\|/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(raw)) !== null) {
    const name = tableMatch[1].trim().toLowerCase();
    const price = String(Math.round(parseFloat(tableMatch[2]) * 1_000_000));
    // Hanya masukkan jika nama mengandung kata kunci API (hindari header/noise)
    if (name.includes('api') || name.includes('/') || name.includes('search') || name.includes('enrich') || name.includes('verify') || name.includes('scrape') || name.includes('crawl') || name.includes('resolve') || name.includes('lookup') || name.includes('render') || name.includes('shopping') || name.includes('news') || name.includes('image')) {
      priceTable.set(name, price);
    }
  }
  
  // ============================================================
  // 2. PROSES KHUSUS UNTUK llms.txt: blok dokumentasi besar
  // ============================================================
  if (sourceLabel === 'llms.txt') {
    // Pola: blok dipisahkan oleh "---" atau "## " (Markdown heading level 2)
    const docBlocks = raw.split(/\n---\n|\n## /);
    
    for (const block of docBlocks) {
      // Cari path API di blok ini
      const pathMatches = [...block.matchAll(/(?:\/api\/|\/)([a-zA-Z0-9_\/-]+)/g)];
      if (pathMatches.length === 0) continue;
      
      // Ambil path pertama yang valid
      let extractedPath = '';
      for (const pm of pathMatches) {
        const candidate = '/' + pm[1].replace(/\/$/, '');
        if (candidate.length > 3 && !candidate.includes(' ') && !candidate.includes('\n')) {
          extractedPath = normalizePath(candidate);
          break;
        }
      }
      if (!extractedPath) continue;
      
      // Cari harga: cek di tabel harga dulu, baru di dalam blok
      let price = '';
      const blockLower = block.toLowerCase();
      for (const [tableName, tablePrice] of priceTable.entries()) {
        // Cocokkan: nama endpoint di tabel muncul di blok ini
        if (blockLower.includes(tableName)) {
          price = tablePrice;
          break;
        }
      }
      
      // Fallback: cari harga dalam teks blok
      if (!price) {
        const inlinePrice = block.match(/\$([\d.]+)/);
        if (inlinePrice) {
          price = extractPrice(inlinePrice[1]);
        }
      }
      
      // Ekstrak label: heading pertama atau teks tebal pertama
      let label = '';
      const headingMatch = block.match(/^#+\s*(.+)/m);
      if (headingMatch) {
        label = headingMatch[1].trim();
      } else {
        const boldMatch = block.match(/\*\*(.+?)\*\*/);
        if (boldMatch) label = boldMatch[1].trim();
      }
      if (!label) {
        // Ambil dari nama endpoint di path
        label = extractedPath.split('/').filter(Boolean).pop() || extractedPath;
      }
      
      // Deskripsi: paragraf pertama setelah heading
      let description = '';
      const lines = block.split('\n');
      let afterHeading = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('|') || trimmed.startsWith('-')) continue;
        if (trimmed === label) continue;
        if (trimmed.length > 30) {
          description = trimmed;
          break;
        }
      }
      
      // Ringkasan deskripsi
      description = summarizeDescription(description);
      
      candidates.push({
        path: extractedPath,
        method: 'POST', // Kebanyakan endpoint enrichment menggunakan POST
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
  // 3. PROSES STANDARD UNTUK SUMBER LAIN (HTML, JSON, dll.)
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
    const path = pathMatch[1];
    let price = extractPrice(block.match(/Price:\s*\$?([\d.]+)/i) ? block.match(/Price:\s*\$?([\d.]+)/i)[0] : '');
    // Coba cocokkan heading dengan tabel harga
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
    .trim();
  
  const blocks = cleanRaw.split(/(?=\b(?:GET|POST|PUT|DELETE|PATCH)\b[\s\n]*\/)/i);
  
  for (const block of blocks) {
    const pathMatch = block.match(/(?:GET|POST|PUT|DELETE|PATCH)?[\s\n]*(\/[a-zA-Z0-9_/\-{}.:]+)/i);
    if (!pathMatch) continue;
    
    const path = pathMatch[1].trim();
    if (!path.startsWith('/') || path.length < 3) continue;
    if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|css|js)(\?|$)/i.test(path)) continue;
    if (path.includes('/_next/') || path.includes('/static/')) continue;
    
    const methodMatch = block.match(/(GET|POST|PUT|DELETE|PATCH)/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
    
    const context = block.substring(0, 1500);
    const priceMatch = context.match(/\$([\d.]+)/);
    const price = extractPrice(priceMatch ? priceMatch[1] : '');
    
    const lines = context.split('\n').map(l => l.trim()).filter(Boolean);
    let description = '';
    let label = '';
    
    for (let line of lines) {
      if (line === method || line === path || /^(<|>|&lt;|&gt;)?\s*\$[\d.]+$/.test(line)) continue;
      
      let cleanLine = line.replace(path, '').replace(/(<|>|&lt;|&gt;)?\s*\$[\d.]+/, '').replace(new RegExp(`^${method}\\s*`, 'i'), '').replace(/^[-—:\s]+/, '').trim();
      if (cleanLine.length < 4) continue;
      
      if (cleanLine.length > 35 && !description) {
        description = cleanLine;
      } else if (cleanLine.length >= 4 && cleanLine.length <= 35 && !label && !/^v\d+$/i.test(cleanLine)) {
        label = cleanLine;
      }
    }
    description = summarizeDescription(description);
    
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