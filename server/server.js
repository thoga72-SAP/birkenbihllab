require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { Pool } = require("pg");

/* ---------- Konfig ---------- */
const PORT = process.env.PORT || 3001;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "http://localhost:5173";
const DEEPL_URL = process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";
const DEEPL_KEY = process.env.DEEPL_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ---------- Express ---------- */
const app = express();
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());

/* ---------- PG Pool ---------- */
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Render-Managed Postgres
  });
}

/* ---------- Helpers ---------- */
function cutToMax3Words(s) {
  if (!s) return "";
  // erste Zeile/Teil bis Satzende, dann max. 3 Wörter
  let first = s.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
  const parts = first.split(/\s+/).filter(Boolean).slice(0, 3);
  return parts.join(" ");
}

async function deeplTranslate(text, { target = "DE" } = {}) {
  if (!DEEPL_KEY) throw new Error("DEEPL_KEY missing");
  const params = new URLSearchParams({
    auth_key: DEEPL_KEY,
    text,
    target_lang: target,
  });
  const r = await fetch(DEEPL_URL, { method: "POST", body: params });
  const data = await r.json();
  const out = data?.translations?.[0]?.text || "";
  return out;
}

/* =========================================================
   API: DeepL
   ========================================================= */

/** POST /api/translate
 * body: { phraseText, contextText }
 * -> translatedText (max ~3 Wörter, context gestützt)
 */
app.post("/api/translate", async (req, res) => {
  try {
    const phraseText = (req.body?.phraseText || "").toString();
    const contextText = (req.body?.contextText || "").toString();

    if (!phraseText) return res.status(400).json({ error: "phraseText required" });
    if (!DEEPL_KEY) return res.status(500).json({ error: "DEEPL_KEY missing" });

    // Konservatives Prompting: 1–3 Wörter, aber DeepL bekommt nur "text",
    // daher schicken wir Phrase + kurzen Kontext zusammen, damit DE besser passt.
    const full = `Übersetze möglichst wortwörtlich (max. 3 Wörter): "${phraseText}". Kontext: ${contextText}`;
    const raw = await deeplTranslate(full, { target: "DE" });
    const cleaned = cutToMax3Words(raw);

    res.json({ translatedText: cleaned || raw || "" });
  } catch (e) {
    console.error("/api/translate error:", e);
    res.status(500).json({ error: "translate failed" });
  }
});

/** POST /api/translate/fulltext
 * body: { fullText }
 * -> translatedText (voll)
 */
app.post("/api/translate/fulltext", async (req, res) => {
  try {
    const fullText = (req.body?.fullText || "").toString();
    if (!fullText) return res.status(400).json({ error: "fullText required" });
    if (!DEEPL_KEY) return res.status(500).json({ error: "DEEPL_KEY missing" });

    const raw = await deeplTranslate(fullText, { target: "DE" });
    res.json({ translatedText: raw || "" });
  } catch (e) {
    console.error("/api/translate/fulltext error:", e);
    res.status(500).json({ error: "fulltext failed" });
  }
});

/* =========================================================
   API: Vokabel-Persistenz (PostgreSQL)
   Tabelle: vocab(eng text, ger text, priority int, cnt int, PRIMARY KEY(eng,ger))
   Sortierlogik im Client: nach priority DESC, dann alphabetisch
   ========================================================= */

/** POST /api/vocab/save
 * body: { eng, ger, deltaPriority?:number, incCnt?:boolean }
 * Standard: deltaPriority=1, incCnt=true
 * UPSERT: existiert (eng,ger) -> priority += delta, cnt += inc; sonst anlegen.
 */
app.post("/api/vocab/save", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL missing" });
  try {
    const eng = (req.body?.eng || "").toString().trim().toLowerCase();
    const ger = (req.body?.ger || "").toString().trim();
    const deltaPriority = Number.isFinite(req.body?.deltaPriority) ? Number(req.body.deltaPriority) : 1;
    const incCnt = req.body?.incCnt === false ? 0 : 1;

    if (!eng || !ger) return res.status(400).json({ error: "eng and ger required" });

    const sql = `
      INSERT INTO vocab (eng, ger, priority, cnt)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (eng, ger)
      DO UPDATE SET
        priority = vocab.priority + EXCLUDED.priority,
        cnt = vocab.cnt + EXCLUDED.cnt
      RETURNING eng, ger, priority, cnt;
    `;
    const params = [eng, ger, deltaPriority, incCnt];
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    console.error("/api/vocab/save error:", e);
    res.status(500).json({ error: "save failed" });
  }
});

/** POST /api/vocab/merge
 * body: { eng, options: string[] }
 * Fügt fehlende Synonyme mit priority=0, cnt=0 hinzu (keine Zählererhöhung).
 */
app.post("/api/vocab/merge", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL missing" });
  try {
    const eng = (req.body?.eng || "").toString().trim().toLowerCase();
    const options = Array.isArray(req.body?.options) ? req.body.options : [];

    if (!eng || !options.length) return res.json({ ok: true, inserted: 0 });

    // Deduplizieren & leere raus
    const cleaned = Array.from(
      new Set(options.map((o) => (o || "").toString().trim()).filter(Boolean))
    );

    if (!cleaned.length) return res.json({ ok: true, inserted: 0 });

    // Batch upsert
    const sql = `
      INSERT INTO vocab (eng, ger, priority, cnt)
      VALUES ${cleaned.map((_, i) => `($1, $${i + 2}, 0, 0)`).join(",")}
      ON CONFLICT (eng, ger) DO NOTHING
      RETURNING ger;
    `;
    const params = [eng, ...cleaned];
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, inserted: rows.length });
  } catch (e) {
    console.error("/api/vocab/merge error:", e);
    res.status(500).json({ error: "merge failed" });
  }
});

/** GET /api/vocab/top?eng=word
 * (optional) gibt Liste für ein Wort priorisiert zurück
 */
app.get("/api/vocab/top", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL missing" });
  try {
    const eng = (req.query?.eng || "").toString().trim().toLowerCase();
    if (!eng) return res.json({ items: [] });

    const sql = `
      SELECT ger, priority, cnt
      FROM vocab
      WHERE eng = $1
      ORDER BY priority DESC, ger ASC
      LIMIT 100
    `;
    const { rows } = await pool.query(sql, [eng]);
    res.json({ items: rows });
  } catch (e) {
    console.error("/api/vocab/top error:", e);
    res.status(500).json({ error: "top failed" });
  }
});

/* =========================================================
   Health
   ========================================================= */
app.get("/health", (req, res) => res.send("ok"));

/* =========================================================
   Static React Build ausliefern
   ========================================================= */
const clientBuildPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuildPath));
app.get("*", (req, res, next) => {
  // API-Routen nicht überschreiben
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
