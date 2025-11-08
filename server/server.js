require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// CORS (same-origin ok; zusätzlich localhost im Dev möglich)
app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json());

// ---- DeepL Hilfen ----
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY || "";

// DeepL call: simples Wort/Phrase (ohne Prompt-Müll)
async function deeplTranslate(text, sourceLang = "EN", targetLang = "DE") {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    target_lang: targetLang,
    source_lang: sourceLang,
  });
  const r = await fetch(DEEPL_URL, { method: "POST", body: params });
  const data = await r.json();
  return data?.translations?.[0]?.text || "";
}

// POST /api/translate  -> Einzelwort/Phrase (EN->DE)
app.post("/api/translate", async (req, res) => {
  try {
    const phraseText = (req.body?.phraseText || "").toString();
    if (!phraseText.trim()) return res.status(400).json({ error: "phraseText required" });
    const out = await deeplTranslate(phraseText, "EN", "DE");
    res.json({ translatedText: out });
  } catch (e) {
    console.error("translate failed:", e);
    res.status(500).json({ error: "translate failed" });
  }
});

// POST /api/translate/fulltext -> Volltext (EN->DE)
app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const fullText = (req.body?.fullText || "").toString();
    const out = await deeplTranslate(fullText, "EN", "DE");
    res.json({ translatedText: out });
  } catch (e) {
    console.error("fulltext failed:", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

// (Optional) Alternativen (Stub) – hier könntest du später DeepL-Alternativen/Glossar anbinden
app.post("/api/alternatives", async (req, res) => {
  try {
    // Platzhalter: gib leere Liste zurück, bis echte Alternativen implementiert sind
    res.json({ alternatives: [] });
  } catch (e) {
    res.json({ alternatives: [] });
  }
});

// ---- Persistenz (PostgreSQL best effort) ----
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    });
    // Tabelle anlegen, falls nicht existiert
    (async () => {
      await pool.query(`
        create table if not exists vocab (
          id serial primary key,
          english text not null,
          german  text not null,
          weight  integer not null default 1,
          created_at timestamptz not null default now(),
          unique (english, german)
        );
      `);
      console.log("DB ready.");
    })().catch((e) => console.error("DB init error:", e));
  } catch (e) {
    console.error("pg not available, skipping DB:", e.message);
    pool = null;
  }
}

// POST /api/vocab/upsert  -> (english,german) speichern/hochzählen
app.post("/api/vocab/upsert", async (req, res) => {
  if (!pool) return res.status(501).json({ ok: false, reason: "no db" });

  try {
    const english = (req.body?.english || "").toString().trim().toLowerCase();
    const german  = (req.body?.german  || "").toString().trim();

    if (!english || !german) return res.status(400).json({ ok: false, reason: "bad input" });

    await pool.query(
      `insert into vocab (english, german, weight)
       values ($1,$2,1)
       on conflict (english, german)
       do update set weight = vocab.weight + 1;`,
      [english, german]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("upsert failed:", e);
    res.status(500).json({ ok: false });
  }
});

// Healthcheck
app.get("/health", (req, res) => res.send("ok"));

// ---- Static Client ausliefern (Vite build in client/dist) ----
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

app.listen(PORT, () => console.log("Server listening on", PORT));
