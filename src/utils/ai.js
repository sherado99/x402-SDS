import got from 'got';

export async function guessPathsWithWorker(domain) {
  console.log(`[AI] Meminta Worker menebak path untuk: ${domain}...`);
  try {
    const response = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
      json: { domain: domain }, // Hanya kirim nama domain!
      responseType: 'json',
      timeout: { request: 10000 }
    } );

    const paths = response.body;
    if (Array.isArray(paths) && paths.length > 0) {
      console.log(`[AI] Worker berhasil menebak ${paths.length} path!`);
      return paths;
    }
  } catch (err) {
    console.log(`[AI] Gagal menghubungi Worker: ${err.message}`);
  }
  return [];
}
