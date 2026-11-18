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

import { DurableObject } from 'cloudflare:workers';

const CACHE_SECONDS = 6 * 60 * 60;
const MAX_RESULTS = 12;
const HOT_SECONDS = 10 * 60;      // the Hot list is rebuilt at most every 10 minutes
const HOT_DAYS = 7;               // "Hot this week"
const VIDEO_ID = /^[\w-]{11}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search') return search(url, env, ctx);
    if (url.pathname === '/api/play' && request.method === 'POST') return play(request, env);
    if (url.pathname === '/api/hot') return hot(url, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

// ── Hot this week ───────────────────────────────────────────────────────────
// Every play is counted once per listener per song per day. The listener is a
// one-way hash of their IP and the date, so no IP is ever stored and the hash
// changes every day. Only video IDs are kept; titles and covers are fetched
// fresh from YouTube, so nobody can put made-up text on the page.
//
// Figma analogy: a shared library file every visitor's copy reads from. The
// Durable Object is that one file; each play is a small edit to it.
export class HotChart extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS plays (day INTEGER, id TEXT, who TEXT, PRIMARY KEY (day, id, who))');
  }
  add(id, who) {
    const day = today();
    this.sql.exec('INSERT OR IGNORE INTO plays VALUES (?, ?, ?)', day, id, who);
    this.sql.exec('DELETE FROM plays WHERE day < ?', day - HOT_DAYS);
  }
  top(n) {
    return this.sql
      .exec('SELECT id, COUNT(*) AS plays FROM plays WHERE day > ? GROUP BY id ORDER BY plays DESC, MAX(day) DESC LIMIT ?', today() - HOT_DAYS, n)
      .toArray();
  }
}
const today = () => Math.floor(Date.now() / 86400000);
const chart = (env) => env.HOT.get(env.HOT.idFromName('global'));

async function play(request, env) {
  let id;
  try { ({ id } = await request.json()); } catch { /* bad body */ }
  if (!VIDEO_ID.test(id || '')) return json({ error: 'bad id' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${today()}|${env.HOT_SALT || 'needle-drop'}`));
  const who = [...new Uint8Array(bytes).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await chart(env).add(id, who);
  return new Response(null, { status: 204 });
}

async function hot(url, env, ctx) {
  const cacheKey = new Request('https://needle-drop.cache/hot');
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const top = await chart(env).top(12);
  let records = [];
  if (top.length && env.YOUTUBE_API_KEY) {
    // One videos.list call (1 quota unit) for up to 50 IDs.
    const api = new URL('https://www.googleapis.com/youtube/v3/videos');
    api.search = new URLSearchParams({ part: 'snippet,status', id: top.map((t) => t.id).join(','), key: env.YOUTUBE_API_KEY }).toString();
    const res = await fetch(api, { headers: { Referer: url.origin + '/' } }).catch(() => null);
    if (res && res.ok) {
      const byId = new Map(((await res.json()).items || []).map((v) => [v.id, v]));
      records = top
        .map((t) => ({ t, v: byId.get(t.id) }))
        .filter(({ v }) => v && v.status && v.status.embeddable && v.status.privacyStatus === 'public')
        .slice(0, 8)
        .map(({ t, v }) => ({ ...toRecord(t.id, v.snippet), plays: t.plays }));
    }
  }
  const out = json({ records }, 200, { 'Cache-Control': `public, max-age=${HOT_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function toRecord(id, snippet) {
  return {
    id,
    title: decode(snippet.title),
    artist: decode(snippet.channelTitle).replace(/ - Topic$/, '').replace(/VEVO$/, ''),
    cover: (snippet.thumbnails.medium || snippet.thumbnails.default).url,
  };
}

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
    // Cover: the 320×180 thumbnail, no black bars (the larger "hq" one is letterboxed).
    .map((it) => toRecord(it.id.videoId, it.snippet));

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
