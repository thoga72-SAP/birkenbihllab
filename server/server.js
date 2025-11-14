require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Pool } = require('pg');

// ---------- DB ----------
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render PG
    })
  : null;

// ---------- App ----------
const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || '*',
  })
);
app.use(express.json());

// Health
app.get('/health', (_, res) => res.send('ok'));

// ---------- DeepL helpers ----------
const DEEPL_URL = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
const DEEPL_KEY = process.env.DEEPL_KEY || '';

async function deeplTranslate(text, opts = {}) {
  if (!DEEPL_KEY) throw new Error('DEEPL_KEY missing');
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    target_lang: 'DE',
    ...opts, // e.g. { formality: 'more' }
  });
  const r = await fetch(DEEPL_URL, { method: 'POST', body: params });
  const j = await r.json();
  return j;
}

// ---------- DeepL API ----------
app.post('/api/translate', async (req, res) => {
  try {
    const phraseText = (req.body?.phraseText || '').toString();

    const j = await deeplTranslate(phraseText);
    const out = j?.translations?.[0]?.text || '';
    res.json({ translatedText: out });
  } catch (e) {
    console.error('/api/translate error:', e);
    res.status(500).json({ error: 'translate failed' });
  }
});

app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const fullText = (req.body?.fullText || '').toString();
    const j = await deeplTranslate(fullText);
    const out = j?.translations?.[0]?.text || '';
    res.json({ translatedText: out });
  } catch (e) {
    console.error('/api/translate/fulltext error:', e);
    res.status(500).json({ error: 'fulltext failed' });
  }
});

// ---------- Vocab API ----------
// Tabelle: vocab(eng text, ger text, priority int, cnt int)
// PRIMARY KEY (eng, ger)
//   ALTER TABLE public.vocab ADD CONSTRAINT vocab_pk PRIMARY KEY (eng, ger);

// Upsert + Priorität hochzählen
app.post('/api/vocab/save', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });

    let { eng, ger, delta } = req.body || {};
    eng = (eng || '').toString().trim().toLowerCase();
    ger = (ger || '').toString().trim();
    const d = Number.isFinite(+delta) ? Math.max(0, +delta) : 1;

    if (!eng || !ger) return res.status(400).json({ error: 'eng/ger required' });

    const sql = `
      INSERT INTO vocab(eng, ger, priority, cnt)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (eng, ger)
      DO UPDATE SET
        priority = vocab.priority + EXCLUDED.priority,
        cnt      = vocab.cnt + 1
      RETURNING eng, ger, priority, cnt
    `;
    const { rows } = await pool.query(sql, [eng, ger, d]);
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    console.error('/api/vocab/save error:', e);
    res.status(500).json({ error: 'save failed', detail: e.message });
  }
});

// Sortierte Optionen zu einem ENG-Wort
app.get('/api/vocab/options', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const eng = (req.query.eng || '').toString().trim().toLowerCase();
    if (!eng) return res.status(400).json({ error: 'eng required' });

    const sql = `
      SELECT ger, priority, cnt
      FROM vocab
      WHERE eng = $1
      ORDER BY priority DESC, cnt DESC, LOWER(ger) ASC
      LIMIT 100
    `;
    const { rows } = await pool.query(sql, [eng]);
    res.json({ options: rows });
  } catch (e) {
    console.error('/api/vocab/options error:', e);
    res.status(500).json({ error: 'options failed' });
  }
});

// ---------- /api/vocab/suggest (gleich wie /options) ----------
app.get('/api/vocab/suggest', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const eng = (req.query.eng || '').toString().trim().toLowerCase();
    if (!eng) return res.status(400).json({ error: 'eng required' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const sql = `
      SELECT ger, priority, cnt
      FROM vocab
      WHERE eng = $1
      ORDER BY priority DESC, cnt DESC, LOWER(ger) ASC
      LIMIT $2
    `;
    const { rows } = await pool.query(sql, [eng, limit]);
    res.json({ options: rows });
  } catch (e) {
    console.error('/api/vocab/suggest error:', e);
    res.status(500).json({ error: 'suggest failed' });
  }
});

// ---------- Static React build ausliefern ----------
const path = require('path');
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

app.listen(PORT, () => console.log('Server listening on', PORT));
