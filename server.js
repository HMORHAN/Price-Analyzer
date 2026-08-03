require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------------- access control: shared password + optional license expiry ----------------
const APP_PASSWORD = process.env.APP_PASSWORD;               // set to require a password; unset = open access
const APP_EXPIRY = process.env.APP_EXPIRY;                   // optional, e.g. "2027-06-30" — access blocked after this date
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'); // set your own in production so sessions survive restarts
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(value) {
  const h = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}
function verifyToken(token) {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const value = token.slice(0, idx), sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  try {
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  const expiryTs = Number(value);
  if (!expiryTs || Date.now() > expiryTs) return null;
  return true;
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function isLicenseExpired() {
  if (!APP_EXPIRY) return false;
  return new Date() > new Date(APP_EXPIRY + 'T23:59:59');
}

// License expiry check — applies even to the login page itself.
app.use((req, res, next) => {
  if (!isLicenseExpired()) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: "This tool's access period has expired. Contact the administrator to renew." });
  res.status(403).send(`<html><body style="font-family:sans-serif;background:#15171B;color:#E7E8EA;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;"><div><h2>Access expired</h2><p>This tool's license period has ended.<br>Contact the administrator to renew access.</p></div></body></html>`);
});

app.post('/login', (req, res) => {
  if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD is not configured on the server.' });
  const { password } = req.body || {};
  if (password !== APP_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  const token = sign(String(Date.now() + SESSION_DURATION_MS));
  res.setHeader('Set-Cookie', `auth=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}; SameSite=Lax`);
  res.json({ ok: true });
});
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Auth gate — everything below this needs a valid session unless APP_PASSWORD is unset (open/dev mode).
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next(); // no password configured — app stays open
  if (req.path === '/login' || req.path === '/login.html' || req.path === '/logout') return next();
  const cookies = parseCookies(req);
  if (verifyToken(cookies.auth)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in. Please log in again.' });
  return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY; // optional — used as a fallback when Gemini's daily/per-minute limit is hit
// Try the primary model; if it's been retired (404), automatically fall back to the next one.
const MODEL_CANDIDATES = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. AI features (extraction, market search) will fail until it is.');
}
if (!TAVILY_API_KEY) {
  console.warn('WARNING: TAVILY_API_KEY is not set. Live market search will fail until it is.');
}
if (!GROQ_API_KEY) {
  console.warn('NOTE: GROQ_API_KEY is not set — no fallback provider if Gemini hits its rate limit. Optional but recommended.');
}

async function tavilySearch(query, maxResults, depth) {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: depth || 'basic',
      max_results: maxResults || 4
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Tavily API error ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  return (data.results || []).map(r => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 800) }));
}

async function callGeminiOnce(model, { prompt, tools, responseSchema, maxOutputTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxOutputTokens || 2048 }
  };
  if (responseSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = responseSchema;
  }
  if (tools) body.tools = tools;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error(`Gemini API error ${resp.status}: ${t.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function friendlyErrorMessage(e) {
  if (e.status === 429) {
    return 'Rate limit reached on the free Gemini tier (shared across everyone using this tool today). This usually clears within a minute — try again shortly. If it keeps happening throughout the day, the daily free quota is exhausted and won\'t reset until midnight Pacific Time; ask your admin about enabling billing for higher limits.';
  }
  if (e.status === 503) {
    return 'Gemini is temporarily overloaded on Google\'s side (not a quota issue). This should clear within a minute — try again shortly.';
  }
  return e.message;
}

async function callGemini(args) {
  let lastErr;
  for (const model of MODEL_CANDIDATES) {
    // Try this model, with one short-wait retry if we get rate-limited (429) or the model is
    // transiently overloaded (503) — both are usually short-lived, and a brief pause often clears them.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callGeminiOnce(model, args);
      } catch (e) {
        lastErr = e;
        if ((e.status === 429 || e.status === 503) && attempt === 0) { await sleep(4000); continue; }
        if (e.status === 404) break; // this model is retired/unavailable, try the next one in the outer loop
        throw e; // any other error (bad key, still failing after retry, etc.) — no point trying more
      }
    }
  }
  throw lastErr;
}

// Groq — separate free-tier quota from Google's, used only as a fallback when Gemini is rate-limited.
// Groq has no schema-enforcement param, so the caller must describe the expected JSON shape in the prompt text.
async function callGroq(promptWithJsonInstructions, maxOutputTokens) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: promptWithJsonInstructions }],
      response_format: { type: 'json_object' },
      max_tokens: maxOutputTokens || 2048
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error(`Groq API error ${resp.status}: ${t.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  return text || '';
}

// Top-level dispatcher: try Gemini (schema-enforced, better quality); if it's rate-limited and Groq
// is configured, fall back to Groq (separate quota, needs the JSON shape spelled out in the prompt text).
async function callAIStructured({ geminiPrompt, groqPrompt, responseSchema, maxOutputTokens }) {
  try {
    const data = await callGemini({ prompt: geminiPrompt, responseSchema, maxOutputTokens });
    const candidate = (data.candidates || [])[0];
    let rawOut = geminiText(data).trim();
    if (candidate && candidate.finishReason === 'MAX_TOKENS') {
      const retryData = await callGemini({ prompt: geminiPrompt, responseSchema, maxOutputTokens: (maxOutputTokens || 2048) * 2 });
      rawOut = geminiText(retryData).trim();
    }
    return { raw: rawOut, provider: 'gemini' };
  } catch (e) {
    if ((e.status === 429 || e.status === 503) && GROQ_API_KEY) {
      const raw = await callGroq(groqPrompt, maxOutputTokens);
      return { raw, provider: 'groq' };
    }
    throw e;
  }
}

function geminiText(data) {
  const candidate = (data.candidates || [])[0];
  if (!candidate || !candidate.content || !candidate.content.parts) return '';
  return candidate.content.parts.map(p => p.text || '').join('\n');
}

// Extract structured line items (material, supplier, unit price) from pasted/PDF quotation text
app.post('/api/extract', async (req, res) => {
  try {
    const { text, hint } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });

    let prompt = `You are an experienced procurement specialist reading a supplier quotation / PFI (proforma invoice) to build a clean line-item register. Documents like this mix real line items with letterhead, bank details, payment terms, and boilerplate — your job is to find only the actual item rows in the pricing table and ignore everything else.

For each real line item extract:
- description: the actual material/item name as a procurement specialist would record it (skip generic table labels like "Description" itself; if the item has a part/spec number inline, keep it as part of the description).
- materialCode: a distinct reference/part number if one is shown separately from the description ("" if none).
- supplier: only if this specific document states who is quoting/selling ("" if not stated — never guess or reuse a name from elsewhere).
- currency: 3-letter code inferred from symbols or context ("" if genuinely unclear).
- price: the UNIT price specifically, not the line total. If only quantity and line total are shown, compute unit price = total ÷ quantity. If a document shows multiple price columns (e.g. list price vs net price), prefer the net/final price a buyer would actually pay.

It may contain anywhere from 1 to 30+ line items — extract EVERY genuine item row, do not stop early, do not summarize, and do not include header/footer/terms text as if it were an item.`;
    if (hint && hint.trim()) prompt += `\n\nLayout guidance from the user on where to find fields in this specific document: ${hint.trim()}`;
    prompt += `\n\nText:\n${text}`;

    const schema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          materialCode: { type: 'STRING' },
          supplier: { type: 'STRING' },
          currency: { type: 'STRING' },
          price: { type: 'NUMBER' }
        },
        required: ['description', 'price']
      }
    };
    const groqPrompt = prompt + `\n\nRespond with ONLY a JSON object of the exact shape {"items": [ {"description": string, "materialCode": string, "supplier": string, "currency": string, "price": number}, ... ]} — no markdown, no explanation, valid JSON only.`;

    const { raw, provider } = await callAIStructured({ geminiPrompt: prompt, groqPrompt, responseSchema: schema, maxOutputTokens: 4096 });
    const parsedRaw = JSON.parse(raw);
    const parsed = provider === 'groq' ? (parsedRaw.items || []) : parsedRaw;
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('No items found in response.');
    res.json({ items: parsed, provider });
  } catch (e) {
    res.status(e.status===429?429:500).json({ error: friendlyErrorMessage(e) });
  }
});

// Live market price + alternate supplier search for a single item (Google Search grounding)
app.post('/api/market-check', async (req, res) => {
  try {
    const { text, materialCode } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No item text provided.' });
    if (!TAVILY_API_KEY) return res.status(500).json({ error: 'TAVILY_API_KEY is not set on the server.' });

    const itemLabel = materialCode ? `${text} (reference code ${materialCode})` : text;
    const [priceResults, manufacturerResults, traderResults, hsResults, contactResults] = await Promise.all([
      tavilySearch(`${itemLabel} price buy`, 5),
      tavilySearch(`${itemLabel} manufacturer official brand`, 5, 'advanced'),
      tavilySearch(`${itemLabel} distributor dealer supplier`, 5, 'advanced'),
      tavilySearch(`${itemLabel} HS code Pakistan customs tariff PCT 2026-27`, 5),
      tavilySearch(`${itemLabel} supplier contact email sales inquiries`, 5, 'advanced')
    ]);

    const formatResults = (label, results) => {
      if (!results.length) return `${label}: no results.`;
      return `${label}:\n` + results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.content}`).join('\n');
    };

    const prompt = `You are an experienced industrial procurement analyst reviewing real web search results for this item: "${itemLabel}".

Before drawing conclusions, decide what kind of item this is, because it changes how you should interpret the results: (a) BRANDED PRODUCT — a named formulation/model owned by one company, where you should identify the actual brand-owning manufacturer, not just resellers; (b) GENERIC/CUSTOM PART — a descriptive category term with no single brand owner, where you should not invent a manufacturer and should honestly label suppliers as traders/fabricators; (c) RAW MATERIAL/COMMODITY — a bulk material traded by many producers, where known producers count as manufacturers.

${formatResults('PRICING SEARCH RESULTS', priceResults)}

${formatResults('MANUFACTURER/BRAND SEARCH RESULTS', manufacturerResults)}

${formatResults('DISTRIBUTOR/TRADER SEARCH RESULTS', traderResults)}

${formatResults('HS CODE SEARCH RESULTS', hsResults)}

${formatResults('SUPPLIER CONTACT/EMAIL SEARCH RESULTS', contactResults)}

Using ONLY the results above (never outside knowledge, never fabricate a number or a company):
1) List every distinct source that states or implies an actual price for this item or a close match. If a result has no discoverable price, skip it — do not include it with a null price just to pad the list.
2) List every distinct company across ALL the search results above that appears to sell, stock, distribute, or manufacture this item. For each one, classify "type" as exactly one of: "manufacturer" (the actual brand owner / original maker of this item — e.g. if the item is a branded product like a named chemical formulation, the company that owns that brand), "distributor" (an authorized regional distributor/dealer), or "trader" (a general reseller/trading company with no stated manufacturer or distributor relationship). Note their region/country and stock availability ONLY if the result actually says so. For "email", actively scan the content of ALL result sets above (especially the MANUFACTURER/BRAND, DISTRIBUTOR/TRADER, and SUPPLIER CONTACT/EMAIL result sets) for a real sales/info/contact email address belonging to that specific company — company "Contact Us" and "About" pages often list one (e.g. "sales@company.com", "info@company.com"). Only use an email that is literally present in the text of a result; leave it blank if none is found — never guess, construct, or infer an email from a company name or domain (e.g. never fabricate "info@companyname.com" just because that's a common pattern). Prioritize finding the actual manufacturer if the item name suggests a branded product — a manufacturer entry is more valuable to a buyer than a generic trader and should not be omitted in favor of traders if the manufacturer is identifiable from the results.
3) From the HS CODE SEARCH RESULTS only, list any Pakistan Customs HS/PCT code(s) mentioned for this item or its general product category. Pakistan's current tariff schedule is PCT 2026-27 (the fiscal year running July 2026–June 2027) — prefer a result stating that edition; if a result is clearly from an older edition (e.g. mentions 2023-24, 2024-25, 2025-26), still include it but say the edition/year explicitly in the note field so the user knows to double-check it.
CRITICAL SANITY CHECK before including any code: Pakistan's HS/PCT chapters are broad product categories (e.g. Chapter 28-29 = chemicals, Chapter 39 = plastics, Chapter 72-73 = iron/steel, Chapter 84-85 = machinery/electrical, Chapter 50-63 = textiles). The chapter (first 2 digits of the code) MUST plausibly match what "${itemLabel}" actually is. If a search result's HS code belongs to a completely unrelated chapter (for example a steel-chapter code for a chemical product, or a textile-chapter code for a machine part), DO NOT include it — that is very likely a mismatched or irrelevant search result, not a real classification for this item. Only include codes whose product category is consistent with the item. If no chapter-consistent code appears anywhere in the results, return an empty list rather than including a mismatched one — do not guess or infer a code from general HS knowledge not present in the results.`;

    const schema = {
      type: 'OBJECT',
      properties: {
        priceFindings: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              source: { type: 'STRING' },
              url: { type: 'STRING' },
              price: { type: 'NUMBER' },
              currency: { type: 'STRING' },
              note: { type: 'STRING' }
            },
            required: ['source', 'url', 'price', 'currency']
          }
        },
        altSuppliers: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              company: { type: 'STRING' },
              website: { type: 'STRING' },
              type: { type: 'STRING' },
              region: { type: 'STRING' },
              availability: { type: 'STRING' },
              email: { type: 'STRING' }
            },
            required: ['company', 'website', 'type']
          }
        },
        hsCodeFindings: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              code: { type: 'STRING' },
              description: { type: 'STRING' },
              source: { type: 'STRING' },
              url: { type: 'STRING' },
              note: { type: 'STRING' }
            },
            required: ['code', 'source', 'url']
          }
        }
      },
      required: ['priceFindings', 'altSuppliers', 'hsCodeFindings']
    };

    const groqPrompt = prompt + `\n\nRespond with ONLY a JSON object of this exact shape — no markdown, no explanation, valid JSON only:
{"priceFindings": [{"source": string, "url": string, "price": number, "currency": string, "note": string}], "altSuppliers": [{"company": string, "website": string, "type": string, "region": string, "availability": string, "email": string}], "hsCodeFindings": [{"code": string, "description": string, "source": string, "url": string, "note": string}]}`;

    const { raw, provider } = await callAIStructured({ geminiPrompt: prompt, groqPrompt, responseSchema: schema, maxOutputTokens: 4096 });
    const parsed = JSON.parse(raw);
    const priceFindings = Array.isArray(parsed.priceFindings) ? parsed.priceFindings : [];
    const hsCodeFindings = Array.isArray(parsed.hsCodeFindings) ? parsed.hsCodeFindings : [];
    const TYPE_ORDER = { manufacturer: 0, distributor: 1, trader: 2 };
    const altSuppliers = (Array.isArray(parsed.altSuppliers) ? parsed.altSuppliers : [])
      .sort((a, b) => (TYPE_ORDER[(a.type || '').toLowerCase()] ?? 3) - (TYPE_ORDER[(b.type || '').toLowerCase()] ?? 3));

    // Compute a simple average across whichever currency has the most findings — never mix currencies into one number.
    let average = null;
    const byCurrency = {};
    priceFindings.forEach(p => {
      if (typeof p.price === 'number' && p.currency) {
        (byCurrency[p.currency] = byCurrency[p.currency] || []).push(p.price);
      }
    });
    const currencies = Object.keys(byCurrency).sort((a, b) => byCurrency[b].length - byCurrency[a].length);
    if (currencies.length) {
      const top = currencies[0];
      const vals = byCurrency[top];
      average = { value: vals.reduce((a, b) => a + b, 0) / vals.length, currency: top, count: vals.length };
    }

    res.json({ priceFindings, altSuppliers, average, hsCodeFindings, provider });
  } catch (e) {
    res.status(e.status===429?429:500).json({ error: friendlyErrorMessage(e) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, geminiKeyConfigured: !!GEMINI_API_KEY, tavilyKeyConfigured: !!TAVILY_API_KEY, groqKeyConfigured: !!GROQ_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quotation Price Analyzer running on port ${PORT}`));
