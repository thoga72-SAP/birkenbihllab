// server/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();

// fetch (ESM) für Node CJS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ===== Postgres (optional für save/list) ===== */
const { Pool } = require("pg");
const pgUrl = process.env.DATABASE_URL;
let pool = null;
if (pgUrl) {
  pool = new Pool({
    connectionString: pgUrl,
    ssl: { rejectUnauthorized: false },
  });
}

app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json());

app.get("/health", (_req, res) => res.send("ok"));

/* ---------- DeepL Helpers ---------- */
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY;

function sanitizeCandidate(s) {
  if (!s) return "";
  let out = String(s).trim();
  // erste Zeile/Segment, max. 3 Worte, keine Zahlen/Datumsteile
  out = out.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
  const words = out.split(/\s+/).slice(0, 3);
  out = words.join(" ");
  if (/[0-9:/\-]/.test(out)) return ""; // filtert „Januar 2027:“ & Co
  return out;
}

async function deeplTranslateOnce(text, extra = {}) {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    target_lang: "DE",
    source_lang: "EN",
    split_sentences: "0",
    preserve_formatting: "1",
  });
  for (const [k, v] of Object.entries(extra)) params.set(k, v);

  const r = await fetch(DEEPL_URL, { method: "POST", body: params });
  const data = await r.json().catch(() => ({}));
  const t = data?.translations?.[0]?.text || "";
  return sanitizeCandidate(t);
}

/* ---------- API: Einzelwort ohne Kontext ---------- */
app.post("/api/translate", async (req, res) => {
  try {
    const phraseText = String(req.body?.phraseText || "").trim();
    if (!phraseText) return res.json({ translatedText: "", alts: [] });

    // Varianten: klein, InitCaps; formality: default/less/more
    const base = phraseText.toLowerCase();
    const cap = phraseText[0].toUpperCase() + phraseText.slice(1).toLowerCase();

    const asks = [
      deeplTranslateOnce(base),
      deeplTranslateOnce(cap),
      deeplTranslateOnce(base, { formality: "less" }),
      deeplTranslateOnce(base, { formality: "more" }),
    ];
    const raw = await Promise.allSettled(asks);
    const candidates = raw
      .map((p) => (p.status === "fulfilled" ? p.value : ""))
      .filter(Boolean);

    // dedupe, gültige Kandidaten
    const seen = new Set();
    const alts = [];
    for (const c of candidates) {
      const k = c.toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      alts.push(c);
    }

    const translatedText = alts[0] || "";
    res.json({ translatedText, alts });
  } catch (e) {
    console.error("/api/translate error:", e);
    res.status(500).json({ translatedText: "", alts: [] });
  }
});

/* ---------- API: Volltext (unverändert) ---------- */
app.post("/api/translate/fulltext", async (req, res) => {
  try {
    if (!DEEPL_KEY) return res.status(500).json({ error: "DEEPL_KEY missing" });
    const fullText = String(req.body?.fullText || "");
    const params = new URLSearchParams({
      auth_key: DEEPL_KEY,
      text: fullText,
      target_lang: "DE",
      source_lang: "EN",
    });
    const r = await fetch(DEEPL_URL, { method: "POST", body: params });
    const data = await r.json();
    const out = data?.translations?.[0]?.text || "";
    res.json({ translatedText: out });
  } catch (e) {
    console.error("/api/translate/fulltext error:", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

/* ---------- (Optional) Vokabel speichern ---------- */
app.post("/api/vocab/save", async (req, res) => {
  try {
    if (!pool) return res.json({ ok: false, reason: "no-db" });
    const eng = String(req.body?.eng || "").toLowerCase();
    const ger = String(req.body?.ger || "");
    if (!eng || !ger) return res.json({ ok: false });

    await pool.query(
      `INSERT INTO vocab(eng, ger, priority, cnt)
       VALUES ($1,$2,1,1)
       ON CONFLICT (eng,ger)
       DO UPDATE SET cnt = vocab.cnt + 1, priority = vocab.priority + 1`,
      [eng, ger]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/vocab/save error:", e);
    res.status(500).json({ ok: false });
  }
});

/* ---------- Static: React-Build ---------- */
const path = require("path");
const clientBuild = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuild));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientBuild, "index.html"));
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Server listening on", PORT));
