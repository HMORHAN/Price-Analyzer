# Quotation Price Analyzer — hosted version

A small Node/Express server holds your Anthropic API key and proxies two
AI features so any manager with the URL can use them from a plain browser —
no Claude account needed on their end.

## What runs where
- **Frontend** (`public/index.html`) — SAP history upload, item entry, price
  analysis, extraction review, market-check UI. Runs entirely in the browser.
- **Backend** (`server.js`) — the only thing that talks to Anthropic. Holds
  `ANTHROPIC_API_KEY` server-side; the browser never sees it.
- **SAP purchase history** — stored in each user's own browser (`localStorage`),
  never uploaded to the server. Only the text of a quotation item (description
  + material code) is sent server-side when you use extraction or market-check.

## 1. Get an Anthropic API key
Console: https://console.claude.com — create a key, add a payment method.
Pay-as-you-go, billed per token used (see prior chat for current rates).

## 2. Run it locally first (recommended before deploying)
```bash
cd analyzer-app
npm install
cp .env.example .env
# edit .env and paste your real key into ANTHROPIC_API_KEY
npm start
```
Open http://localhost:3000 — upload your SAP export, add a quotation item,
try "Extract items with AI" and "Search live market price".

## 3. Deploy to your cloud account
Any Node-hosting platform works (Render, Railway, Fly.io, a plain VPS, Azure
App Service, etc.) — the app is a standard Express server with no special
requirements beyond Node 18+.

General steps, same on most platforms:
1. Push this folder to a Git repository (GitHub/GitLab).
2. Create a new "Web Service" (or equivalent) on your host, pointed at that repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Set the environment variable `ANTHROPIC_API_KEY` in the host's dashboard
   (never commit your real key to Git — `.env` is already git-ignored).
5. Deploy. The platform gives you a public URL — share that with your managers.

## Cost & access notes
- Every manager's extraction/market-check call bills to your one API key.
  Keep an eye on usage in the Anthropic Console if the group grows.
- You chose open access (no login) — anyone with the URL can use the AI
  features on your account's dime. If usage or exposure becomes a concern
  later, adding a simple shared password gate is a small follow-up change,
  not a rebuild.
