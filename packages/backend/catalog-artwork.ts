/** Portable transport used by the browser and desktop's HTTP bridge. */
export async function downloadCatalogArtwork(url: string): Promise<Uint8Array<ArrayBuffer>> {
  if (new URL(url).protocol !== 'https:') throw new Error('Invalid artwork URL');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), credentials: 'omit', redirect: 'error' });
  const maximum = 3_000_000;
  if (!response.ok || !response.body) throw new Error('Could not download artwork');
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg') || Number(response.headers.get('content-length')) > maximum) {
    await response.body.cancel();
    throw new Error('Invalid artwork response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error('Artwork exceeds 3 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Artwork is not a JPEG image');
  return bytes;
}
