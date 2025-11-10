// server/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;

// erlaubt Frontend von gleicher Origin (Render)
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json());

// ---------- DB (optional für spätere Speicherung) ----------
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  });
}

// ---------- DeepL Helper ----------
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY;

async function deeplTranslate(params) {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const body = new URLSearchParams({ auth_key: DEEPL_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.append(k, String(v));
  }
  const r = await fetch(DEEPL_URL, { method: "POST", body });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`DeepL ${r.status}: ${txt}`);
  }
  return r.json();
}

function uniqStrings(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x || "").trim().toLowerCase();
    if (!k || s.has(k)) continue;
    s.add(k);
    out.push(String(x).trim());
  }
  return out;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.send("ok"));

// Volltext (Kontext) – bleibt wie gehabt
app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const fullText = String(req.body?.fullText || "");
    const json = await deeplTranslate({
      text: fullText,
      source_lang: "EN",
      target_lang: "DE",
      split_sentences: "1",
      preserve_formatting: "1",
    });
    const out = json?.translations?.[0]?.text || "";
    res.json({ translatedText: out });
  } catch (e) {
    console.error("/api/translate/fulltext error:", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

// Einzelwort mit Alternativen
app.post("/api/translate_word", async (req, res) => {
  try {
    const word = String(req.body?.word || "").trim();
    if (!word) return res.json({ options: [] });

    // zwei Varianten probieren: Original & lowercase
    const variants = uniqStrings([word, word.toLowerCase()]);

    let options = [];
    for (const v of variants) {
      const json = await deeplTranslate({
        text: v,
        source_lang: "EN",
        target_lang: "DE",
        // liefert bis zu 3 Alternativen (falls verfügbar)
        alternatives: "3",
        split_sentences: "1",
        preserve_formatting: "1",
      });

      const main = json?.translations?.[0]?.text ? [json.translations[0].text] : [];
      const alts =
        json?.translations?.[0]?.alternatives?.map((a) => a?.text).filter(Boolean) || [];
      options = options.concat(main, alts);
    }

    // aufräumen: kurz halten, doppelte raus
    options = uniqStrings(options).slice(0, 8);

    res.json({ options });
  } catch (e) {
    console.error("/api/translate_word error:", e);
    res.status(500).json({ error: "word translate failed" });
  }
});

// ---------- Static React Build ausliefern ----------
const path = require("path");
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

app.listen(PORT, () => console.log("Server listening on", PORT));
