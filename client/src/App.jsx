// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";

/** gleiche Origin wie das Frontend (Server liefert die API-Routen) */
const API_BASE = "";

/* ----------------- Hilfsfunktionen ----------------- */

const COMMON_CAP_WORDS = new Set([
  "the","this","that","a","an","in","on","at","for","from","to","and","or","but",
  "if","when","while","as","with","by","of","is","are","was","were","it","he","she",
  "they","we","you","i"
]);

const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);

function isLikelyName(str) {
  if (!str || isPunctuation(str) || !/[A-Za-zÄÖÜäöüß]/.test(str)) return false;
  if (str === str.toUpperCase() && str.length > 1) return true; // WHO, UN
  const cap = str[0] === str[0].toUpperCase() && str.slice(1) === str.slice(1).toLowerCase();
  if (cap) return !COMMON_CAP_WORDS.has(str.toLowerCase());
  return false;
}

function guessRole(tokens, idx) {
  const prev = tokens[idx - 1]?.text?.toLowerCase() || "";
  const prev2 = tokens[idx - 2]?.text?.toLowerCase() || "";
  const next = tokens[idx + 1]?.text?.toLowerCase() || "";

  const articleLike = new Set(["a","an","the","this","that","these","those"]);
  const modalLike = new Set(["will","can","could","should","would","may","might","shall","must"]);

  if (articleLike.has(prev)) return "noun";
  if (prev === "to") return "verb";
  if (prev === "and" && articleLike.has(next)) return "verb";
  if (modalLike.has(prev) || modalLike.has(prev2)) return "verb";
  return "unknown";
}

function rankBase(engWord, rawOptions, roleGuess) {
  const lowerEng = (engWord || "").toLowerCase();
  const looksVerb = (g) => /\b\w+(en|ern|eln)\b/.test((g||"").trim());
  const looksNoun = (g) => {
    const f = (g || "").trim().split(/\s+/)[0] || "";
    return f && f[0] === f[0].toUpperCase();
  };

  const scored = (rawOptions || []).map(opt => {
    const cleaned = String(opt || "").trim();
    if (!cleaned) return null;
    let score = 0;
    const wc = cleaned.split(/\s+/).length;
    if (wc <= 3) score += 1;
    if (wc === 1) score += 1;
    if (roleGuess === "verb" && looksVerb(cleaned)) score += 2;
    if (roleGuess === "noun" && looksNoun(cleaned)) score += 2;
    return { opt: cleaned, score };
  }).filter(Boolean);

  scored.sort((a, b) => (b.score - a.score) || a.opt.localeCompare(b.opt, "de"));
  const seen = new Set(); const result = [];
  for (const { opt } of scored) { const k = opt.toLowerCase(); if (seen.has(k)) continue; seen.add(k); result.push(opt); }
  return result;
}

const tokenize = (s) => (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map(t => ({ text: t }));

/* ----------------- App ----------------- */

export default function App() {
  const [inputText, setInputText] = useState(
`James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad. Will they make it to their destination before sunset? Listen to find out what happens
and to learn some words and culture in the process.`
  );

  const [lines, setLines] = useState([]);
  const [fullGermanText, setFullGermanText] = useState("");
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);

  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef({});

  // Vokabelbank (aus Datei optional – wird hier nicht mehr benötigt; DeepL+DB reichen)
  // -> Wir bauen direkt mit DB-Optionen.

  /* -------- Aufbereiten (holt Kontext von DeepL + DB-Optionen) -------- */
  async function handlePrepare() {
    // 1) Volltext bei DeepL
    let deepLFull = [];
    try {
      const r = await fetch(`${API_BASE}/api/translate/fulltext`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullText: inputText }),
      });
      if (r.ok) {
        const d = await r.json();
        const txt = d?.translatedText || "";
        setFullGermanText(txt);
        deepLFull = txt.split(/\r?\n/).map(s => s.trim().split(/\s+/).filter(Boolean));
      }
    } catch (e) {
      console.warn("fulltext failed", e);
    }

    // 2) Zeilen/Tokens + Startübersetzungen (mit DB-Optionen)
    const englishLines = inputText.split(/\r?\n/);
    const draft = [];

    for (let lineIdx = 0; lineIdx < englishLines.length; lineIdx++) {
      const ln = englishLines[lineIdx];
      const tokens = tokenize(ln);
      const translations = [];
      const confirmed = [];
      const opts = [];
      const meta = [];
      const contextDE = deepLFull[lineIdx] || [];

      for (let idx = 0; idx < tokens.length; idx++) {
        const tok = tokens[idx];
        const w = tok.text;
        const lower = w.toLowerCase();
        const punct = isPunctuation(w);
        const isName = isLikelyName(w);
        meta[idx] = { isPunct: punct, isName };

        if (punct) { translations[idx] = w; confirmed[idx] = true; opts[idx] = [w]; continue; }
        if (isName) { translations[idx] = w; confirmed[idx] = false; opts[idx] = [w]; continue; }

        // DB-Optionen holen
        let dbOptions = [];
        let dbCounts = {};
        try {
          const r = await fetch(`${API_BASE}/api/vocab?word=${encodeURIComponent(lower)}`);
          if (r.ok) {
            const d = await r.json();
            dbOptions = d.options || [];
            dbCounts = d.counts || {};
          }
        } catch {}

        // Basis-Ranking + DeepL-Nachbarschaft
        const role = guessRole(tokens, idx);
        const rankedBase = rankBase(w, dbOptions, role);

        let deepLCandidate = "";
        if (contextDE.length) {
          const win = [idx - 1, idx, idx + 1, idx + 2].filter(i => i >= 0 && i < contextDE.length);
          const cands = win.map(i => contextDE[i]).filter(Boolean);
          deepLCandidate = cands.find(x => !/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)$/i.test(x)) || "";
        }

        let best = rankedBase[0] || "";
        if (deepLCandidate) {
          const i = rankedBase.findIndex(o => o.toLowerCase() === deepLCandidate.toLowerCase());
          if (i > 0) best = rankedBase[i];
          if (!best) best = deepLCandidate;
          if (best && !rankedBase.includes(best)) rankedBase.unshift(best);
        }

        // Nach DB-Counts sortieren (desc), dann alphabetisch
        const sortedByCount = [...new Set(rankedBase)].sort((a, b) => {
          const ca = Number(dbCounts[a] || 0);
          const cb = Number(dbCounts[b] || 0);
          if (cb !== ca) return cb - ca;
          return a.localeCompare(b, "de");
        });

        translations[idx] = best || "";
        confirmed[idx] = false;
        opts[idx] = sortedByCount.length ? sortedByCount : (best ? [best] : []);
      }

      draft.push({ tokens, translations, confirmed, translationOptions: opts, tokenMeta: meta });
    }

    setLines(draft);
  }

  /* -------- Volltext-Button -------- */
  async function handleFullTextTranslate() {
    try {
      setIsTranslatingFull(true);
      const r = await fetch(`${API_BASE}/api/translate/fulltext`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullText: inputText }),
      });
      const d = await r.json();
      setFullGermanText(d?.translatedText || "(kein Ergebnis)");
    } catch {
      setFullGermanText("(Fehler)");
    } finally {
      setIsTranslatingFull(false);
    }
  }

  /* -------- Einzelwort-DeepL via Klick -------- */
  async function handleTokenClick(lineIdx, tokenIdx) {
    const ln = lines[lineIdx];
    if (!ln) return;
    const tok = ln.tokens[tokenIdx];
    if (!tok || isPunctuation(tok.text) || ln.tokenMeta[tokenIdx]?.isName) return;

    const englishWord = tok.text;
    const fullLineContext = ln.tokens.map(t => t.text).join(" ");

    const variants = [englishWord, englishWord.toLowerCase()];
    const newOptions = [];

    for (const v of variants) {
      try {
        const resp = await fetch(`${API_BASE}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phraseText: v, contextText: fullLineContext }),
        });
        const data = await resp.json();
        const raw = (data?.translatedText || "").trim();
        if (raw) {
          const cleaned = raw.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
          const parts = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
          const out = parts.join(" ");
          if (out && !newOptions.includes(out)) newOptions.push(out);
        }
      } catch (e) {
        console.warn("deepL single-word failed:", e);
      }
    }

    if (!newOptions.length) return;

    // DB: gewählte erste Option zählen, alle Optionen hinzufügen
    const lower = englishWord.toLowerCase();
    try {
      await fetch(`${API_BASE}/api/vocab/upsertMany`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: lower, options: newOptions }),
      });
      await fetch(`${API_BASE}/api/vocab/choose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: lower, choice: newOptions[0] }),
      });
    } catch {}

    // State aktualisieren
    setLines(prev => {
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = [...line.translations];
      const cf = [...line.confirmed];
      const opts = line.translationOptions.map(a => (a ? [...a] : []));

      const seen = new Set(opts[tokenIdx].map(o => o.toLowerCase()));
      for (const o of newOptions) if (!seen.has(o.toLowerCase())) opts[tokenIdx].push(o);

      tr[tokenIdx] = newOptions[0];
      cf[tokenIdx] = true;
      line.translations = tr;
      line.confirmed = cf;
      line.translationOptions = opts;
      up[lineIdx] = line;
      return up;
    });
  }

  /* ---------------- Tooltip ---------------- */

  function scheduleHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false }), 200);
  }
  function cancelHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }
  const onEnter = (li, ti) => { cancelHide(); setHoverInfo({ lineIdx: li, tokenIdx: ti, overTooltip: false }); };
  const onLeave = () => { if (!hoverInfo.overTooltip) scheduleHide(); };
  const tipEnter = () => { cancelHide(); setHoverInfo(p => ({ ...p, overTooltip: true })); };
  const tipLeave = () => scheduleHide();

  async function pick(lineIdx, tokenIdx, choice) {
    if (!choice) return;

    // manuelle Eingabe?
    if (choice === "__MANUAL__") {
      const entered = window.prompt("Eigene Übersetzung eingeben:");
      const t = (entered || "").trim();
      if (!t) return;

      const word = lines[lineIdx].tokens[tokenIdx].text.toLowerCase();
      try {
        await fetch(`${API_BASE}/api/vocab/manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word, translation: t, increment: true }),
        });
      } catch {}

      setLines(prev => {
        const up = [...prev];
        const ln = { ...up[lineIdx] };
        const tr = [...ln.translations];
        const cf = [...ln.confirmed];
        const opts = ln.translationOptions.map(a => (a ? [...a] : []));
        if (!opts[tokenIdx].some(o => o.toLowerCase() === t.toLowerCase())) opts[tokenIdx].push(t);
        tr[tokenIdx] = t; cf[tokenIdx] = true;
        ln.translations = tr; ln.confirmed = cf; ln.translationOptions = opts;
        up[lineIdx] = ln;
        return up;
      });
      setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
      return;
    }

    // normale Auswahl -> zählen
    const word = lines[lineIdx].tokens[tokenIdx].text.toLowerCase();
    try {
      await fetch(`${API_BASE}/api/vocab/choose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word, choice }),
      });
    } catch {}

    setLines(prev => {
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = [...line.translations];
      const cf = [...line.confirmed];
      const opts = line.translationOptions.map(a => (a ? [...a] : []));
      tr[tokenIdx] = choice; cf[tokenIdx] = true;
      // Wahl nach vorn
      opts[tokenIdx] = [choice, ...opts[tokenIdx].filter(o => o !== choice)];
      line.translations = tr; line.confirmed = cf; line.translationOptions = opts;
      up[lineIdx] = line;
      return up;
    });
    setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
  }

  function renderTooltip() {
    const { lineIdx, tokenIdx } = hoverInfo;
    if (lineIdx == null || tokenIdx == null) return null;
    const key = `${lineIdx}-${tokenIdx}`;
    const el = tokenRefs.current[key]; if (!el) return null;
    const rect = el.getBoundingClientRect();
    const left = rect.left + window.scrollX, top = rect.bottom + window.scrollY + 4;
    const line = lines[lineIdx]; if (!line) return null;
    if (line.tokenMeta[tokenIdx]?.isPunct) return null;

    const w = line.tokens[tokenIdx]?.text || "";
    const lower = w.toLowerCase();

    const items = (line.translationOptions[tokenIdx] || []).filter(Boolean);
    // “manuelle Eingabe …” anhängen
    items.push("__MANUAL__");

    const tip = {
      position: "absolute", left, top, zIndex: 9999,
      background: "#fff7d6", border: "1px solid #eab308",
      borderRadius: "8px", boxShadow: "0 10px 20px rgba(0,0,0,.15)",
      padding: "8px 10px", fontSize: 14, color: "#1f2937",
      minWidth: 220, maxWidth: 360, maxHeight: 280, overflowY: "auto"
    };

    // kleine Count-Ansicht rechts
    const row = {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, cursor: "pointer", padding: "6px 8px", borderRadius: 6, lineHeight: 1.4, fontWeight: 500
    };
    const badge = {
      fontSize: 12, padding: "0 8px", borderRadius: 999,
      background: "#fde68a", border: "1px solid #f59e0b", color: "#7c2d12"
    };

    // Counts live holen (leichtgewichtig – optional)
    const [counts, setCounts] = React.useState({});
    React.useEffect(() => {
      let mounted = true;
      (async () => {
        try {
          const r = await fetch(`${API_BASE}/api/vocab?word=${encodeURIComponent(lower)}`);
          const d = await r.json();
          if (mounted) setCounts(d.counts || {});
        } catch {}
      })();
      return () => { mounted = false; };
    }, [lower]);

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={{fontSize:12, color:"#6b7280", marginBottom:6}}>
          Mouseover für Optionen / <b>Klick</b> zählt & setzt – oder “manuelle Eingabe …”
        </div>
        {items.map((choice, i) => {
          const label = (choice === "__MANUAL__") ? "✍️ manuelle Eingabe …" : choice;
          const cnt = counts && choice !== "__MANUAL__" ? (counts[choice] || 0) : null;
          return (
            <div key={i}
                 style={row}
                 onMouseDown={(e) => { e.preventDefault(); pick(lineIdx, tokenIdx, choice); }}
                 onMouseOver={(e)=>{e.currentTarget.style.background="#fef3c7"}}
                 onMouseOut={(e)=>{e.currentTarget.style.background="transparent"}}>
              <span>{label}</span>
              {cnt !== null && <span style={badge}>{cnt}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  /* ---------------- Render ---------------- */

  const page = { minHeight: "100vh", background: "#f6f7fb", color: "#0f172a", padding: 20, paddingBottom: 160 };
  const wrap = { maxWidth: 1000, margin: "0 auto" };
  const card = { background: "#fff", borderRadius: 16, boxShadow: "0 6px 18px rgba(0,0,0,.06)", padding: 16 };
  const badge = (selected) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid #d1d5db", background: selected ? "#fef3c7" : "#f3f4f6",
    marginTop: 6, fontSize: selected ? 18 : 14, fontWeight: selected ? 700 : 400
  });
  const eng = (isName) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: `1px solid ${isName ? "#93c5fd" : "transparent"}`,
    background: isName ? "#dbeafe" : "transparent",
    fontSize: 20, fontWeight: 600, cursor: "pointer"
  });

  return (
    <div style={page}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Text einfügen → <b>Aufbereiten</b> → Mouseover zeigt Optionen aus DB/DeepL.<br/>
          <b>Klick</b> zählt deine Wahl (und sortiert sie nach oben). <br/>
          API: <code>{API_BASE || "(same origin)"}</code>
        </p>

        <div style={card}>
          <label style={{ fontSize: 14, fontWeight: 600 }}>Englischer Text (jede Zeile wird separat gelernt):</label>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            style={{
              width: "100%", minHeight: 120, marginTop: 8, padding: 10,
              borderRadius: 12, border: "1px solid #cbd5e1", background: "#f8fafc",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13
            }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <button
              onClick={handlePrepare}
              style={{
                background: "#2563eb", color: "white", border: 0, padding: "8px 12px",
                borderRadius: 12, fontWeight: 700, cursor: "pointer"
              }}>
              Aufbereiten
            </button>
            <button
              disabled={isTranslatingFull}
              onClick={handleFullTextTranslate}
              style={{ background: "#16a34a", color: "white", border: 0, padding: "8px 12px", borderRadius: 12, fontWeight: 700, cursor: "pointer" }}>
              {isTranslatingFull ? "Übersetze…" : "Gesamten Text auf Deutsch"}
            </button>
          </div>

          {fullGermanText && (
            <div style={{ ...card, marginTop: 12, border: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Vollständige Kontext-Übersetzung (DeepL):</div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{fullGermanText}</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16, display: "grid", gap: 16, paddingBottom: 40 }}>
          {lines.length === 0 ? (
            <div style={{ color: "#64748b", fontStyle: "italic" }}>(Noch nichts aufbereitet)</div>
          ) : (
            lines.map((line, li) => (
              <div key={li} style={card}>
                <div style={{ display: "flex", flexWrap: "wrap", columnGap: 16, rowGap: 20, alignItems: "flex-start" }}>
                  {line.tokens.map((tok, ti) => {
                    const refKey = `${li}-${ti}`;
                    const tr = line.translations[ti];
                    const isConfirmed = line.confirmed[ti];
                    const meta = line.tokenMeta[ti] || {};
                    const isName = meta.isName, isPunctTok = meta.isPunct;

                    return (
                      <div key={ti} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: "max-content" }}>
                        <span
                          ref={(el) => (tokenRefs.current[refKey] = el)}
                          style={eng(isName)}
                          onMouseEnter={() => !isPunctTok && onEnter(li, ti)}
                          onMouseLeave={onLeave}
                          onClick={() => !isPunctTok && handleTokenClick(li, ti)}
                          title={isPunctTok ? "" : "Mouseover: Optionen • Klick: DeepL-Lookup"}
                        >
                          {tok.text}
                        </span>
                        <span style={badge(isConfirmed)}>
                          {isPunctTok ? tok.text : (tr && tr.trim() !== "" ? tr : "_")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {renderTooltip()}
    </div>
  );
}
