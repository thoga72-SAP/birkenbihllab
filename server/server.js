require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json());

// ---------- DeepL Helper ----------

const DEEPL_URL = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
const DEEPL_KEY = process.env.DEEPL_KEY;

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'
];

function looksBad(s) {
  if (!s) return true;
  const t = s.trim();

  // Prompt-Echos und Meta
  if (/^\s*(übersetze|translate)\b/i.test(t)) return true;

  // Verhindere Datum/Monat-Artefakte & Zahlen
  if (/\d/.test(t)) return true;
  const monthRe = new RegExp(`\\b(${MONTHS.join('|')})\\b`, 'i');
  if (monthRe.test(t)) return true;

  // Nur “normale” Zeichen (Deutsch/Leerzeichen/Bindestrich)
  if (!/^[A-Za-zÄÖÜäöüß \-]+$/.test(t)) return true;

  return false;
}

function cleanOne(s) {
  if (!s) return '';
  // erste Zeile / vor erstem Satzende
  let t = s.split(/[\r\n]/)[0].split(/[.!?;:]/)[0].trim();
  // höchstens 3 Wörter
  t = t.split(/\s+/).slice(0, 3).join(' ').trim();
  if (!t) return '';
  if (looksBad(t)) return '';
  return t;
}

function dedupKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = (x || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function deeplTranslateOnce(text, extraParams = {}) {
  if (!DEEPL_KEY) throw new Error('DEEPL_KEY missing');
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    target_lang: 'DE',
    source_lang: 'EN',
    split_sentences: '0',
    preserve_formatting: '1',
    ...extraParams
  });
  const r = await fetch(DEEPL_URL, { method: 'POST', body: params });
  const data = await r.json().catch(() => ({}));
  const raw = data?.translations?.[0]?.text || '';
  return raw;
}

async function deeplWordWithAlts(phrase, contextLine) {
  // Wir sammeln mehrere Versuche (original, lowercased, formality)
  const jobs = [
    { t: phrase, p: {} },
    { t: phrase.toLowerCase(), p: {} },
    { t: phrase, p: { formality: 'more' } },
    { t: phrase, p: { formality: 'less' } },
  ];

  const rawCandidates = [];
  for (const j of jobs) {
    try {
      const raw = await deeplTranslateOnce(j.t, j.p);
      if (raw) rawCandidates.push(raw);
    } catch (e) {
      console.warn('DeepL call failed:', e.message);
    }
  }

  // Säubern
  const cleaned = rawCandidates
    .map(cleanOne)
    .filter(Boolean);

  const unique = dedupKeepOrder(cleaned);

  // Erste ist Hauptübersetzung
  return {
    translatedText: unique[0] || '',
    alts: unique
  };
}

// ---------- API ----------

app.get('/health', (req, res) => res.send('ok'));

app.post('/api/translate', async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    if (!phraseText || !phraseText.trim()) {
      return res.status(400).json({ error: 'phraseText missing' });
    }
    const result = await deeplWordWithAlts(phraseText.trim(), contextText || '');
    return res.json(result);
  } catch (e) {
    console.error('/api/translate error:', e);
    return res.status(500).json({ error: 'translate failed' });
  }
});

app.post('/api/translate/fulltext', async (req, res) => {
  try {
    const { fullText } = req.body || {};
    if (!fullText || !fullText.trim()) {
      return res.json({ translatedText: '' });
    }
    const raw = await deeplTranslateOnce(fullText.trim(), { split_sentences: '1' });
    const cleaned = (raw || '').replace(/\s+/g, ' ').trim();
    return res.json({ translatedText: cleaned });
  } catch (e) {
    console.error('/api/translate/fulltext error:', e);
    return res.status(500).json({ error: 'fulltext failed' });
  }
});

// ---------- Static client (Vite build) ----------
const path = require('path');
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');

app.use(express.static(clientBuildPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

app.listen(PORT, () => console.log('Server listening on', PORT));
