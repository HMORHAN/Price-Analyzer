require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
// Try the primary model; if it's been retired (404), automatically fall back to the next one.
const MODEL_CANDIDATES = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. AI features (extraction, market search) will fail until it is.');
}
if (!TAVILY_API_KEY) {
  console.warn('WARNING: TAVILY_API_KEY is not set. Live market search will fail until it is.');
}

async function tavilySearch(query, maxResults) {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: maxResults || 4
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Tavily API error ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  return (data.results || []).map(r => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 500) }));
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

async function callGemini(args) {
  let lastErr;
  for (const model of MODEL_CANDIDATES) {
    try {
      return await callGeminiOnce(model, args);
    } catch (e) {
      lastErr = e;
      if (e.status === 404) continue; // this model is retired/unavailable, try the next one
      throw e; // any other error (bad key, quota, etc.) — no point trying other models
    }
  }
  throw lastErr;
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

    const data = await callGemini({ prompt, responseSchema: schema, maxOutputTokens: 4096 });
    const candidate = (data.candidates || [])[0];
    let out = geminiText(data).trim();
    if (candidate && candidate.finishReason === 'MAX_TOKENS') {
      // Ran out of room (very large quotation) — retry once with a bigger budget instead of returning broken JSON.
      const retryData = await callGemini({ prompt, responseSchema: schema, maxOutputTokens: 8192 });
      out = geminiText(retryData).trim();
    }
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('No items found in response.');
    res.json({ items: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live market price + alternate supplier search for a single item (Google Search grounding)
app.post('/api/market-check', async (req, res) => {
  try {
    const { text, materialCode } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No item text provided.' });
    if (!TAVILY_API_KEY) return res.status(500).json({ error: 'TAVILY_API_KEY is not set on the server.' });

    const itemLabel = materialCode ? `${text} (reference code ${materialCode})` : text;
    const [priceResults, manufacturerResults, traderResults, hsResults] = await Promise.all([
      tavilySearch(`${itemLabel} price buy`, 5),
      tavilySearch(`${itemLabel} manufacturer official brand`, 5),
      tavilySearch(`${itemLabel} distributor dealer supplier`, 5),
      tavilySearch(`${itemLabel} HS code Pakistan customs PCT`, 5)
    ]);

    const formatResults = (label, results) => {
      if (!results.length) return `${label}: no results.`;
      return `${label}:\n` + results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.content}`).join('\n');
    };

    const prompt = `You are a procurement analyst reviewing real web search results for this item: "${itemLabel}". This may be an industrial/chemical/engineering component or a branded product (e.g. a chemical formulation sold under a manufacturer's brand name).

${formatResults('PRICING SEARCH RESULTS', priceResults)}

${formatResults('MANUFACTURER/BRAND SEARCH RESULTS', manufacturerResults)}

${formatResults('DISTRIBUTOR/TRADER SEARCH RESULTS', traderResults)}

${formatResults('HS CODE SEARCH RESULTS', hsResults)}

Using ONLY the results above (never outside knowledge, never fabricate a number or a company):
1) List every distinct source that states or implies an actual price for this item or a close match. If a result has no discoverable price, skip it — do not include it with a null price just to pad the list.
2) List every distinct company across ALL the search results above that appears to sell, stock, distribute, or manufacture this item. For each one, classify "type" as exactly one of: "manufacturer" (the actual brand owner / original maker of this item — e.g. if the item is a branded product like a named chemical formulation, the company that owns that brand), "distributor" (an authorized regional distributor/dealer), or "trader" (a general reseller/trading company with no stated manufacturer or distributor relationship). Note their region/country and stock availability ONLY if the result actually says so. Prioritize finding the actual manufacturer if the item name suggests a branded product — a manufacturer entry is more valuable to a buyer than a generic trader and should not be omitted in favor of traders if the manufacturer is identifiable from the results.
3) From the HS CODE SEARCH RESULTS only, list any Pakistan Customs HS/PCT code(s) mentioned for this item or its general product category (e.g. "3402.20", "8-digit PCT code"). If the results give a code for a close category rather than this exact item, include it but say so in the note. If no HS code appears anywhere in the results, return an empty list — do not guess or infer a code from general HS knowledge not present in the results.`;

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
              availability: { type: 'STRING' }
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

    const data = await callGemini({ prompt, responseSchema: schema, maxOutputTokens: 4096 });
    const candidate = (data.candidates || [])[0];
    let rawOut = geminiText(data).trim();
    if (candidate && candidate.finishReason === 'MAX_TOKENS') {
      // Still ran out of room even at 4096 — retry once with a bigger budget rather than surfacing a parse error.
      const retryData = await callGemini({ prompt, responseSchema: schema, maxOutputTokens: 8192 });
      rawOut = geminiText(retryData).trim();
    }
    const parsed = JSON.parse(rawOut);
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

    res.json({ priceFindings, altSuppliers, average, hsCodeFindings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, geminiKeyConfigured: !!GEMINI_API_KEY, tavilyKeyConfigured: !!TAVILY_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quotation Price Analyzer running on port ${PORT}`));
