/**
 * Clarigi Diagnostic — Cloudflare Worker backend
 * Fetches real pages from the target site, extracts real text + real links,
 * sends that grounded content to Gemini, and returns validated JSON.
 *
 * Shared reports:
 *   POST /save        -> stores the report in KV, returns { id, shortUrl, longUrl }
 *   GET  /report?id=  -> returns the stored report JSON (unchanged contract)
 *   GET  /r/{id}      -> serves the CURRENT report HTML directly from this Worker's
 *                        Static Assets (public/report-page.html). No redirect,
 *                        no Wix/filesusr dependency.
 *
 * Setup (see wrangler.toml):
 * 1. Secret GEMINI_API_KEY (Worker settings -> Variables -> Add secret).
 * 2. KV namespace bound as REPORTS_KV.
 * 3. Static Assets bound as ASSETS, directory ./public, with
 *    run_worker_first = true and html_handling = "none".
 * 4. Deploy with `wrangler deploy` so the HTML asset is uploaded with the Worker.
 */

const GEMINI_MODEL = "gemini-3.6-flash";
const CANDIDATE_PATHS = [
  "/", "/pages/returns", "/pages/return-policy", "/pages/refund-policy",
  "/pages/size-guide", "/pages/sizing", "/pages/shipping",
  "/pages/faq", "/pages/faqs", "/pages/about", "/pages/about-us",
  "/collections/all", "/products"
];
const MAX_PAGES_TO_FETCH = 6;
const MAX_CHARS_PER_PAGE = 6000;

// CORS: the diagnostic tool runs inside Wix (a different origin) and calls this Worker.
const ALLOWED_ORIGIN = "*"; // unchanged from current behavior; see notes at bottom

// Public origin used to build share links.
const PUBLIC_BASE_URL = "https://c.clarigi-info.workers.dev";

// Path of the report page inside ./public (Static Assets). Deliberately NOT
// named report.html so it can never collide with the /report JSON endpoint.
const REPORT_PAGE_PATH = "/report-page.html";

// IDs are crypto.randomUUID().slice(0, 8) (hex). Accept a slightly wider safe range.
const REPORT_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return corsResponse(jsonResponse({ error: "internal error" }, 500));
    }
  }
};

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return corsResponse(new Response(null, { status: 204 }));
  }

  const url = new URL(request.url);

  // GET /r/{id} -> serve the current report HTML directly (NO redirect)
  const rMatch = url.pathname.match(/^\/r\/([^\/]+)\/?$/);
  if (request.method === "GET" && rMatch) {
    const id = rMatch[1];
    if (!REPORT_ID_RE.test(id)) return corsResponse(jsonResponse({ error: "invalid id" }, 400));
    if (!env.REPORTS_KV) return corsResponse(jsonResponse({ error: "KV not configured" }, 500));
    if (!env.ASSETS) return corsResponse(jsonResponse({ error: "assets not configured" }, 500));

    const stored = await env.REPORTS_KV.get(id);
    if (!stored) return corsResponse(jsonResponse({ error: "report not found" }, 404));

    const assetRes = await env.ASSETS.fetch(new Request(new URL(REPORT_PAGE_PATH, url.origin).toString(), { method: "GET" }));
    if (!assetRes.ok) return corsResponse(jsonResponse({ error: "report page unavailable" }, 500));

    const headers = new Headers(assetRes.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-cache"); // always revalidate so a stale copy is never served
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(assetRes.body, { status: 200, headers });
  }

  // GET /report?id=xxx -> raw JSON of a previously saved report (contract unchanged)
  if (request.method === "GET" && url.pathname === "/report") {
    const id = url.searchParams.get("id");
    if (!id || !REPORT_ID_RE.test(id)) return corsResponse(jsonResponse({ error: "missing or invalid id" }, 400));
    if (!env.REPORTS_KV) return corsResponse(jsonResponse({ error: "KV not configured" }, 500));
    const stored = await env.REPORTS_KV.get(id);
    if (!stored) return corsResponse(jsonResponse({ error: "report not found" }, 404));
    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (e) {
      return corsResponse(jsonResponse({ error: "stored report is corrupted" }, 500));
    }
    return corsResponse(jsonResponse(parsed, 200));
  }

  if (request.method !== "POST") {
    return corsResponse(jsonResponse({ error: "POST only" }, 405));
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return corsResponse(jsonResponse({ error: "invalid JSON body" }, 400));
  }

  // POST /save { report: {...} } -> store a report, return id + share URL on this Worker's own domain
  if (url.pathname === "/save") {
    if (!body.report) return corsResponse(jsonResponse({ error: "missing report" }, 400));
    if (!env.REPORTS_KV) return corsResponse(jsonResponse({ error: "KV not configured" }, 500));

    const id = crypto.randomUUID().slice(0, 8);
    await env.REPORTS_KV.put(id, JSON.stringify(body.report), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days

    const shortUrl = `${PUBLIC_BASE_URL}/r/${id}`;
    // longUrl kept in the response so the response shape is unchanged; it is now the same URL.
    return corsResponse(jsonResponse({ id, shortUrl, longUrl: shortUrl }, 200));
  }

  // POST / (default) -> run the diagnostic
  const siteUrl = body.siteUrl;
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) {
    return corsResponse(jsonResponse({ error: "siteUrl must be a full URL" }, 400));
  }

  if (!env.GEMINI_API_KEY) {
    return corsResponse(jsonResponse({ error: "server not configured: missing GEMINI_API_KEY secret" }, 500));
  }

  try {
    const crawl = await crawlSite(siteUrl);
    const reportJson = await callGemini(env.GEMINI_API_KEY, siteUrl, crawl);
    const validated = validateReferenceUrls(reportJson, crawl.realUrls);
    return corsResponse(jsonResponse(validated, 200));
  } catch (err) {
    return corsResponse(jsonResponse({ error: String(err && err.message ? err.message : err) }, 502));
  }
}

/* ---------------- Crawl real pages ---------------- */

async function crawlSite(siteUrl) {
  const base = new URL(siteUrl);
  const pagesText = [];
  const realUrls = new Set();
  realUrls.add(base.origin + "/");

  const homeRes = await safeFetch(base.origin + "/");
  let homeHtml = "";
  if (homeRes) {
    homeHtml = await homeRes.text();
    pagesText.push({ url: base.origin + "/", text: extractText(homeHtml, MAX_CHARS_PER_PAGE) });
    extractLinks(homeHtml, base.origin).forEach(u => realUrls.add(u));
  }

  const toTry = new Set(CANDIDATE_PATHS.map(p => base.origin + p));
  const interesting = [...realUrls].filter(u =>
    /return|refund|size|shipping|faq|about/i.test(u)
  );
  interesting.forEach(u => toTry.add(u));

  let fetched = 1;
  for (const url of toTry) {
    if (fetched >= MAX_PAGES_TO_FETCH) break;
    if (url === base.origin + "/") continue;
    const res = await safeFetch(url);
    if (res && res.status === 200) {
      const html = await res.text();
      pagesText.push({ url, text: extractText(html, MAX_CHARS_PER_PAGE) });
      realUrls.add(url);
      fetched++;
    }
  }

  return { pagesText, realUrls: [...realUrls] };
}

async function safeFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClarigiDiagnostic/1.0)" },
      redirect: "follow"
    });
    return res;
  } catch (e) {
    return null;
  }
}

function extractText(html, maxChars) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}

function extractLinks(html, origin) {
  const urls = new Set();
  const re = /href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    try {
      const abs = new URL(href, origin).href;
      if (abs.startsWith(origin)) urls.add(abs);
    } catch (e) { /* ignore malformed */ }
  }
  return urls;
}

/* ---------------- Gemini call ---------------- */

async function callGemini(apiKey, siteUrl, crawl) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const prompt = buildPrompt(siteUrl, crawl);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, response_mime_type: "application/json" }
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
      const cleaned = text.replace(/^```json/i, "").replace(/```$/, "").trim();
      return JSON.parse(cleaned);
    }
    if ((res.status === 503 || res.status === 429 || res.status === 500) && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1200 * Math.pow(2, attempt)));
      continue;
    }
    const errText = await res.text();
    throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 300)}`);
  }
  throw new Error("Gemini retries exhausted");
}

function buildPrompt(siteUrl, crawl) {
  const pagesBlock = crawl.pagesText.map(p =>
    `URL: ${p.url}\nCONTENT:\n${p.text}\n---`
  ).join("\n\n");

  const realUrlsList = crawl.realUrls.join("\n");

  return `
You are the analysis engine behind Clarigi's Free External Growth Diagnostic.

Below is REAL content actually fetched from the website ${siteUrl}. Base every finding strictly on this content. Do not invent facts not present here.

REAL PAGE CONTENT:
${pagesBlock}

REAL URLS FOUND ON THIS SITE (only use these, or leave reference_url empty):
${realUrlsList}

Rules:
- Every reference_url you output MUST be copied exactly from the "REAL URLS FOUND" list above, or left as an empty string "".
- Never invent a URL that is not in that list.
- If information isn't present in the fetched content, mark it clearly as "Not observed in fetched content" rather than guessing.
- Follow this reasoning chain for every claim: OBSERVATION -> EVIDENCE -> INTERPRETATION -> BUSINESS IMPLICATION -> UNKNOWN.
- Distinguish clearly between what is directly observed in the content above vs. what is inferred.
- IMPORTANT: You have NOT performed any Google search or external web research. You only have the fetched page content above. For "ai_discovery_check", only comment on what is observable in the on-site content itself (page text, apparent structure) — do NOT claim to know about external mentions, reviews, or search rankings. Explicitly state in "external_footprint_findings" and "what_we_cannot_know" that external research was not performed.

Return ONLY valid JSON (no markdown, no code fences, no commentary outside the JSON), matching EXACTLY this shape and these exact field names — do not rename, add, remove, or restructure any field:

{
  "business": {"name": "", "category": "", "business_model": "", "primary_offer": "", "target_customer": "", "confidence": "HIGH/MEDIUM/LOW"},
  "diagnostic_summary": {"headline": "", "subheadline": "", "priority_area": "", "priority_statement": "", "confidence": "HIGH/MEDIUM/LOW"},
  "auditors": {
    "return_margin_risk": {
      "status": "APPLICABLE or NOT_APPLICABLE",
      "not_applicable_reason": "",
      "level": "LOW/MODERATE/HIGH",
      "confidence": "HIGH/MEDIUM/LOW",
      "headline": "",
      "findings": [
        {"title": "", "severity": "", "what_we_found": "",
         "evidence": [{"observation": "", "location": "", "evidence_type": "DIRECT/TECHNICAL/EXTERNAL/INFERENCE", "confidence": "HIGH/MEDIUM/LOW", "reference_url": "", "reference_label": ""}],
         "why_it_matters": "", "specific_fix": "", "what_we_cannot_know": ""}
      ],
      "priority_finding": "",
      "masked_insight": ""
    },
    "purchase_decision_check": {
      "level": "LOW/MODERATE/HIGH",
      "confidence": "HIGH/MEDIUM/LOW",
      "questions": [
        {"question": "What is this?", "assessment": "CLEAR/PARTLY_CLEAR/UNCLEAR", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
        {"question": "Is this for me?", "assessment": "", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
        {"question": "Why should I choose this?", "assessment": "", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
        {"question": "Can I believe it?", "assessment": "", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
        {"question": "Is it worth the price?", "assessment": "", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
        {"question": "What happens if I don't like it?", "assessment": "", "evidence": "", "gap": "", "specific_fix": "", "reference_url": "", "reference_label": ""}
      ],
      "biggest_friction": {"title": "", "what_customer_sees": "", "what_is_missing": "", "specific_fix": "", "reference_url": "", "reference_label": ""},
      "masked_insight": ""
    },
    "ai_discovery_check": {
      "level": "LOW/MODERATE/STRONG",
      "confidence": "HIGH/MEDIUM/LOW",
      "headline": "",
      "brand_understanding": [{"text": "", "reference_label": "", "reference_url": ""}],
      "product_understanding": [{"text": "", "reference_label": "", "reference_url": ""}],
      "technical_findings": [{"text": "", "reference_label": "", "reference_url": ""}],
      "external_footprint_findings": [{"text": "No external web research was performed for this diagnostic; this section reflects on-site content only.", "reference_label": "Not observed — no external search performed", "reference_url": ""}],
      "specific_fixes": [{"text": "", "reference_label": "", "reference_url": ""}],
      "what_we_cannot_know": "External brand mentions, third-party reviews, and actual AI/search visibility cannot be assessed without live external research; this diagnostic only reviewed the site's own pages.",
      "masked_insight": ""
    }
  },
  "overall": {"most_important_finding": "", "why_it_matters": "", "first_fix": "", "evidence_strength": "", "important_unknown": ""},
  "clarigi_next_step": {
    "headline": "There may be more behind this than the website shows.",
    "body": "",
    "questions_to_validate": [""],
    "cta_text": "Get a free expert growth diagnostic",
    "cta_url": "https://www.clarigi.com/contactus"
  }
}

Fill every field with real content grounded in the fetched page content above. Use empty strings/arrays only where content genuinely isn't observable — never omit, rename, or restructure a field. The "findings", "questions", "brand_understanding", "product_understanding", "technical_findings", "external_footprint_findings", and "specific_fixes" fields must always be arrays, even if they contain only one item.
`.trim();
}

/* ---------------- Validate references ---------------- */

function validateReferenceUrls(reportJson, realUrls) {
  const realSet = new Set(realUrls);

  function cleanRef(obj) {
    if (obj && typeof obj === "object" && "reference_url" in obj) {
      if (obj.reference_url && !realSet.has(obj.reference_url)) {
        obj.reference_url = "";
        obj.reference_label = (obj.reference_label || "") + " (unverified — link removed)";
      }
    }
  }

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      cleanRef(node);
      Object.values(node).forEach(walk);
    }
  }

  walk(reportJson);
  return reportJson;
}

/* ---------------- Helpers ---------------- */

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function corsResponse(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers });
}
