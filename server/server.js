// server/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// node-fetch v3 ist ESM-only -> dynamisch importieren
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json());

// -------------------- Persistente User-Vokabeln --------------------
const DATA_DIR = path.join(__dirname, 'data');
const USER_VOCAB = path.join(DATA_DIR, 'user_additions.txt');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USER_VOCAB)) fs.writeFileSync(USER_VOCAB, '', 'utf8');

// alle User-Vokabeln als Map zurückgeben
app.get('/api/vocab/user', (req, res) => {
  try {
    const txt = fs.readFileSync(USER_VOCAB, 'utf8');
    const map = Object.create(null);
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const m = line.match(/^([^#]+?)#(.*)$/);
      if (!m) continue;
      const eng = m[1].trim().toLowerCase();
      const ger = m[2].trim();
      if (!eng || !ger) continue;
      (map[eng] ||= []).includes(ger) || map[eng].push(ger);
    }
    res.json({ ok: true, vocab: map });
  } catch (e) {
    console.error('user vocab read failed', e);
    res.status(500).json({ ok: false });
  }
});

// einzelne User-Vokabel hinzufügen (append)
app.post('/api/vocab/add', (req, res) => {
  try {
    const { eng, ger } = req.body || {};
    const e = String(eng || '').trim().toLowerCase();
    const g = String(ger || '').trim();
    if (!e || !g) return res.status(400).json({ ok: false, error: 'missing eng/ger' });

    const line = `${e}#${g}`;
    const current = fs.readFileSync(USER_VOCAB, 'utf8');
    if (!current.split(/\r?\n/).some(l => l.trim() === line)) {
      fs.appendFileSync(USER_VOCAB, line + '\n', 'utf8');
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('user vocab add failed', e);
    res.status(500).json({ ok: false });
  }
});

// -------------------- DeepL Proxys --------------------
app.get('/health', (req, res) => res.send('ok'));

app.post('/api/translate', async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    // prompt sehr knapp halten
    const text =
      `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). ` +
      `Phrase: "${phraseText}". Kontext: "${contextText}"`;

    const params = new URLSearchParams({ auth_key: key, text, target_lang: 'DE' });
    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    res.json({ translatedText: data?.translations?.[0]?.text || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'translate failed' });
  }
});

app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
    if (!key) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    const params = new URLSearchParams({ auth_key: key, text: fullText || '', target_lang: 'DE' });
    const r = await fetch(url, { method: 'POST', body: params });
    const data = await r.json();
    res.json({ translatedText: data?.translations?.[0]?.text || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fulltext failed' });
  }
});

// -------------------- React-Frontend ausliefern --------------------
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (req, res) => res.sendFile(path.join(clientBuildPath, 'index.html')));

// -------------------- Start --------------------
app.listen(PORT, () => console.log('Server listening on', PORT));
