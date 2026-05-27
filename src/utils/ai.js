// src/utils/ai.js
import got from 'got';

export async function guessPathsWithWorker(content) {
  if (!content || content.length < 50) return [];
  
  console.log(`[AI] Meminta Worker membaca ${content.length} karakter teks HTML...`);
  try {
    const response = await got.post('https://stech-api.sheradogilang.workers.dev/x402/sds', {
      json: { content: content }, // Kirim teks HTML ke Worker
      responseType: 'json',
      timeout: { request: 15000 } // Beri waktu 15 detik untuk AI berpikir
    } );

    const paths = response.body;
    if (Array.isArray(paths) && paths.length > 0) {
      console.log(`[AI] Worker berhasil menemukan ${paths.length} path!`);
      return paths;
    }
  } catch (err) {
    console.log(`[AI] Gagal menghubungi Worker: ${err.message}`);
  }
  return [];
}
