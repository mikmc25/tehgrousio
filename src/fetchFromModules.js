// src/fetchFromModules.js
import { STREAM_SOURCES } from './const.js';

export async function fetchFromModules({ type, query }) {
  const results = [];
  const seenHashes = new Set();

  await Promise.all(Object.entries(STREAM_SOURCES).map(async ([key, source]) => {
    try {
      const url = `${source.url}/api/search?type=${type}&query=${encodeURIComponent(query)}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`⚠️ ${source.name} failed: ${response.status}`);
        return;
      }

      const json = await response.json();
      const streams = json.results || [];

      for (const item of streams) {
        const hash = item.magnetLink?.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
        if (!hash || seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        results.push({
          hash,
          filename: item.filename || item.title || 'Unknown',
          quality: item.quality || '',
          size: item.size || '',
          source: source.name,
          magnetLink: item.magnetLink
        });
      }
    } catch (err) {
      console.warn(`❌ Error fetching from ${source.name}:`, err.message);
    }
  }));

  return results;
}
