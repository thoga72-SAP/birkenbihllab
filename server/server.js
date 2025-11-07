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

async function deeplTranslate(text, target = "DE") {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const params = new URLSearchParams({ auth_key: DEEPL_KEY, text, target_lang: target });
  const r = await fetch(DEEPL_URL, { method: "POST", body: params });
  const data = await r.json();
  return data?.translations?.[0]?.text || "";
}

app.post("/api/translate", async (req, res) => {
  try {
    const { phraseText, contextText } = req.body || {};
    const prompt = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText}". Kontext: "${contextText}"`;
    const out = await deeplTranslate(prompt, "DE");
    res.json({ translatedText: out });
  } catch (e) {
    console.error("translate failed", e);
    res.status(500).json({ error: "translate failed" });
  }
});

app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const { fullText } = req.body || {};
    const out = await deeplTranslate(fullText || "", "DE");
    res.json({ translatedText: out });
  } catch (e) {
    console.error("fulltext failed", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

// -------- User-Vokabel persistieren (best effort) --------
const DATA_DIR = path.join(__dirname, "data");
const USER_VOCAB_FILE = path.join(DATA_DIR, "user_vocab.txt");

// Stelle sicher, dass data/ existiert
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
