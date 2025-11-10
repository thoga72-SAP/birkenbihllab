// server/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { Pool } = require("pg");

// --- Konfiguration ---
const PORT = process.env.PORT || 10000;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- App & Middleware ---
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: ALLOW_ORIGIN }));

// --- Postgres Pool (optional: nur wenn URL gesetzt) ---
let pgPool = null;
if (DATABASE_URL) {
  pgPool = new Pool({ connectionString: DATABASE_URL, max: 3 });
}

// Hilfsfunktion: DeepL call
async function deeplTranslate(text, opts = {}) {
  if (!DEEPL_KEY) return { ok: false, text: "", alts: [] };

  const params = new URLSearchParams();
  params.set("auth_key", DEEPL_KEY);
  params.set("text", text);
  params.set("source_lang", opts.source_lang || "EN");
  params.set("target_lang", opts.target_lang || "DE");
  if (opts.formality) params.set("formality", opts.formality); // prefer_less / prefer_more
  if (opts.split_sentences != null) params.set("split_sentences", String(opts.split_sentences));

  const r = await fetch(DEEPL_URL, { method: "POST", body: params });
  const j = await r.json().catch(() => ({}));

  const t =
    j?.translations?.[0]?.text?.trim?.() ||
    "";

  // Falls DeepL „alternatives“ unterstützt (manche Accounts), übernehmen
  let alts = [];
  const rawAlts = j?.translations?.[0]?.alternatives || j?.alternatives || [];
  if (Array.isArray(rawAlts)) {
    alts = rawAlts
      .map((a) => (typeof a === "string" ? a : a?.text))
      .filter(Boolean)
      .map((s) => s.trim());
  }
  return { ok: true, text: t, alts };
}

// Heuristik: Alternativen erzwingen (wenn API keine „alternatives“ liefert)
async function collectAlternatives(englishWord, contextLine) {
  const out = new Set();

  // 1) Standard
  const a1 = await deeplTranslate(englishWord, { source_lang: "EN", target_lang: "DE" });
  if (a1.text) out.add(a1.text);
  (a1.alts || []).forEach((x) => out.add(x));

  // 2) Kleinschreibung
  const lower = englishWord.toLowerCase();
  if (lower !== englishWord) {
    const a2 = await deeplTranslate(lower, { source_lang: "EN", target_lang: "DE" });
    if (a2.text) out.add(a2.text);
    (a2.alts || []).forEach((x) => out.add(x));
  }

  // 3) mit Kontext (ganze Zeile)
  if (contextLine) {
    const a3 = await deeplTranslate(contextLine, { source_lang: "EN", target_lang: "DE" });
    if (a3.text) {
      // nimm das „beste“ einzelne Wort/kurze Phrase aus dem Satz (1–3 Wörter)
      const first = a3.text.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
      const parts = first.split(/\s+/).slice(0, 3).join(" ").trim();
      if (parts) out.add(parts);
    }
  }

  // 4) Formalitäts-Varianten
  const a4 = await deeplTranslate(englishWord, { source_lang: "EN", target_lang: "DE", formality: "prefer_less" });
  if (a4.text) out.add(a4.text);
  const a5 = await deeplTranslate(englishWord, { source_lang: "EN", target_lang: "DE", formality: "prefer_more" });
  if (a5.text) out.add(a5.text);

  // Nach Länge/Einfachheit sortieren (kürzer zuerst), dann alphabetisch
  const arr = [...out]
    .map((s) => s.trim())
    .filter((s) => s && !/^übersetze möglichst|^translate/i.test(s));
  arr.sort((a, b) => (a.split(/\s+/).length - b.split(/\s+/).length) || a.localeCompare(b, "de"));

  // Top 12 reichen locker
  return arr.slice(0, 12);
}

// --- API: Health ---
app.get("/health", (req, res) => res.send("ok"));

// --- API: Volltext (für Kontextanzeige) ---
app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const fullText = (req.body?.fullText || "").toString();
    const r = await deeplTranslate(fullText, { source_lang: "EN", target_lang: "DE", split_sentences: 1 });
    return res.json({ translatedText: r.text || "" });
  } catch (e) {
    console.error("/api/translate/fulltext error:", e);
    return res.status(500).json({ error: "fulltext failed" });
  }
});

// --- API: Einzelwort mit Alternativen ---
app.post("/api/translate", async (req, res) => {
  try {
    const phraseText = (req.body?.phraseText || "").toString().trim();
    const contextText = (req.body?.contextText || "").toString();
    if (!phraseText) return res.json({ translatedText: "", alts: [] });

    // Erstübersetzung (Hauptkandidat)
    const first = await deeplTranslate(phraseText, { source_lang: "EN", target_lang: "DE" });
    let main = first.text || "";
    if (/^übersetze möglichst|^translate/i.test(main)) main = ""; // Sicherheit

    // Alternativen einsammeln
    const alts = await collectAlternatives(phraseText, contextText);

    // Falls „main“ leer ist, nimm erste Alternative
    if (!main && alts.length) main = alts[0];

    return res.json({ translatedText: main, alts });
  } catch (e) {
    console.error("/api/translate error:", e);
    return res.status(500).json({ error: "translate failed" });
  }
});

// --- API: Vokabel speichern (optional, wenn DB konfiguriert) ---
// body: { eng: "oversee", ger: "überwachen" }
app.post("/api/vocab/save", async (req, res) => {
  try {
    if (!pgPool) return res.json({ ok: true }); // no-op ohne DB
    const eng = (req.body?.eng || "").toString().trim().toLowerCase();
    const ger = (req.body?.ger || "").toString().trim();
    if (!eng || !ger) return res.json({ ok: true });

    // Tabelle: vocab(eng text, ger text, priority int default 0, cnt int default 0, PRIMARY KEY(eng, ger))
    await pgPool.query(
      `
      INSERT INTO vocab (eng, ger, priority, cnt)
      VALUES ($1, $2, 0, 1)
      ON CONFLICT (eng, ger) DO UPDATE
      SET cnt = vocab.cnt + 1;
      `,
      [eng, ger]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/vocab/save error:", e);
    return res.status(500).json({ ok: false });
  }
});

// --- Static React ausliefern ---
const path = require("path");
const clientBuild = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuild));
app.get("*", (req, res) => res.sendFile(path.join(clientBuild, "index.html")));

app.listen(PORT, () => console.log("Server listening on", PORT));
