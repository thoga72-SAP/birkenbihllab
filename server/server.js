// server/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOW_ORIGIN || "*" }));
app.use(express.json());

// Health
app.get("/health", (req, res) => res.send("ok"));

// -------- DeepL Proxy --------
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY || "";

async function deeplTranslate(params) {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const body = new URLSearchParams({ auth_key: DEEPL_KEY, target_lang: "DE", ...params });
  const r = await fetch(DEEPL_URL, { method: "POST", body });
  if (!r.ok) throw new Error(`DeepL HTTP ${r.status}`);
  const data = await r.json();
  return data;
}

app.post("/api/translate", async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    const text = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText}". Kontext: "${contextText}"`;
    const data = await deeplTranslate({ text });
    res.json({ translatedText: data?.translations?.[0]?.text || "" });
  } catch (e) {
    console.error("translate failed", e);
    res.status(500).json({ error: "translate failed" });
  }
});

app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const data = await deeplTranslate({ text: fullText || "" });
    res.json({ translatedText: data?.translations?.[0]?.text || "" });
  } catch (e) {
    console.error("fulltext failed", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

/**
 * Alternativen:
 * - versucht DeepL-Parameter `alternatives` (falls für den Account freigeschaltet)
 * - Fallback: Prompt bittet DeepL um kommaseparierte Alternativen
 */
app.post("/api/translate/alternatives", async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    // Versuch 1: natives alternatives
    try {
      const data = await deeplTranslate({ text: phraseText, alternatives: "3" });
      const base = data?.translations?.[0];
      const alts = [];
      if (base?.text) alts.push(base.text);
      if (Array.isArray(base?.alternatives)) {
        for (const a of base.alternatives) if (a?.text) alts.push(a.text);
      }
      const cleaned = [...new Set(alts.map(x => String(x).trim()).filter(Boolean))];
      if (cleaned.length > 0) return res.json({ alternatives: cleaned });
    } catch (e) {
      // still try fallback
    }

    // Fallback: prompt
    const prompt =
      `Gib 15 sehr kurze deutsche Alternativen zur Übersetzung des englischen Wortes/Phrase "${phraseText}" ` +
      `im Kontext "${contextText}". Antworte nur mit einer kommaseparierten Liste ohne Erklärungen.`;
    const data2 = await deeplTranslate({ text: prompt });
    const raw = data2?.translations?.[0]?.text || "";
    const parts = raw.split(/[,;|\n]/).map(s => s.trim()).filter(Boolean).slice(0, 20);
    const unique = [...new Set(parts)];
    res.json({ alternatives: unique });
  } catch (e) {
    console.error("alternatives failed", e);
    res.status(500).json({ alternatives: [] });
  }
});

// -------- User-Vokabel persistieren (best effort) --------
const DATA_DIR = path.join(__dirname, "data");
const USER_VOCAB_FILE = path.join(DATA_DIR, "user_vocab.txt");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

app.post("/api/vocab/add", async (req, res) => {
  try {
    const { eng, de } = req.body || {};
    const line = `${(eng || "").trim().toLowerCase()} # ${(de || "").trim()}`;
    if (!eng || !de) return res.status(400).json({ ok: false, reason: "bad-input" });
    try {
      fs.appendFileSync(USER_VOCAB_FILE, line + "\n", { encoding: "utf8" });
      return res.json({ ok: true, persisted: true });
    } catch (e) {
      console.warn("Could not persist user_vocab.txt (read-only FS?)", e.message);
      return res.json({ ok: true, persisted: false });
    }
  } catch (e) {
    console.error("vocab/add failed", e);
    res.status(500).json({ ok: false });
  }
});

// -------- React-Frontend ausliefern --------
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

app.listen(PORT, () => console.log("Server listening on", PORT));
