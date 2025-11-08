require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Node 18+ hat global fetch; falls älter, optional node-fetch:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

// DeepL
const DEEPL_URL = (process.env.DEEPL_URL || 'https://api-free.deepl.com') + '/v2/translate';
const DEEPL_KEY = process.env.DEEPL_KEY;

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vocab (
      eng TEXT NOT NULL,
      ger TEXT NOT NULL,
      cnt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (eng, ger)
    );
  `);
}
ensureSchema().catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});

app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());
app.set('trust proxy', 1);

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Vokabel-API ----------
function normEng(s) { return String(s || '').trim().toLowerCase(); }
function normGer(s) { return String(s || '').trim(); }

app.post('/api/vocab/save', async (req, res) => {
  try {
    const { eng, ger, increment = true } = req.body || {};
    const e = normEng(eng);
    const g = normGer(ger);
    if (!e || !g) return res.status(400).json({ error: 'eng/ger required' });

    // upsert
    const inc = increment ? 1 : 0;
    await pool.query(
      `INSERT INTO vocab (eng, ger, cnt)
       VALUES ($1, $2, $3)
       ON CONFLICT (eng, ger)
       DO UPDATE SET cnt = vocab.cnt + EXCLUDED.cnt`,
      [e, g, inc]
    );

    // Rückgabe: aktuelle Liste
    const { rows } = await pool.query(
      'SELECT ger, cnt FROM vocab WHERE eng = $1 ORDER BY cnt DESC, ger ASC',
      [e]
    );
    res.json({ ok: true, entries: rows });
  } catch (e) {
    console.error('/api/vocab/save', e);
    res.status(500).json({ error: 'save failed' });
  }
});

app.post('/api/vocab/batch', async (req, res) => {
  try {
    const words = Array.isArray(req.body?.words) ? req.body.words : [];
    const uniq = [...new Set(words.map(normEng).filter(Boolean))];
    if (uniq.length === 0) return res.json({ entries: {} });

    // Batch-Query
    const { rows } = await pool.query(
      `SELECT eng, ger, cnt FROM vocab WHERE eng = ANY($1)`,
      [uniq]
    );

    const map = Object.create(null);
    for (const w of uniq) map[w] = [];
    for (const r of rows) {
      (map[r.eng] ||= []).push({ ger: r.ger, cnt: Number(r.cnt) || 0 });
    }
    // sortierte Ausgabe
    for (const w of uniq) {
      map[w].sort((a, b) => (b.cnt - a.cnt) || a.ger.localeCompare(b.ger, 'de'));
    }
    res.json({ entries: map });
  } catch (e) {
    console.error('/api/vocab/batch', e);
    res.status(500).json({ error: 'batch failed' });
  }
});

// ---------- DeepL-API Wrapper ----------

function dedupStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(s || '').trim());
  }
  return out;
}

/**
 * Hol mehrere Kandidaten:
 * - Groß-/klein geschriebenes Wort
 * - formality: less / more
 * Hinweis: DeepL liefert pro Text genau EINE Übersetzung; wir variieren die Parameter,
 *         um mehrere sinnvolle Varianten zu sammeln (API bietet keine „Web-Alternativen“-Liste).
 */
async function deeplAlternatives({ text, context, targetLang = 'DE' }) {
  if (!DEEPL_KEY) return [];

  const texts = [text, text.toLowerCase()];
  const formalities = ['less', 'more'];

  const candidates = [];

  // Wir schicken pro Formalität eine Anfrage mit beiden Textvarianten in einem Rutsch
  for (const formality of formalities) {
    const body = {
      text: texts,
      target_lang: targetLang,
      // Kontext kann Qualität erhöhen (nicht verrechnet)
      context: context || undefined,
      formality,
    };

    const r = await fetch(DEEPL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Bei Fehlersituationen „best effort“: einfach auslassen
    if (!r.ok) continue;
    const data = await r.json().catch(() => null);
    const arr = Array.isArray(data?.translations) ? data.translations : [];
    for (const t of arr) {
      const txt = String(t?.text || '').trim();
      if (!txt) continue;
      // evtl. Satzabbruch + auf 3 Wörter limitieren
      let cleaned = txt.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
      cleaned = cleaned.split(/\s+/).slice(0, 3).join(' ');
      if (cleaned) candidates.push(cleaned);
    }
  }

  return dedupStrings(candidates);
}

app.post('/api/translate', async (req, res) => {
  try {
    const phraseText = String(req.body?.phraseText || '').trim();
    const contextText = String(req.body?.contextText || '').trim();
    if (!phraseText) return res.status(400).json({ error: 'phraseText required' });
    if (!DEEPL_KEY) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    const alts = await deeplAlternatives({ text: phraseText, context: contextText, targetLang: 'DE' });
    const best = alts[0] || '';

    // Voraus-Speicherung der Alternativen (cnt = 0), damit sie im Tooltip auftauchen
    if (alts.length) {
      const e = normEng(phraseText);
      for (const g of alts) {
        try {
          await pool.query(
            `INSERT INTO vocab (eng, ger, cnt)
             VALUES ($1, $2, 0)
             ON CONFLICT (eng, ger) DO NOTHING`,
            [e, g]
          );
        } catch { /* ignore seed errors */ }
      }
    }

    res.json({ translatedText: best, alts });
  } catch (e) {
    console.error('/api/translate', e);
    res.status(500).json({ error: 'translate failed' });
  }
});

app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const fullText = String(req.body?.fullText || '');
    if (!DEEPL_KEY) return res.status(500).json({ error: 'DEEPL_KEY missing' });

    const body = {
      text: [fullText],
      target_lang: 'DE',
      // für Lesbarkeit eher „default“; bei Bedarf formality hier steuerbar
      formality: 'default',
    };

    const r = await fetch(DEEPL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const tx = await r.text();
      console.warn('fulltext response not ok:', r.status, tx);
      return res.status(502).json({ error: 'deepl fulltext failed' });
    }

    const data = await r.json();
    const txt = data?.translations?.[0]?.text || '';
    res.json({ translatedText: txt });
  } catch (e) {
    console.error('/api/translate/fulltext', e);
    res.status(500).json({ error: 'fulltext failed' });
  }
});

// ---------- Frontend ausliefern ----------
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
