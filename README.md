# TrackFyp Backend (ScrapeCreators-enabled)

Node/Express backend for TrackFyp. This build adds ScrapeCreators as the preferred source for TikTok video and public profile data when `SCRAPECREATORS_API_KEY` is configured. If the provider request fails, existing TikTok public-page/oEmbed fallback logic is retained.

## Render settings
- Build command: `npm install`
- Start command: `node server.js`
- Service: `trackfyp-backend-new`

Environment variables used by this project:
- `SCRAPECREATORS_API_KEY` (new; keep secret; never put it in GitHub)
- `GEMINI_API_KEY`
- `SAFEPAY_PUBLIC_KEY`
- `SAFEPAY_SECRET_KEY`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `ADMIN_EMAIL`

## Endpoints
- `/api/health`
- `/api/analyze`
- `/api/channel-analyze`
- `/api/download`
- `/api/download-file`
- `/api/shadowban-check`
- `/api/trending`
- `/api/premium-analyze`
- `/api/ai-text`
- `/api/create-checkout`
- `/api/safepay-webhook`
- `/api/check-subscription`

The ScrapeCreators integration uses `GET https://api.scrapecreators.com/v2/tiktok/video?url=...` for video metadata and `GET https://api.scrapecreators.com/v1/tiktok/profile?handle=...` for profile metadata, authenticated via the `x-api-key` header.
