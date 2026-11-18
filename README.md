# Needle Drop

A retro record player for YouTube. Search any song and it comes back as a record in a sleeve; drop it on the turntable and it plays on the little TV.

- **Site:** plain HTML, CSS and JavaScript in `public/`. No framework, no build step (~200 KB with images).
- **Search:** `src/worker.js`, a Cloudflare Worker that calls the YouTube Data API with a secret key and caches each search for 6 hours.
- **Player:** YouTube's own embedded player, shown on the TV (always visible, at least 200 × 200 px, controls untouched), as YouTube's API policies require.

## Setup

1. In Google Cloud, enable **YouTube Data API v3** and create an API key.
2. In Cloudflare (Workers → `needle-drop` → Settings → Variables and Secrets), add a secret named `YOUTUBE_API_KEY`.
3. Every push to `main` deploys.

The free YouTube quota is 10,000 units a day; one search costs 100, so roughly 100 fresh searches a day. Cached repeats are free.

Turntable photos are Nano Banana renders made for [rishik-jha.rishikrkjha.workers.dev](https://rishik-jha.rishikrkjha.workers.dev). Built with Claude.
