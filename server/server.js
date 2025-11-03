// server/server.js  (CommonJS)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// node-fetch in CommonJS laden
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json());

// --- Healthcheck ---
app.get('/health', (req, res) => res.send('ok'));

// --- DeepL: wortwörtliche Einzel-/Phrasen-Übersetzung ---
app.post('/api/translate', async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';

    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    // kurzer, restriktiver Prompt für 1:1-Vorschlag
    const text = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText}". Kontext: "${contextText}"`;

    const params = new URLSearchParams({
      auth_key: key,
      text,
      target_lang: 'DE',
    });

    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    return res.json({ translatedText: data?.translations?.[0]?.text || '' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'translate failed' });
  }
});

// --- DeepL: Volltext (Kontext zum Lesen) ---
app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';

    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    const params = new URLSearchParams({
      auth_key: key,
      text: fullText || '',
      target_lang: 'DE',
    });

    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    return res.json({ translatedText: data?.translations?.[0]?.text || '' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'fulltext failed' });
  }
});

// --- React-Frontend ausliefern (nach den API-Routen!) ---
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// SPA-Fallback: alle unbekannten Routen -> index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
