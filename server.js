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

    let prompt = `You are extracting line items from a supplier quotation / PFI (proforma invoice). It may contain anywhere from 1 to 30+ line items — extract EVERY item, do not stop early or summarize. For each item give: description, materialCode (empty string if none visible), supplier (empty string if not stated in this text), currency (3-letter code guessed from symbols/context, empty string if unclear), and price (the UNIT price, not line total or quantity — compute unit price = total / quantity if only a total is shown). Never invent a supplier name if one is not present in the text.`;
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
    const out = geminiText(data).trim();
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
    const [priceResults, supplierResults] = await Promise.all([
      tavilySearch(`${itemLabel} price buy`, 4),
      tavilySearch(`${itemLabel} supplier manufacturer`, 4)
    ]);

    const formatResults = (label, results) => {
      if (!results.length) return `${label}: no results.`;
      return `${label}:\n` + results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.content}`).join('\n');
    };

    const prompt = `You are summarizing real web search results for a procurement item: "${itemLabel}". This may be an industrial/chemical/engineering component where B2B unit pricing is rarely public — only report a price if the search results actually contain one, never estimate or fabricate.

${formatResults('PRICING SEARCH RESULTS', priceResults)}

${formatResults('SUPPLIER SEARCH RESULTS', supplierResults)}

Based ONLY on the results above (do not use outside knowledge), respond in plain text, under 220 words, structured exactly as:
ESTIMATE: <price/range with currency and source, drawn only from the results above, OR "No reliable public pricing found for this item.">
SOURCES: up to 3 lines "<source name> — <finding> — <URL>" drawn from the pricing results
ALT SUPPLIERS: up to 3 lines "<company name> — <website> — <contact if visible in the results, else 'not publicly listed'>" drawn from the supplier results, OR "No alternate suppliers found via web search — check internal SAP history instead."
Be honest about weak or missing evidence rather than guessing.`;

    const data = await callGemini({ prompt, maxOutputTokens: 800 });
    const text_out = geminiText(data).trim();
    res.json({ result: text_out || 'No response returned.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, geminiKeyConfigured: !!GEMINI_API_KEY, tavilyKeyConfigured: !!TAVILY_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quotation Price Analyzer running on port ${PORT}`));
