import { Actor } from 'apify';
import got from 'got';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';

await Actor.init();

// ========== HELPERS ==========

const BUILT_IN_DICTIONARY = [
  '/x402/',
  '/x402/sapi',
  '/x402/spdet',
  '/x402/scdft',
  '/x402/v1/',
  '/x402/payment',
  '/x402/checkout',
  '/api/x402/',
  '/api/x402/payment',
  '/v1/x402',
  '/.well-known/x402',
];

function normalizeDomain(d) {
  return d.replace(/\/+$/, '');
}

async function generateDOCX(domain, results) {
  const children = [
    new Paragraph({
      text: 'X402 Domain Scan Report',
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
    }),
    new Paragraph({
      text: `Domain: ${domain}`,
      spacing: { after: 60 },
    }),
    new Paragraph({
      text: `Scan time: ${new Date().toISOString()}`,
      spacing: { after: 200 },
    }),
  ];

  for (const row of results) {
    children.push(new Paragraph({
      text: `${row.path} [${row.status}]`,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 60 },
    }));
    if (row.status === 'success') {
      children.push(new Paragraph({ text: `Price: ${row.price} | Network: ${row.network}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
    } else if (row.errorMessage) {
      children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
    }
    children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return await Packer.toBuffer(doc);
}

async function generatePDF(domain, results) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('X402 Domain Scan Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Domain: ${domain}`);
    doc.fontSize(11).text(`Scan time: ${new Date().toISOString()}`);
    doc.moveDown();

    for (const row of results) {
      doc.fontSize(12).text(`${row.path} [${row.status}]`, { underline: true });
      if (row.status === 'success') {
        doc.fontSize(10).text(`Price: ${row.price} | Network: ${row.network}`);
        doc.fontSize(10).text(`Label: ${row.label}`);
        doc.fontSize(10).text(`Asset: ${row.asset}`);
        doc.fontSize(10).text(`Pay To: ${row.payTo}`);
        doc.fontSize(10).text(`Description: ${row.description}`);
      } else if (row.errorMessage) {
        doc.fontSize(10).text(`Error: ${row.errorMessage}`);
      }
      doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`);
      doc.moveDown(0.5);
    }

    doc.end();
  });
}

async function saveFileToKVS(filename, buffer, contentType) {
  const store = await Actor.openKeyValueStore();
  await store.setValue(filename, buffer, { contentType });
  const baseUrl = `https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true`;
  return baseUrl;
}

// ========== INPUT ==========

const input = await Actor.getInput();
let {
  domain,
  paths: manualPaths,
  maxPaths = 100,
  timeout = 5000,
  includeSubdomains = false,
} = input;

if (!domain) {
  await Actor.fail('Domain is required. Please provide a root domain to scan.');
  await Actor.exit();
}

// Bersihkan domain dari protokol dan path tambahan
domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// Determine paths to scan
let pathsToCheck = [];
if (manualPaths && manualPaths.trim()) {
  pathsToCheck = manualPaths.split('\n').map(p => p.trim()).filter(p => p);
} else {
  pathsToCheck = BUILT_IN_DICTIONARY.slice(0, maxPaths);
}

const targetDomains = [normalizeDomain(domain)];
if (includeSubdomains) {
  targetDomains.push(`api.${normalizeDomain(domain)}`);
}

// ========== SCAN ==========

const results = [];

for (const base of targetDomains) {
  for (const path of pathsToCheck) {
    const url = `https://${base}${path}`;
    const start = Date.now();
    let httpStatus = null;
    let responseTime = 0;
    let x402Data = {};

    try {
      const response = await got(url, {
        method: 'GET',
        timeout: { request: timeout },
        throwHttpErrors: false,
        retry: { limit: 0 },
      });
      httpStatus = response.statusCode;
      responseTime = Date.now() - start;

      if (httpStatus === 402) {
        try {
          const body = JSON.parse(response.body);
          if (body.accepts && Array.isArray(body.accepts) && body.accepts.length > 0) {
            const offer = body.accepts[0];
            x402Data = {
              status: 'success',
              x402Version: body.x402Version !== undefined ? String(body.x402Version) : '',
              price: offer.amount || '',
              network: offer.network || '',
              asset: offer.asset || '',
              payTo: offer.payTo || '',
              label: offer.label || '',
              description: offer.description || '',
            };
          } else {
            x402Data = {
              status: 'error',
              x402Version: body.x402Version !== undefined ? String(body.x402Version) : '',
              errorMessage: 'Missing accepts array in 402 response',
            };
          }
        } catch (parseErr) {
          x402Data = {
            status: 'error',
            errorMessage: 'Invalid JSON in 402 body',
          };
        }
      } else {
        x402Data = { status: 'not_found' };
      }

      results.push({
        domain: base,
        path,
        x402Version: x402Data.x402Version ?? '',
        price: x402Data.price ?? '',
        network: x402Data.network ?? '',
        asset: x402Data.asset ?? '',
        payTo: x402Data.payTo ?? '',
        label: x402Data.label ?? '',
        description: x402Data.description ?? '',
        httpStatus: httpStatus !== null ? String(httpStatus) : '',
        responseTimeMs: String(responseTime),
        errorMessage: x402Data.errorMessage ?? '',
        status: x402Data.status,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      results.push({
        domain: base,
        path,
        status: 'error',
        x402Version: '',
        price: '',
        network: '',
        asset: '',
        payTo: '',
        label: '',
        description: '',
        httpStatus: '0',
        responseTimeMs: String(Date.now() - start),
        errorMessage: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// ========== GENERATE REPORTS ==========

const docxBuffer = await generateDOCX(domain, results);
const pdfBuffer = await generatePDF(domain, results);

const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');

// Attach download URLs to each result row
const finalOutput = results.map(row => ({
  ...row,
  download_docx: docxUrl,
  download_pdf: pdfUrl,
}));

await Actor.pushData(finalOutput);
console.log(`Scan complete. ${finalOutput.length} paths checked. Success: ${finalOutput.filter(r => r.status === 'success').length}, Errors: ${finalOutput.filter(r => r.status === 'error').length}, Not Found: ${finalOutput.filter(r => r.status === 'not_found').length}`);

await Actor.exit();