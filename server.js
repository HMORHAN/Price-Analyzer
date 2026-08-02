require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. AI features (extraction, market search) will fail until it is.');
}

async function callClaude(messages, tools, maxTokens) {
  const body = { model: 'claude-sonnet-4-6', max_tokens: maxTokens || 1000, messages };
  if (tools) body.tools = tools;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
}

function claudeText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Extract structured line items (material, supplier, unit price) from pasted/PDF quotation text
app.post('/api/extract', async (req, res) => {
  try {
    const { text, hint } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });

    let prompt = `You are extracting line items from a supplier quotation / PFI (proforma invoice). It may contain anywhere from 1 to 30+ line items — extract EVERY item, do not stop early or summarize. Return ONLY a JSON array — no markdown fences, no explanation, no extra text before or after. Each element must have exactly these keys: "description" (string), "materialCode" (string, "" if none visible), "supplier" (string, "" if not stated in this text), "currency" (3-letter code guessed from symbols/context, default ""), "price" (number — the UNIT price, not line total or quantity — compute unit price = total / quantity if only a total is shown). Never invent a supplier name if one is not present in the text.`;
    if (hint && hint.trim()) prompt += `\n\nLayout guidance from the user on where to find fields in this specific document: ${hint.trim()}`;
    prompt += `\n\nText:\n${text}`;

    const data = await callClaude([{ role: 'user', content: prompt }], null, 4096);
    let out = claudeText(data).trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('No items found in response.');
    res.json({ items: parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live market price + alternate supplier search for a single item
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

    const data = await callClaude(
      [{ role: 'user', content: prompt }],
      [{ type: 'web_search_20250305', name: 'web_search' }],
      1500
    );
    res.json({ result: claudeText(data).trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, keyConfigured: !!ANTHROPIC_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quotation Price Analyzer running on port ${PORT}`));
