require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. AI features (extraction, market search) will fail until it is.');
}

async function callGemini({ prompt, tools, responseSchema, maxOutputTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
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
    throw new Error(`Gemini API error ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
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

    const prompt = `Search the web for two things about this procurement item: "${text}"${materialCode ? ` (reference code ${materialCode})` : ''}.
1) Current market pricing — this may be an industrial/chemical/engineering component where B2B unit pricing is rarely published; do not fabricate a number if you cannot find one.
2) Alternate suppliers who plausibly sell this item — real, findable companies only, never invented ones.
Respond in plain text, under 220 words, structured exactly as:
ESTIMATE: <price/range with currency and source, OR "No reliable public pricing found for this item.">
SOURCES: up to 3 lines "<source name> — <finding> — <URL>"
ALT SUPPLIERS: up to 3 lines "<company name> — <website if found> — <contact/phone/email if publicly listed, else 'not publicly listed'>", OR "No alternate suppliers found via web search — check internal SAP history instead."
Be honest about weak or missing evidence rather than guessing.`;

    const data = await callGemini({
      prompt,
      tools: [{ google_search: {} }],
      maxOutputTokens: 1500
    });
    const text_out = geminiText(data).trim();
    res.json({ result: text_out || 'No response returned.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, keyConfigured: !!GEMINI_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quotation Price Analyzer running on port ${PORT}`));
