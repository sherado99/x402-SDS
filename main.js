const Apify = require('apify');
const got = require('got');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const fs = require('fs');

Apify.main(async () => {
    const input = await Apify.getInput();
    const { domain, paths: manualPaths, maxPaths = 100, timeout = 5000, includeSubdomains = false } = input;

    // Determine the list of paths to check
    let pathsToCheck = [];
    if (manualPaths && manualPaths.trim()) {
        // Use manual input from textarea (split by line)
        pathsToCheck = manualPaths.split('\n').map(p => p.trim()).filter(p => p);
    } else {
        // Use built-in dictionary
        const dictionary = JSON.parse(fs.readFileSync('paths_dictionary.json', 'utf-8'));
        pathsToCheck = dictionary.slice(0, maxPaths);
    }

    const results = [];
    const normalizeDomain = (d) => d.replace(/\/+$/, '');
    const targetDomains = [normalizeDomain(domain)];
    if (includeSubdomains) {
        targetDomains.push(`api.${normalizeDomain(domain)}`);
    }

    for (const base of targetDomains) {
        for (const path of pathsToCheck) {
            const url = `https://${base}${path}`;
            const start = Date.now();
            let httpStatus = null;
            let errorMessage = '';

            try {
                const response = await got(url, {
                    method: 'GET',
                    timeout: { request: timeout },
                    throwHttpErrors: false,
                    retry: { limit: 0 }
                });
                httpStatus = response.statusCode;
                const responseTime = Date.now() - start;

                if (httpStatus === 402) {
                    try {
                        const body = JSON.parse(response.body);
                        if (body.accepts && Array.isArray(body.accepts)) {
                            const offer = body.accepts[0];
                            results.push({
                                domain: base,
                                path,
                                status: 'success',
                                x402Version: body.x402Version || null,
                                price: offer.amount,
                                network: offer.network || '',
                                asset: offer.asset || '',
                                payTo: offer.payTo || '',
                                label: offer.label || '',
                                description: offer.description || '',
                                httpStatus,
                                responseTimeMs: responseTime,
                                errorMessage: '',
                                timestamp: new Date().toISOString()
                            });
                        } else {
                            results.push({
                                domain: base,
                                path,
                                status: 'error',
                                x402Version: body.x402Version || null,
                                price: '',
                                network: '',
                                asset: '',
                                payTo: '',
                                label: '',
                                description: '',
                                httpStatus,
                                responseTimeMs: responseTime,
                                errorMessage: 'Missing accepts array in 402 response',
                                timestamp: new Date().toISOString()
                            });
                        }
                    } catch (parseErr) {
                        results.push({
                            domain: base,
                            path,
                            status: 'error',
                            x402Version: null,
                            price: '',
                            network: '',
                            asset: '',
                            payTo: '',
                            label: '',
                            description: '',
                            httpStatus,
                            responseTimeMs: responseTime,
                            errorMessage: 'Invalid JSON in 402 body',
                            timestamp: new Date().toISOString()
                        });
                    }
                } else {
                    results.push({
                        domain: base,
                        path,
                        status: 'not_found',
                        x402Version: null,
                        price: '',
                        network: '',
                        asset: '',
                        payTo: '',
                        label: '',
                        description: '',
                        httpStatus,
                        responseTimeMs: Date.now() - start,
                        errorMessage: '',
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (err) {
                results.push({
                    domain: base,
                    path,
                    status: 'error',
                    x402Version: null,
                    price: '',
                    network: '',
                    asset: '',
                    payTo: '',
                    label: '',
                    description: '',
                    httpStatus: 0,
                    responseTimeMs: Date.now() - start,
                    errorMessage: err.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    // Store results in Apify dataset (built-in CSV export is available)
    await Apify.pushData(results);

    // Generate PDF report
    const pdfDoc = new PDFDocument({ margin: 30 });
    const pdfPath = '/tmp/OUTPUT.pdf';
    const pdfStream = fs.createWriteStream(pdfPath);
    pdfDoc.pipe(pdfStream);

    pdfDoc.fontSize(18).text('X402 Domain Scan Report', { align: 'center' });
    pdfDoc.moveDown();
    pdfDoc.fontSize(11).text(`Domain: ${domain}`);
    pdfDoc.text(`Scan time: ${new Date().toISOString()}`);
    pdfDoc.moveDown();

    results.forEach((row, idx) => {
        pdfDoc.fontSize(10).text(`${idx + 1}. ${row.path} [${row.status}]`);
        if (row.status === 'success') {
            pdfDoc.text(`   Price: ${row.price} | Network: ${row.network} | Label: ${row.label}`);
            pdfDoc.text(`   Asset: ${row.asset} | PayTo: ${row.payTo}`);
            pdfDoc.text(`   Description: ${row.description}`);
        } else if (row.errorMessage) {
            pdfDoc.text(`   Error: ${row.errorMessage}`);
        }
        pdfDoc.text(`   HTTP Status: ${row.httpStatus} | Time: ${row.responseTimeMs}ms`);
        pdfDoc.moveDown(0.5);
    });

    pdfDoc.end();
    await new Promise((resolve) => pdfStream.on('finish', resolve));
    await Apify.setValue('OUTPUT.pdf', fs.createReadStream(pdfPath), { contentType: 'application/pdf' });

    // Generate DOCX report
    const docParagraphs = [
        new Paragraph({ children: [new TextRun({ text: 'X402 Domain Scan Report', bold: true, size: 28 })] }),
        new Paragraph({ children: [new TextRun(`Domain: ${domain}`)] }),
        new Paragraph({ children: [new TextRun(`Scan time: ${new Date().toISOString()}`)] }),
        new Paragraph({ children: [new TextRun('')] }) // spacer
    ];

    results.forEach((row, idx) => {
        docParagraphs.push(new Paragraph({
            children: [new TextRun({ text: `${idx + 1}. ${row.path} [${row.status}]`, bold: true })]
        }));
        if (row.status === 'success') {
            docParagraphs.push(new Paragraph(`   Price: ${row.price} | Network: ${row.network} | Label: ${row.label}`));
            docParagraphs.push(new Paragraph(`   Asset: ${row.asset} | PayTo: ${row.payTo}`));
            docParagraphs.push(new Paragraph(`   Description: ${row.description}`));
        } else if (row.errorMessage) {
            docParagraphs.push(new Paragraph(`   Error: ${row.errorMessage}`));
        }
        docParagraphs.push(new Paragraph(`   HTTP Status: ${row.httpStatus} | Time: ${row.responseTimeMs}ms`));
        docParagraphs.push(new Paragraph(''));
    });

    const doc = new Document({ sections: [{ children: docParagraphs }] });
    const docxBuffer = await Packer.toBuffer(doc);
    await Apify.setValue('OUTPUT.docx', docxBuffer, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    console.log(`Scan complete. ${results.length} paths checked. PDF and DOCX reports generated.`);
});
