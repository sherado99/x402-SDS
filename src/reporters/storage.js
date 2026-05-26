// src/reporters/storage.js
import { Actor } from 'apify';

export async function saveFileToKVS(filename, buffer, contentType) {
  const store = await Actor.openKeyValueStore();
  await store.setValue(filename, buffer, { contentType });
  return `https://api.apify.com/v2/key-value-stores/${store.id}/records/${filename}?disableRedirect=true`;
}
