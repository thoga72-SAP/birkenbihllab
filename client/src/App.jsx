import React, { useEffect, useRef, useState } from "react";

/** --- Mini-Wörterbuch als Fallback (wird mit VkblDB gemerged) --- */
const DICT = {
  quick: ["schnell", "rasch", "flink"],
  brown: ["braun"],
  fox: ["Fuchs"],
  lazy: ["faul", "träge"],
  dog: ["Hund"],
  prefer: ["bevorzugen", "vorziehen"],
  public: ["öffentlich", "allgemein"],
};

/** Häufig groß am Satzanfang, aber keine Eigennamen */
const COMMON_CAP_WORDS = new Set([
  "the","this","that","a","an","in","on","at","for","from","to","and","or","but",
  "if","when","while","as","with","by","of","is","are","was","were","it","he","she",
  "they","we","you","i"
]);

const API_BASE = ""; // gleiche Origin wie das Frontend

export default function App() {
  const [inputText, setInputText] = useState(
`James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad. Will they make it to their destination before sunset? Listen to find out what happens
and to learn some words and culture in the process.`
  );

  // Daten je Lernzeile
  const [lines, setLines] = useState([]);
  const [fullGermanText, setFullGermanText] = useState("");
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);

  // Vokabeldatenbank
  const [vocabMap, setVocabMap] = useState({});
  const [vocabLoaded, setVocabLoaded] = useState(false);

  // Tooltip-Status
  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef({});

  /* -------- Hilfen -------- */
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
    const articleLike = new Set(["a", "an", "the", "this", "that", "these", "those"]);
    const modalLike = new Set(["will","can","could","should","would","may","might","shall","must"]);
    if (articleLike.has(prev)) return "noun";
    if (prev === "to") return "verb";
    if (prev === "and" && articleLike.has(next)) return "verb";
    if (modalLike.has(prev) || modalLike.has(prev2)) return "verb";
    return "unknown";
  }

  function rankAndKeepAllMeanings(engWord, rawOptions, roleGuess) {
    const lowerEng = (engWord || "").toLowerCase();
    const looksVerb = (g) => /\b\w+(en|ern|eln)\b/.test((g||"").trim());
    const looksNoun = (g) => {
      const f = (g || "").trim().split(/\s+/)[0] || "";
      return f && f[0] === f[0].toUpperCase();
    };
    const overused = new Set(["bevorzugt", "bevorzugen"]);
    const isPreferish = /^(prefer|prefers|preferred|preference|favor)$/i.test(lowerEng);

    const scored = (rawOptions || []).map(opt => {
      const cleaned = String(opt || "").trim();
      if (!cleaned) return null;
      let score = 0;
      const wc = cleaned.split(/\s+/).length;
      if (wc <= 3) score += 1;
      if (wc === 1) score += 1;
      if (roleGuess === "verb" && looksVerb(cleaned)) score += 2;
      if (roleGuess === "noun" && looksNoun(cleaned)) score += 2;
      if (overused.has(cleaned.toLowerCase()) && !isPreferish) score -= 3;
      return { opt: cleaned, score };
    }).filter(Boolean);

    scored.sort((a, b) => (b.score - a.score) || a.opt.localeCompare(b.opt, "de"));
    const seen = new Set(); const result = [];
    for (const { opt } of scored) { const k = opt.toLowerCase(); if (seen.has(k)) continue; seen.add(k); result.push(opt); }
    return result;
  }

  const tokenize = (s) => (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map(t => ({ text: t }));

  /* -------- Vokabeldatei laden -------- */
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/VkblDB.txt");
        if (!r.ok) { setVocabLoaded(true); return; }
        let text = await r.text();
        text = text.replace(/^\uFEFF/, "");
        const map = Object.create(null);
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith("//")) continue;
          const m = line.match(/^([^#]+?)#(.*)$/);
          if (!m) continue;
          const eng = m[1].trim().toLowerCase();
          const ger = m[2].trim();
          if (!eng || !ger) continue;
          (map[eng] ||= []).includes(ger) || map[eng].push(ger);
        }
        setVocabMap(map);
      } catch (e) {
        console.warn("Vokabelladen fehlgeschlagen:", e);
      } finally {
        setVocabLoaded(true);
      }
    })();
  }, []);

  /* -------- Aufbereiten (mit DeepL-Kontext) -------- */
  async function handlePrepare() {
    // 1) Volltext-Kontext holen
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
    } catch (e) { console.warn("fulltext failed", e); }

    // 2) Zeilen/Tokens bilden + Startübersetzungen
    const englishLines = inputText.split(/\r?\n/);
    const draft = englishLines.map((ln, lineIdx) => {
      const tokens = tokenize(ln);
      const translations = [];
      const confirmed = [];
      const opts = [];
      const meta = [];
      const contextDE = deepLFull[lineIdx] || [];

      tokens.forEach((tok, idx) => {
        const w = tok.text; const lower = w.toLowerCase();
        const punct = isPunctuation(w); const isName = isLikelyName(w);
        meta[idx] = { isPunct: punct, isName };

        if (punct) { translations[idx] = w; confirmed[idx] = true; opts[idx] = [w]; return; }
        if (isName) { translations[idx] = w; confirmed[idx] = false; opts[idx] = [w]; return; }

        const fromFile = vocabMap[lower] || [];
        const fromBuiltIn = DICT[lower] || [];
        const mergedRaw = [...new Set([...fromFile, ...fromBuiltIn])];
        const role = guessRole(tokens, idx);
        const ranked = rankAndKeepAllMeanings(w, mergedRaw, role);

        // DeepL-Kandidat in der Nähe suchen (einfacher Heuristik-Fenster)
        let deepLCandidate = "";
        if (contextDE.length) {
          const check = [idx - 1, idx, idx + 1, idx + 2].filter(i => i >= 0 && i < contextDE.length).map(i => contextDE[i]);
          deepLCandidate = check.find(x => x && !/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)$/i.test(x)) || "";
        }

        let best = ranked[0] || "";
        if (deepLCandidate) {
          const i = ranked.findIndex(o => o.toLowerCase() === deepLCandidate.toLowerCase());
          if (i > 0) best = ranked[i];
          if (!best) best = deepLCandidate;
        }

        translations[idx] = best || "";
        confirmed[idx] = false;
        opts[idx] = ranked.length ? ranked : (best ? [best] : []);
      });

      // zu viele Wiederholungen derselben Übersetzung in EINER Zeile etwas streuen
      const freq = Object.create(null);
      translations.forEach(t => { if (t) freq[t] = (freq[t] || 0) + 1; });
      translations.forEach((t, i) => {
        if (!t) return;
        if (freq[t] >= 3 && opts[i] && opts[i].length > 1) {
          const alt = opts[i].find(o => o !== t);
          if (alt) { translations[i] = alt; freq[t]--; freq[alt] = (freq[alt] || 0) + 1; }
        }
      });

      return { tokens, translations, confirmed, translationOptions: opts, tokenMeta: meta };
    });

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

  /* -------- Tooltip -------- */
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

  function pick(lineIdx, tokenIdx, choice) {
    if (!choice || choice === "(keine Optionen)") return;
    setLines(prev => {
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = [...line.translations];
      const cf = [...line.confirmed];
      const opts = line.translationOptions.map(a => (a ? [...a] : []));
      tr[tokenIdx] = choice; cf[tokenIdx] = true;
      opts[tokenIdx] = [choice, ...opts[tokenIdx].filter(o => o !== choice)];
      line.translations = tr; line.confirmed = cf; line.translationOptions = opts;
      up[lineIdx] = line; return up;
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
    const fromState = line.translationOptions[tokenIdx] || [];
    const fromFile = vocabMap[lower] || [];
    const current = line.translations[tokenIdx] || "";

    let merged = []; if (current) merged.push(current);
    merged = merged.concat(fromState, fromFile);
    const seen = new Set();
    merged = merged.filter(o => { if (!o) return false; const k = o.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!merged.length) merged = ["(keine Optionen)"];

    const tip = {
      position: "absolute", left, top, zIndex: 9999,
      background: "#fff7d6", border: "1px solid #eab308",
      borderRadius: "8px", boxShadow: "0 10px 20px rgba(0,0,0,.15)",
      padding: "8px 10px", fontSize: 14, color: "#1f2937",
      minWidth: 160, maxWidth: 320, maxHeight: 220, overflowY: "auto"
    };
    const item = { cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1.4, fontWeight: 500 };

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        {merged.map((choice, i) => (
          <div key={i} style={item} onMouseDown={(e) => { e.preventDefault(); pick(lineIdx, tokenIdx, choice); }}
               onMouseOver={(e)=>{e.currentTarget.style.background="#fde68a"}}
               onMouseOut={(e)=>{e.currentTarget.style.background="transparent"}}>
            {choice}
          </div>
        ))}
      </div>
    );
  }

  /* -------- Render -------- */
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
    fontSize: 20, fontWeight: 600, cursor: "default"
  });

  return (
    <div style={{ minHeight: "100vh", background: "#f6f7fb", color: "#0f172a", padding: 20 }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Text einfügen → <b>Aufbereiten</b> → Mouseover zeigt alle Bedeutungen; Klick setzt deine Wahl fett.
          <br/>API: <code>{API_BASE}</code>
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
              disabled={!vocabLoaded}
              onClick={handlePrepare}
              style={{
                background: vocabLoaded ? "#2563eb" : "#9bb7ff",
                color: "white", border: 0, padding: "8px 12px",
                borderRadius: 12, fontWeight: 700, cursor: vocabLoaded ? "pointer" : "not-allowed"
              }}>
              {vocabLoaded ? "Aufbereiten" : "Vokabeln laden …"}
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

        <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
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
                          title={isPunctTok ? "" : "Mouseover für Optionen"}
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
