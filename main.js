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
  '/x402/status',
  '/x402/health',
  '/x402/invoice',
  '/x402/balance',
  '/x402/webhook',
  '/x402/callback',
  '/x402/token',
  '/x402/auth',
  '/x402/order',
  '/x402/subscription',
  '/x402/usage',
  '/x402/rate',
  '/x402/quote',
  '/api/x402/',
  '/api/x402/payment',
  '/api/x402/status',
  '/api/x402/webhook',
  '/v1/x402',
  '/v1/x402/payment',
  '/v2/x402',
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

  if (results.length === 0) {
    children.push(new Paragraph({
      text: 'No X402 endpoints found on this domain.',
      spacing: { after: 120 },
    }));
  } else {
    for (const row of results) {
      children.push(new Paragraph({
        text: `${row.path} [${row.status}]`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 60 },
      }));
      if (row.status === 'success') {
        children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
        children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
      } else if (row.errorMessage) {
        children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
      }
      children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } }));
    }
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

    if (results.length === 0) {
      doc.fontSize(12).text('No X402 endpoints found on this domain.');
    } else {
      for (const row of results) {
        doc.fontSize(12).text(`${row.path} [${row.status}]`, { underline: true });
        if (row.status === 'success') {
          doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
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

// ========== DISCOVERY FUNCTIONS ==========

async function discoverPathsFromWellKnown(base, timeout, proxyUrl) {
  const endpoints = [
    `https://${base}/.well-known/x402`,
    `https://${base}/.well-known/mpp`,
    `https://${base}/openapi.json`,
  ];

  const options = {
    method: 'GET',
    timeout: { request: timeout },
    throwHttpErrors: false,
    retry: { limit: 0 },
  };

  if (proxyUrl) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    options.agent = { https: new HttpsProxyAgent(proxyUrl) };
  }

  for (const url of endpoints) {
    try {
      const response = await got(url, options);
      if (response.statusCode !== 200) continue;

      const body = JSON.parse(response.body);

      if (body.resources && Array.isArray(body.resources)) {
        return body.resources.map(r => ({ path: r.path, method: 'GET', body: null }));
      }

      if (body.paths && typeof body.paths === 'object') {
        const paths = [];
        for (const [p, methods] of Object.entries(body.paths)) {
          if (p.includes('x402')) {
            const method = methods.post ? 'POST' : 'GET';
            let exampleBody = null;
            if (method === 'POST' && methods.post.requestBody?.content?.['application/json']?.example) {
              exampleBody = methods.post.requestBody.content['application/json'].example;
            }
            paths.push({ path: p, method, body: exampleBody });
          }
        }
        return paths;
      }
    } catch (err) {
      continue;
    }
  }
  return null;
}

async function discoverFromAgentServices(base, timeout, proxyUrl) {
  const wellKnownUrl = `https://${base}/.well-known/agent-services.json`;

  const options = { method: 'GET', timeout: { request: timeout }, throwHttpErrors: false, retry: { limit: 0 } };
  if (proxyUrl) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    options.agent = { https: new HttpsProxyAgent(proxyUrl) };
  }

  try {
    const wellKnownRes = await got(wellKnownUrl, options);
    if (wellKnownRes.statusCode !== 200) return null;

    const info = JSON.parse(wellKnownRes.body);
    if (!info.catalog_endpoint || !info.execution_endpoint) return null;

    const catalogRes = await got(info.catalog_endpoint, options);
    if (catalogRes.statusCode !== 200) return null;

    const catalog = JSON.parse(catalogRes.body);
    const services = catalog.services || catalog.data || [];
    if (!Array.isArray(services)) return null;

    const discovered = [];
    let execEndpoint = decodeURIComponent(info.execution_endpoint);

    for (const service of services) {
      const slug = service.slug || service.id || service.name;
      if (!slug) continue;

      const pathOnly = new URL(execEndpoint.replace('{service}', slug)).pathname;

      let exampleBody = null;
      try {
        const detailRes = await got(`${info.catalog_endpoint}/${slug}`, options);
        if (detailRes.statusCode === 200) {
          const detail = JSON.parse(detailRes.body);
          if (detail.input_schema) {
            exampleBody = buildExampleBody(detail.input_schema);
          }
        }
      } catch (err) {}

      if (!exampleBody && info['x-quickstart'] && info['x-quickstart'].step2) {
        const match = info['x-quickstart'].step2.match(/body:\s*({[^}]+})/);
        if (match) {
          try { exampleBody = JSON.parse(match[1]); } catch (e) {}
        }
      }

      discovered.push({
        path: pathOnly,
        method: 'POST',
        body: exampleBody || {}
      });
    }

    return discovered.length > 0 ? discovered : null;
  } catch (err) {
    return null;
  }
}

function buildExampleBody(schema) {
  if (!schema || !schema.properties) return {};
  const body = {};
  const required = schema.required || [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (required.includes(key) || Object.keys(body).length === 0) {
      switch (prop.type) {
        case 'string': body[key] = prop.example || 'test'; break;
        case 'number': case 'integer': body[key] = prop.example || 1; break;
        case 'boolean': body[key] = prop.example !== undefined ? prop.example : true; break;
        case 'array': body[key] = prop.example || []; break;
        default: body[key] = null;
      }
    }
  }
  return body;
}

// ========== ENDPOINT CHECKER ==========

async function checkEndpoint(base, path, method, body, timeout, proxyUrl) {
  const url = `https://${base}${path}`;
  const start = Date.now();
  
  const options = {
    method,
    timeout: { request: timeout },
    throwHttpErrors: false,
    retry: { limit: 0 },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  };

  if (method === 'POST' && body) {
    options.json = body;
  }

  if (proxyUrl) {
    console.log(`[PROXY] Using residential proxy for ${url}`);
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    options.agent = { https: new HttpsProxyAgent(proxyUrl) };
  }

  try {
    const response = await got(url, options);
    const httpStatus = response.statusCode;
    const responseTime = Date.now() - start;

    console.log(`[CHECK] ${method} ${url} → ${httpStatus}`);

    if (httpStatus !== 402) {
      console.log(`[DEBUG] Non-402 body (first 200 chars): ${response.body?.slice(0, 200)}`);
      return null;
    }

    try {
      const responseBody = JSON.parse(response.body);
      if (responseBody.accepts && Array.isArray(responseBody.accepts) && responseBody.accepts.length > 0) {
        const offer = responseBody.accepts[0];
        
        const rawAmount = offer.maxAmountRequired || offer.amount || '';
        const priceReadable = rawAmount ? `$${(parseInt(rawAmount, 10) / 1000000).toFixed(6)}` : '';

        return {
          domain: base,
          path,
          status: 'success',
          x402Version: responseBody.x402Version !== undefined ? String(responseBody.x402Version) : '',
          price: rawAmount,
          priceReadable: priceReadable,
          network: offer.network || '',
          asset: offer.asset || '',
          payTo: offer.payTo || '',
          label: offer.label || '',
          description: offer.description || '',
          httpStatus: String(httpStatus),
          responseTimeMs: String(responseTime),
          errorMessage: '',
          timestamp: new Date().toISOString(),
        };
      } else {
        return {
          domain: base,
          path,
          status: 'error',
          x402Version: responseBody.x402Version !== undefined ? String(responseBody.x402Version) : '',
          price: '',
          priceReadable: '',
          network: '',
          asset: '',
          payTo: '',
          label: '',
          description: '',
          httpStatus: String(httpStatus),
          responseTimeMs: String(responseTime),
          errorMessage: 'Missing accepts array in 402 response',
          timestamp: new Date().toISOString(),
        };
      }
    } catch (parseErr) {
      return {
        domain: base,
        path,
        status: 'error',
        x402Version: '',
        price: '',
        priceReadable: '',
        network: '',
        asset: '',
        payTo: '',
        label: '',
        description: '',
        httpStatus: String(httpStatus),
        responseTimeMs: String(responseTime),
        errorMessage: 'Invalid JSON in 402 body',
        timestamp: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.log(`[ERROR] ${method} ${url} → ${err.message}`);
    return {
      domain: base,
      path,
      status: 'error',
      x402Version: '',
      price: '',
      priceReadable: '',
      network: '',
      asset: '',
      payTo: '',
      label: '',
      description: '',
      httpStatus: '0',
      responseTimeMs: String(Date.now() - start),
      errorMessage: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// ========== INPUT ==========

const input = await Actor.getInput();
let {
  domain,
  paths: manualPaths,
  maxPaths = 100,
  timeout = 5000,
  includeSubdomains = false,
  useResidentialProxy = false,
} = input;

if (!domain) {
  await Actor.fail('Domain is required. Please provide a root domain to scan.');
  await Actor.exit();
}

domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const targetDomains = [normalizeDomain(domain)];
if (includeSubdomains) {
  targetDomains.push(`api.${normalizeDomain(domain)}`);
}

let proxyUrl = null;
if (useResidentialProxy) {
  const proxyConfig = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
  });
  proxyUrl = await proxyConfig.newUrl();
  console.log(`[PROXY] Using residential proxy: ${proxyUrl}`);
}

const results = [];

for (const base of targetDomains) {
  let scanList = [];

  if (manualPaths && manualPaths.trim()) {
    const paths = manualPaths.split('\n').map(p => p.trim()).filter(p => p);
    scanList = paths.map(p => ({ path: p, method: 'GET', body: null }));
  } else {
    const fromWellKnown = await discoverPathsFromWellKnown(base, timeout, proxyUrl) || [];
    const fromAgent = await discoverFromAgentServices(base, timeout, proxyUrl) || [];
    const combined = [...fromWellKnown, ...fromAgent];

    if (combined.length > 0) {
      scanList = combined;
      console.log(`Discovered ${scanList.length} endpoints for ${base}`);
    } else {
      console.log(`No discovery endpoints found for ${base}. Falling back to dictionary.`);
      scanList = BUILT_IN_DICTIONARY.slice(0, maxPaths).map(p => ({ path: p, method: 'GET', body: null }));
    }
  }

  for (const item of scanList) {
    const result = await checkEndpoint(base, item.path, item.method, item.body, timeout, proxyUrl);
    if (result) results.push(result);
  }
}

// ========== GENERATE REPORTS ==========

const docxBuffer = await generateDOCX(domain, results);
const pdfBuffer = await generatePDF(domain, results);

const docxUrl = await saveFileToKVS('OUTPUT.docx', docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const pdfUrl = await saveFileToKVS('OUTPUT.pdf', pdfBuffer, 'application/pdf');

const finalOutput = results.map(row => ({
  ...row,
  download_docx: docxUrl,
  download_pdf: pdfUrl,
}));

await Actor.pushData(finalOutput);
console.log(`Scan complete. ${finalOutput.length} endpoints found. Success: ${finalOutput.filter(r => r.status === 'success').length}, Errors: ${finalOutput.filter(r => r.status === 'error').length}`);

await Actor.exit();