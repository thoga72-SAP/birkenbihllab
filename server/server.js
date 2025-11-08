// server/server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

// fetch in CommonJS
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3001;

// ---- CORS (auf Render gleicher Origin – lokal ggf. localhost erlauben)
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json());

// ---- PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Tabelle anlegen
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vocab (
      word TEXT PRIMARY KEY,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      counts  JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}
ensureSchema().catch(console.error);

// Hilfen
async function getRow(word) {
  const { rows } = await pool.query(`SELECT word, options, counts FROM vocab WHERE word=$1`, [word]);
  if (rows.length) return rows[0];
  return { word, options: [], counts: {} };
}
function addUnique(optionsArr, additions) {
  const set = new Set((optionsArr || []).map(o => String(o).trim().toLowerCase()));
  const out = [...(optionsArr || [])];
  for (const a of additions || []) {
    const k = String(a || "").trim();
    if (k && !set.has(k.toLowerCase())) {
      set.add(k.toLowerCase());
      out.push(k);
    }
  }
  return out;
}
function incCount(counts, choice, incBy = 1) {
  const c = { ...(counts || {}) };
  const key = String(choice || "").trim();
  if (!key) return c;
  const cur = Number(c[key] || 0);
  c[key] = cur + incBy;
  return c;
}
function sortWithCounts(options, counts) {
  return [...(options || [])].sort((a, b) => {
    const ca = Number((counts || {})[a] || 0);
    const cb = Number((counts || {})[b] || 0);
    if (cb !== ca) return cb - ca;
    return a.localeCompare(b, "de");
  });
}

// ---- API: Vokabel abrufen
app.get("/api/vocab", async (req, res) => {
  try {
    const word = String(req.query.word || "").toLowerCase().trim();
    if (!word) return res.json({ word: "", options: [], counts: {} });
    const row = await getRow(word);
    const sorted = sortWithCounts(row.options, row.counts);
    res.json({ word, options: sorted, counts: row.counts || {} });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "vocab get failed" });
  }
});

// ---- API: Auswahl zählen + Option sicherstellen
app.post("/api/vocab/choose", async (req, res) => {
  try {
    const word = String(req.body.word || "").toLowerCase().trim();
    const choice = String(req.body.choice || "").trim();
    if (!word || !choice) return res.status(400).json({ error: "missing word/choice" });

    const row = await getRow(word);
    const options = addUnique(row.options, [choice]);
    const counts = incCount(row.counts, choice, 1);

    await pool.query(
      `INSERT INTO vocab(word, options, counts)
       VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (word)
       DO UPDATE SET options = EXCLUDED.options, counts = EXCLUDED.counts`,
      [word, JSON.stringify(options), JSON.stringify(counts)]
    );

    res.json({ word, options: sortWithCounts(options, counts), counts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "vocab choose failed" });
  }
});

// ---- API: manuelle Option hinzufügen (optional: increment)
app.post("/api/vocab/manual", async (req, res) => {
  try {
    const word = String(req.body.word || "").toLowerCase().trim();
    const translation = String(req.body.translation || "").trim();
    const increment = !!req.body.increment;
    if (!word || !translation) return res.status(400).json({ error: "missing word/translation" });

    const row = await getRow(word);
    const options = addUnique(row.options, [translation]);
    const counts = increment ? incCount(row.counts, translation, 1) : (row.counts || {});

    await pool.query(
      `INSERT INTO vocab(word, options, counts)
       VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (word)
       DO UPDATE SET options = EXCLUDED.options, counts = EXCLUDED.counts`,
      [word, JSON.stringify(options), JSON.stringify(counts)]
    );

    res.json({ word, options: sortWithCounts(options, counts), counts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "vocab manual failed" });
  }
});

// ---- API: mehrere Optionen “nur hinzufügen”
app.post("/api/vocab/upsertMany", async (req, res) => {
  try {
    const word = String(req.body.word || "").toLowerCase().trim();
    const optionsIn = Array.isArray(req.body.options) ? req.body.options.map(x => String(x || "").trim()).filter(Boolean) : [];
    if (!word || !optionsIn.length) return res.status(400).json({ error: "missing word/options" });

    const row = await getRow(word);
    const options = addUnique(row.options, optionsIn);
    const counts  = row.counts || {};

    await pool.query(
      `INSERT INTO vocab(word, options, counts)
       VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (word)
       DO UPDATE SET options = EXCLUDED.options`,
      [word, JSON.stringify(options), JSON.stringify(counts)]
    );

    res.json({ word, options: sortWithCounts(options, counts), counts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "vocab upsertMany failed" });
  }
});

// ---- DeepL Relay
app.post("/api/translate", async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
    if (!key) return res.status(500).json({ error: "DEEPL_KEY missing" });

    const prompt = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText}". Kontext: "${contextText}"`;
    const params = new URLSearchParams({ auth_key: key, text: prompt, target_lang: "DE" });

    const r = await fetch(url, { method: "POST", body: params });
    const data = await r.json();
    const text = (data && data.translations && data.translations[0] && data.translations[0].text) || "";

    // Nur die eigentliche Übersetzung zurückgeben (erste Zeile/Satz, max 3 Wörter)
    const line = text.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
    const trimmed = line.split(/\s+/).slice(0, 3).join(" ");
    res.json({ translatedText: trimmed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "translate failed" });
  }
});

app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
    if (!key) return res.status(500).json({ error: "DEEPL_KEY missing" });

    const params = new URLSearchParams({ auth_key: key, text: fullText || "", target_lang: "DE" });
    const r = await fetch(url, { method: "POST", body: params });
    const data = await r.json();
    const text = (data && data.translations && data.translations[0] && data.translations[0].text) || "";
    res.json({ translatedText: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

// ---- Health
app.get("/health", (req, res) => res.send("ok"));

// ---- React-Frontend ausliefern
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

app.listen(PORT, () => console.log("Server listening on", PORT));
