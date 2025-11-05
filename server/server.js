// server/server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

// node-fetch als ESM dynamisch laden (funktioniert in CJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: in Render gleiche Origin, lokal ggf. http://localhost:5173
app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json());

// Health
app.get('/health', (_req, res) => res.send('ok'));

/**
 * EIN-WORT-ÜBERSETZUNG
 * Erwartet: { phraseText: string }
 * Antwort:  { translatedText: string }
 */
app.post('/api/translate', async (req, res) => {
  try {
    const { phraseText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';

    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });
    const text = (phraseText || '').toString().trim();
    if (!text) return res.json({ translatedText: '' });

    const params = new URLSearchParams();
    params.set('auth_key', key);
    params.set('text', text);           // <-- nur das Wort!
    params.set('target_lang', 'DE');
    params.set('source_lang', 'EN');    // <-- Quelle ist Englisch
    params.set('split_sentences', '0'); // nicht zerschneiden
    params.set('preserve_formatting', '1');

    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    const out = data?.translations?.[0]?.text || '';

    return res.json({ translatedText: out });
  } catch (e) {
    console.error('translate error:', e);
    return res.status(500).json({ error: 'translate failed' });
  }
});

/**
 * VOLLTEXT-ÜBERSETZUNG (für Kontextanzeige)
 * Erwartet: { fullText: string }
 * Antwort:  { translatedText: string }
 */
app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';

    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    const params = new URLSearchParams();
    params.set('auth_key', key);
    params.set('text', (fullText || '').toString());
    params.set('target_lang', 'DE');
    params.set('source_lang', 'EN');
    params.set('preserve_formatting', '1');

    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    const out = data?.translations?.[0]?.text || '';

    return res.json({ translatedText: out });
  } catch (e) {
    console.error('fulltext error:', e);
    return res.status(500).json({ error: 'fulltext failed' });
  }
});

// ---- React-Frontend ausliefern ----
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// SPA-Fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

app.listen(PORT, () => console.log('Server listening on', PORT));
