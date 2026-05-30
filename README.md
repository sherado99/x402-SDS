# X402 Domain Full Scanner
**Discover, Audit, and Export X402 Payment Endpoints for AI Agents and Web3 APIs**

SDS is a specialized Market Intelligence Actor on the Apify Store that scans any root domain to discover monetized API endpoints using the X402 protocol. It automatically extracts real-time pricing, wallet addresses, and network data, returning them as structured JSON alongside ready-to-download DOCX and PDF reports.

It is especially useful for tasks such as:
*   Auditing AI Agent monetization structures
*   Competitive pricing analysis for Web3 APIs
*   Building directories of paid AI services
*   Verifying X402 protocol compliance (v1 and v2)

SDS can process a single domain and probe dozens of endpoints in a single run. Each endpoint is verified individually, ensuring the data is accurate and up-to-date.

SDS helps researchers and developers map the emerging Agent Economy with precision.

Unlike generic web scrapers, SDS is purpose-built for the X402 protocol. It actively triggers `402 Payment Required` responses and decodes complex Base64 headers to extract hidden billing information.

### 🎯 Who SDS Is For
SDS is designed for professionals and organizations that need to track, audit, or utilize monetized AI APIs.

**Web3 Researchers & Analysts**
Map the Agent Economy, track API pricing trends, and discover which blockchain networks are dominating the AI space.

**AI Developers & Builders**
Audit your own monetized endpoints to ensure compliance, or analyze competitors' pricing models and service offerings.

**Data Aggregators**
Automatically populate directories and databases with verified, real-time data of paid AI services.

**Automation Engineers**
Use SDS as a discovery component in workflows built with n8n, Make, Zapier, or custom applications to automatically fund and consume AI APIs.

### 📣 Why SDS Matters
Discovering X402 endpoints manually is a tedious and highly technical process. To find a single API's price, a developer usually has to:
1. Search for hidden `.well-known` files or query third-party directories.
2. Manually send HTTP requests to trigger a `402 Payment Required` error.
3. Intercept the HTTP headers and manually decode Base64 strings just to read the price and wallet address.

SDS automates this entire pipeline in seconds. 

You simply provide a domain (e.g., `stech-api.sheradogilang.workers.dev`), and SDS will intelligently harvest the paths, probe the endpoints, decode the Base64 headers, and hand you a clean, professional PDF report containing the exact price, asset (e.g., USDC), and wallet address for every API on that domain.

### ⚙️ Two Ways to Use SDS
| As a Standalone Tool | As a Workflow Component |
| :--- | :--- |
| Enter a domain and download the PDF/DOCX report. | Integrate SDS into automated workflows and AI agents. |
| Best for analysts, researchers, and non-technical users. | Best for developers and data aggregators. |
| No coding required. | Works with APIs and automation platforms. |

### 🚀 Key Features
*   **X402 v1 & v2 Support** — Automatically detects protocol versions and decodes Base64 `payment-required` headers.
*   **Smart Discovery (Harvester)** — Queries the public directory to find hidden endpoints (UUID harvesting).
*   **Active Probing** — Actively fetches endpoints to trigger real-time 402 responses, ensuring pricing is 100% accurate.
*   **Structured JSON Output** — Ideal for automation, API integrations, and database storage.
*   **DOCX and PDF Generation** — Ready-to-share audit reports generated automatically for every scan.
*   **Audit Hash** — Each output includes a SHA-256 fingerprint of the raw response body to support verifiable claims.
*   **Fallback Dictionary** — Uses a built-in dictionary of common AI paths if public directories fail.
*   **Bypass Blocks** — Optional residential proxy support to bypass strict Cloudflare or WAF protections.

### 📄 Output Formats
SDS generates multiple output formats in a single run.

| Format | Purpose |
| :--- | :--- |
| **JSON** | API integrations and automated workflows |
| **CSV** | Spreadsheet review and batch export |
| **DOCX** | Editable audit documents |
| **PDF** | Finalized and archival audit reports |

*JSON is the primary output for automation. CSV, DOCX, and PDF are supporting formats for operational use.*

### 📥 Input Fields
| Field | Required | Description |
| :--- | :--- | :--- |
| `domain` | **Yes** | The root domain to scan (e.g., `stech-api.sheradogilang.workers.dev`). |
| `paths` | No | List specific paths to check manually (one per line). |
| `maxPaths` | No | Maximum number of paths to try when using the built-in dictionary. |
| `timeout` | No | Timeout per request in milliseconds (Default: 15000). |
| `useResidentialProxy` | No | Route requests through residential IPs to avoid datacenter blocks. |

### 📤 Example Output
```json
[{
  "domain": "stech-api.sheradogilang.workers.dev",
  "path": "/x402/scdft",
  "x402Version": "2",
  "price": "1100000",
  "priceReadable": "$1.100000",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo": "0x6428761Db59894899b26809503ac83b7790C6fB0",
  "label": "Ethical AI that transforms raw complaints into clear, honest, actionable reports.",
  "description": "Ethical AI that transforms raw complaints into clear, honest, actionable reports.",
  "source": "scraper:402",
  "auditHash": "55b3e70254628b65fae5091cc3f819a0f60415a008dffdef7cfaa46ec0041dcf",
  "httpStatus": "402",
  "responseTimeMs": "2388",
  "errorMessage": "",
  "timestamp": "2026-05-30T17:07:38.567Z",
  "download_docx": "https://api.apify.com/v2/key-value-stores/qI5pToncELMaYrhrP/records/OUTPUT.docx?disableRedirect=true",
  "download_pdf": "https://api.apify.com/v2/key-value-stores/qI5pToncELMaYrhrP/records/OUTPUT.pdf?disableRedirect=true"
}]
```

### 🧪 Example Workflow (Market Analyst)
1. Identify a new AI Agent domain (e.g., `stech-api.sheradogilang.workers.dev`).
2. Enter the domain into SDS.
3. Run the Actor.
4. Download the generated PDF report.
5. Review the exact pricing, supported blockchain networks, and wallet addresses of the target API.

*What once took hours of manual API testing and Base64 decoding can be completed in seconds.*

### 🔌 Integrations
As a published Apify Actor, SDS can be used with:
*   n8n
*   Make
*   Zapier
*   Google Sheets / Airtable
*   Custom applications via the Apify API

Users connect their own accounts and control their own workflows.

### ❗ Important Notes
*   **403 Errors during discovery are normal:** Many modern APIs block standard web scrapers. SDS is designed to handle this gracefully by falling back to the Harvester and active probing.
*   **Public Data Only:** SDS only extracts data that is publicly exposed by the target server via HTTP 402 responses or public directories.
*   **Rate Limiting:** SDS is built to be a "polite" scanner. It uses a strict concurrency limit and delays to ensure target servers are not overwhelmed.
*   Files remain available in your Apify run outputs until you delete them.

### 💼 Business Value
Organizations use SDS to:
*   Gain real-time market intelligence on AI API pricing
*   Automate the discovery of Web3 monetization structures
*   Standardize API auditing processes
*   Reduce manual testing and decoding time

### ⚠️ Disclaimer
*   **Data Accuracy:** SDS is an automated market intelligence tool. All data (including prices, wallet addresses, networks, and descriptions) is extracted directly from public HTTP responses provided by the target servers in real-time. SDS does not alter this data and cannot guarantee its absolute accuracy.
*   **No Financial Advice:** The generated reports do not constitute financial, legal, or investment advice. Always verify wallet addresses, networks, and pricing manually before executing any cryptocurrency transactions or integrating paid APIs.
*   **No Affiliation:** Stech and the SDS tool are not affiliated with, endorsed by, or sponsored by any of the domains or directories scanned using this tool.
*   **User Responsibility:** Users are solely responsible for ensuring that their use of this tool complies with applicable laws, regulations, and the Terms of Service of the target domains being scanned.


### 📄 License
All rights reserved under the Stech Commercial License (SCL) v2.1.

Stech helps organizations navigate the Agent Economy with clarity, precision, and professionalism.

Professional tools should be powerful, but they should never be overly complicated.

Stech – honest, warm, and never pretends to be human. 😊🌿