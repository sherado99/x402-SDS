// src/reporters/docx.js
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';

export async function generateDOCX(domain, results) {
  const children = [
    new Paragraph({ text: 'X402 Domain Scan Report', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    new Paragraph({ text: `Domain: ${domain}`, spacing: { after: 60 } }),
    new Paragraph({ text: `Scan time: ${new Date().toISOString()}`, spacing: { after: 200 } }),
  ];

  if (results.length === 0) {
    children.push(new Paragraph({ text: 'No public X402 information found on this domain.', spacing: { after: 120 } }));
  } else {
    for (const row of results) {
      // FIXED: Menggunakan row.httpStatus agar tidak muncul [undefined]
      children.push(new Paragraph({ text: `${row.path} [${row.httpStatus}]`, heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 60 } }));
      if (row.priceReadable) children.push(new Paragraph({ text: `Price: ${row.priceReadable} | Network: ${row.network}`, spacing: { after: 40 } }));
      if (row.label) children.push(new Paragraph({ text: `Label: ${row.label}`, spacing: { after: 40 } }));
      if (row.asset) children.push(new Paragraph({ text: `Asset: ${row.asset}`, spacing: { after: 40 } }));
      if (row.payTo) children.push(new Paragraph({ text: `Pay To: ${row.payTo}`, spacing: { after: 40 } }));
      if (row.description) children.push(new Paragraph({ text: `Description: ${row.description}`, spacing: { after: 40 } }));
      if (row.auditHash) children.push(new Paragraph({ text: `Audit Hash: ${row.auditHash}`, spacing: { after: 40 } }));
      if (row.errorMessage) children.push(new Paragraph({ text: `Error: ${row.errorMessage}`, spacing: { after: 40 } }));
      children.push(new Paragraph({ text: `HTTP Status: ${row.httpStatus} | Response Time: ${row.responseTimeMs}ms`, spacing: { after: 80 } } ));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}
