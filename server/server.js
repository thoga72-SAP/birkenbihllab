// server/server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

// node-fetch als ESM dynamisch laden, aber hier CommonJS verwenden
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

// ---------- Express-Grundsetup ----------
const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || '*',
  })
);
app.use(express.json());

// ---------- PostgreSQL (einziger Pool, Singleton) ----------
let pgPool = null;
function getPgPool() {
  if (pgPool) return pgPool;

  const { Pool } = require('pg'); // <- nur HIER require('pg')
  const connStr =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION_STRING;

  if (!connStr) {
    console.warn(
      '[PG] DATABASE_URL nicht gesetzt – Vokabel-Funktionen sind deaktiviert.'
    );
    return null;
  }

  pgPool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }, // Render-managed DBs
  });
  return pgPool;
}

async function ensureSchema() {
  const pool = getPgPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vocab (
      id           BIGSERIAL PRIMARY KEY,
      eng          TEXT NOT NULL,
      ger          TEXT NOT NULL,
      priority     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (eng, ger)
    );
    CREATE INDEX IF NOT EXISTS idx_vocab_eng ON vocab(LOWER(eng));
  `);
  console.log('[PG] Tabelle "vocab" bereit.');
}

// ---------- DeepL Helper ----------
async function deeplTranslate({ text, target = 'DE' }) {
  const key = process.env.DEEPL_KEY;
  const url =
    process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';

  if (!key) {
    return { ok: false, error: 'DEEPL_KEY missing' };
  }

  const params = new URLSearchParams({
    auth_key: key,
    text,
    target_lang: target,
  });

  const r = await fetch(url, {
    method: 'POST',
    body: params,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return {
      ok: false,
      error: `DeepL HTTP ${r.status}`,
      body,
    };
  }

  const data = await r.json();
  const translated =
    data && data.translations && data.translations[0]
      ? data.translations[0].text || ''
      : '';

  return { ok: true, text: translated };
}

// ---------- API: Health ----------
app.get('/health', (_req, res) => res.send('ok'));

// ---------- API: Einzelwort-/Phrasen-Übersetzung ----------
app.post('/api/translate', async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    // Prompt NICHT an den Client zurückgeben, sondern nur Ergebnis
    const prompt = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText ?? ''}". Kontext: "${contextText ?? ''}".`;

    const result = await deeplTranslate({ text: prompt, target: 'DE' });
    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    // Kurz bereinigen: erste Zeile / vor Satzzeichen cutten, max. 3 Wörter
    let cleaned = (result.text || '').split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
    const parts = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
    cleaned = parts.join(' ');

    return res.json({ translatedText: cleaned });
  } catch (e) {
    console.error('[translate] error:', e);
    res.status(500).json({ error: 'translate failed' });
  }
});

// ---------- API: Volltext-Kontext ----------
app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const result = await deeplTranslate({ text: fullText || '', target: 'DE' });
    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }
    return res.json({ translatedText: result.text || '' });
  } catch (e) {
    console.error('[fulltext] error:', e);
    res.status(500).json({ error: 'fulltext failed' });
  }
});

// ---------- API: Vokabeln (persistente Priorität & manuelle Eingaben) ----------

// GET /api/vocab?eng=word  -> liefert gespeicherte GER-Optionen (sortiert nach priority desc, ger asc)
app.get('/api/vocab', async (req, res) => {
  try {
    const pool = getPgPool();
    if (!pool) return res.json({ items: [] });

    const eng = String(req.query.eng || '').trim().toLowerCase();
    if (!eng) return res.json({ items: [] });

    const { rows } = await pool.query(
      `SELECT ger, priority
         FROM vocab
        WHERE LOWER(eng) = LOWER($1)
        ORDER BY priority DESC, ger ASC
      `,
      [eng]
    );

    return res.json({ items: rows || [] });
  } catch (e) {
    console.error('[vocab GET] error:', e);
    res.status(500).json({ error: 'vocab get failed' });
  }
});

// POST /api/vocab/save { eng, ger, inc = 1 } -> upsert + priority erhöhen
app.post('/api/vocab/save', async (req, res) => {
  try {
    const pool = getPgPool();
    if (!pool) return res.json({ ok: true, skipped: true });

    const { eng, ger, inc = 1 } = req.body || {};
    const engNorm = String(eng || '').trim().toLowerCase();
    const gerNorm = String(ger || '').trim();

    if (!engNorm || !gerNorm) return res.status(400).json({ error: 'bad input' });

    await pool.query(
      `
      INSERT INTO vocab (eng, ger, priority)
      VALUES ($1, $2, $3)
      ON CONFLICT (eng, ger)
      DO UPDATE SET priority = vocab.priority + EXCLUDED.priority
      `,
      [engNorm, gerNorm, Number(inc) || 1]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[vocab SAVE] error:', e);
    res.status(500).json({ error: 'vocab save failed' });
  }
});

// ---------- Static Frontend ausliefern ----------
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// Fallback auf index.html (SPA)
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

// ---------- Start ----------
app.listen(PORT, async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.warn('[PG] Schema-Init übersprungen:', e?.message || e);
  }
  console.log(`[server] listening on ${PORT}`);
});
