// src/reporters/pdf.js
import PDFDocument from 'pdfkit';

export async function generatePDF(domain, results, totalFound = 0, totalProbed = 0) {
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
    
    // STATISTIK TEASER (ENGLISH)
    if (totalFound > 0) {
      doc.moveDown();
      doc.fontSize(12).text(`TOTAL ENDPOINTS FOUND: ${totalFound}`, { stroke: true });
      doc.fontSize(12).text(`ENDPOINTS VERIFIED: ${totalProbed}`);
    }
    doc.moveDown();

    if (results.length === 0) {
      doc.fontSize(12).text('No public X402 information found on this domain.');
    } else {
      for (const row of results) {
        doc.fontSize(12).text(`${row.path} [${row.httpStatus}]`, { underline: true } );
        if (row.priceReadable) doc.fontSize(10).text(`Price: ${row.priceReadable} | Network: ${row.network}`);
        if (row.label) doc.fontSize(10).text(`Label: ${row.label}`);
        if (row.asset) doc.fontSize(10).text(`Asset: ${row.asset}`);
        if (row.payTo) doc.fontSize(10).text(`Pay To: ${row.payTo}`);
        if (row.description) doc.fontSize(10).text(`Description: ${row.description}`);
        if (row.auditHash) doc.fontSize(10).text(`Audit Hash: ${row.auditHash}`);
        if (row.errorMessage) doc.fontSize(10).text(`Error: ${row.errorMessage}`);
        doc.fontSize(9).text(`HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`  ); 
        doc.moveDown(0.5);
      }
    }

    // PESAN UPSELL (ENGLISH)
    if (totalFound > totalProbed) {
      const lockedCount = totalFound - totalProbed;
      doc.moveDown(2);
      doc.fontSize(12).fillColor('red')
         .text(`🔒 ${lockedCount} ADDITIONAL ENDPOINTS REMAIN UNAUDITED.`, { align: 'center' });
      doc.fontSize(10).fillColor('gray')
         .text(`Please top up your balance on our website to unlock the full audit report.`, { align: 'center' });
    }

    doc.end();
  });
}
