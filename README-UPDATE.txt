TRACKFYP BACKEND UPDATE

Replace server.js and package.json in Digitaldevelopstudio/TrackFyp-Backend with these files and commit. Render will redeploy. The code defaults to Gemini gemini-3.8-flash and removes retired fallback models. Set GEMINI_MODEL=gemini-3.8-flash in Render if desired. Existing API key/quota limits still apply; code cannot bypass Gemini free-tier quota. Video duration values over 1000 are normalized from milliseconds to seconds. Trend endpoint generates niche-aware AI fallback ideas when public data is unavailable, clearly labelled as ideas rather than live trends.

Never upload API keys to GitHub.
