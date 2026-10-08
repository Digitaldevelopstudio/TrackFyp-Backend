# TrackFyp Backend

Render service for TrackFyp.

## Start
`npm install`
`npm start`

## Environment variables
- GEMINI_API_KEY
- SAFEPAY_PUBLIC_KEY
- SAFEPAY_SECRET_KEY
- SUPABASE_URL
- SUPABASE_KEY
- ADMIN_EMAIL

Do not put secret values in GitHub.

## Main endpoints
- GET /api/analyze?url=
- GET /api/download-file?url=
- GET /api/channel-analyze?url=
- GET /api/trending?country=
- GET /api/shadowban-check?url=
- POST /api/premium-analyze (multipart: video,email)
- POST /api/ai-text (JSON: email,task,topic,...)
- POST /api/create-checkout (JSON: email,plan)
- POST /api/safepay-webhook
- GET /api/check-subscription?email=
