CLARIGI WORKER DEPLOYMENT

1. Open wrangler.toml.
2. Replace:
   PASTE_YOUR_EXISTING_REPORTS_KV_NAMESPACE_ID_HERE
   with the existing Namespace ID for REPORTS_KV.
3. Do NOT change the Worker name, ASSETS binding, or REPORTS_KV binding.
4. In Terminal:
   cd ~/Downloads/clarigi-worker
   npx wrangler@latest login
   npx wrangler@latest deploy

The existing GEMINI_API_KEY secret should remain on the Worker. Do not delete it.
After deployment, test:
https://c.clarigi-info.workers.dev/r/8fa8c969

Expected result: the Clarigi report page loads, not {"error":"assets not configured"}.

Files:
- src/index.js = current Worker
- public/report-page.html = current diagnostic/report HTML
- wrangler.toml = Static Assets + existing KV configuration
