// Needle Drop: the Cloudflare Worker.
//
// It does two jobs:
//   1. /api/search?q=…  asks YouTube for music videos and returns a short list
//      of records (id, title, artist, cover). The YouTube key lives here as a
//      secret, so visitors never see it.
//   2. Everything else is the static site in /public (served by Cloudflare).
//
// Searches are cached for 6 hours. YouTube gives each key about 100 searches a
// day for free, so the cache is what stops a popular query from using it up.
//
// Figma analogy: this file is like a plugin that runs behind the published
// prototype. The prototype (public/) asks it for data; it fetches and tidies it.

const CACHE_SECONDS = 6 * 60 * 60;
const MAX_RESULTS = 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search') return search(url, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

async function search(url, env, ctx) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!q) return json({ error: 'empty' }, 400);
  if (!env.YOUTUBE_API_KEY) return json({ error: 'nokey' }, 500);

  // Same query, any capitalisation → one cache entry.
  // Figma analogy: a shared Style, so identical requests reuse one result.
  const cacheKey = new Request(`https://needle-drop.cache/search?q=${encodeURIComponent(q.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const api = new URL('https://www.googleapis.com/youtube/v3/search');
  api.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',        // Music
    videoEmbeddable: 'true',      // only videos that are allowed to play here
    videoSyndicated: 'true',
    maxResults: String(MAX_RESULTS),
    q,
    key: env.YOUTUBE_API_KEY,
  }).toString();

  let res;
  try {
    res = await fetch(api, { headers: { Referer: url.origin + '/' } });
  } catch {
    return json({ error: 'network' }, 502);
  }
  if (!res.ok) {
    const body = await res.text();
    const quota = res.status === 403 && /quota/i.test(body);
    return json({ error: quota ? 'quota' : 'youtube' }, quota ? 503 : 502);
  }

  const data = await res.json();
  const records = (data.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => ({
      id: it.id.videoId,
      title: decode(it.snippet.title),
      artist: decode(it.snippet.channelTitle).replace(/ - Topic$/, '').replace(/VEVO$/, ''),
      // 320×180, no black bars (the larger "hq" thumbnail is letterboxed).
      cover: (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
    }));

  const out = json({ q, records }, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// YouTube sends titles HTML-escaped ("Rock &amp; Roll"). Turn them back into text.
function decode(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
