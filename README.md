# TrackFyp Backend

Node/Express backend for TrackFyp.

## Render
- Build: `npm install`
- Start: `node server.js`
- Service: `trackfyp-backend-new`

Required environment variables:
- GEMINI_API_KEY
- SAFEPAY_PUBLIC_KEY
- SAFEPAY_SECRET_KEY
- SUPABASE_URL
- SUPABASE_KEY
- ADMIN_EMAIL

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

Never commit real API keys to GitHub.
