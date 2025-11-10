// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";

/* gleiche Origin: Backend liefert /api/... */
const API_BASE = "";

/* -------- Helpers -------- */
const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);
const tokenize = (s) =>
  (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map((t) => ({ text: t }));

/* -------- App -------- */
export default function App() {
  const [inputText, setInputText] = useState(
`James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad. Will they make it to their destination before sunset? Listen to find out what happens
and to learn some words and culture in the process.`
  );

  const [lines, setLines] = useState([]);
  const [fullGermanText, setFullGermanText] = useState("");
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);

  // (Datei-)Vokabelliste als Fallback
  const [vocabMap, setVocabMap] = useState({});
  const [vocabLoaded, setVocabLoaded] = useState(false);

  // Tooltip
  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef(Object.create(null));

  /* ------ Vokabeldatei laden (optional) ------ */
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/VkblDB.txt");
        if (!r.ok) { setVocabLoaded(true); return; }
        let text = await r.text();
        text = text.replace(/^\uFEFF/, "");
        const map = Object.create(null);
        for (const raw of text.split(/\r?\n/)) {
          const row = raw.trim();
          if (!row || row.startsWith("//")) continue;
          const m = row.match(/^([^#]+?)#(.*)$/);
          if (!m) continue;
          const eng = m[1].trim().toLowerCase();
          const ger = m[2].trim();
          (map[eng] ||= []).includes(ger) || map[eng].push(ger);
        }
        setVocabMap(map);
      } catch (e) {
        console.warn("Vokabel laden fehlgeschlagen:", e);
      } finally {
        setVocabLoaded(true);
      }
    })();
  }, []);

  /* ------ Aufbereiten mit Volltext-Kontext (nur für Anzeige oben) ------ */
  async function handlePrepare() {
    // Volltext für Anzeige
    try {
      const r = await fetch(`${API_BASE}/api/translate/fulltext`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullText: inputText }),
      });
      const d = await r.json();
      setFullGermanText(d?.translatedText || "");
    } catch (e) {
      setFullGermanText("(Fehler bei DeepL Volltext)");
    }

    // Tokenisierung & Startwerte pro Zeile
    const englishLines = inputText.split(/\r?\n/);
    const draft = englishLines.map((ln) => {
      const tokens = tokenize(ln);
      const translations = [];
      const confirmed = [];
      const opts = [];
      const meta = [];

      tokens.forEach((tok, idx) => {
        const w = tok.text;
        const lower = w.toLowerCase();
        const punct = isPunctuation(w);
        meta[idx] = { isPunct: punct };

        if (punct) {
          translations[idx] = w;
          confirmed[idx] = true;
          opts[idx] = [w];
          return;
        }
        const fromFile = vocabMap[lower] || [];
        const best = fromFile[0] || "";
        translations[idx] = best;
        confirmed[idx] = false;
        opts[idx] = fromFile.length ? [...fromFile] : best ? [best] : [];
      });

      return { tokens, translations, confirmed, translationOptions: opts, tokenMeta: meta };
    });

    setLines(draft);
  }

  /* ------ Volltextbutton ------ */
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

  /* ------ Klick auf ein Wort: Einzelwort ohne Kontext ------ */
  async function handleTokenClick(lineIdx, tokenIdx) {
    const line = lines[lineIdx];
    if (!line) return;
    const tok = line.tokens[tokenIdx];
    if (!tok || line.tokenMeta[tokenIdx]?.isPunct) return;

    const englishWord = tok.text;

    try {
      const resp = await fetch(`${API_BASE}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phraseText: englishWord }),
      });
      const data = await resp.json();
      const core = (data?.translatedText || "").trim();
      const alts = Array.isArray(data?.alts) ? data.alts : [];

      if (!core && !alts.length) return;

      setLines((prev) => {
        const up = [...prev];
        const ln = { ...up[lineIdx] };
        const tr = [...ln.translations];
        const cf = [...ln.confirmed];
        const opts = ln.translationOptions.map((a) => (a ? [...a] : []));

        const merged = [core, ...alts, ...opts[tokenIdx]].filter(Boolean);
        const seen = new Set();
        const dedup = merged.filter((o) => {
          const k = o.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        tr[tokenIdx] = core || dedup[0] || "";
        cf[tokenIdx] = true;
        opts[tokenIdx] = dedup;

        ln.translations = tr;
        ln.confirmed = cf;
        ln.translationOptions = opts;
        up[lineIdx] = ln;
        return up;
      });
    } catch (e) {
      console.warn("word translate failed", e);
    }
  }

  /* ------ Tooltip ------ */
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
  const tipEnter = () => { cancelHide(); setHoverInfo((p) => ({ ...p, overTooltip: true })); };
  const tipLeave = () => scheduleHide();

  function pick(lineIdx, tokenIdx, choice) {
    if (!choice || choice === "(keine Optionen)") return;
    if (choice === "__MANUAL__") {
      const t = prompt("Eigene Übersetzung eingeben:");
      if (!t) return;
      return pick(lineIdx, tokenIdx, t.trim());
    }
    setLines((prev) => {
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = [...line.translations];
      const cf = [...line.confirmed];
      const opts = line.translationOptions.map((a) => (a ? [...a] : []));
      tr[tokenIdx] = choice;
      cf[tokenIdx] = true;
      opts[tokenIdx] = [choice, ...opts[tokenIdx].filter((o) => o !== choice)];
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

    const fromState = line.translationOptions[tokenIdx] || [];
    const current = line.translations[tokenIdx] || "";
    let merged = []; if (current) merged.push(current);
    merged = merged.concat(fromState);

    const seen = new Set();
    merged = merged.filter((o) => {
      if (!o) return false;
      const k = o.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (!merged.length) merged = ["(keine Optionen)"];

    const tip = {
      position: "absolute", left, top, zIndex: 9999,
      background: "#fff7d6", border: "1px solid #eab308",
      borderRadius: "8px", boxShadow: "0 10px 20px rgba(0,0,0,.15)",
      padding: "8px 10px", fontSize: 14, color: "#1f2937",
      minWidth: 180, maxWidth: 320, maxHeight: 260, overflowY: "auto"
    };
    const item = { cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1.4, fontWeight: 500 };

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
          Mouseover: Optionen • Klick: DeepL-Kandidaten kommen automatisch dazu
        </div>
        {merged.map((choice, i) => (
          <div key={i} style={item}
               onMouseDown={(e)=>{e.preventDefault(); pick(lineIdx, tokenIdx, choice);}}
               onMouseOver={(e)=>{e.currentTarget.style.background="#fde68a"}}
               onMouseOut={(e)=>{e.currentTarget.style.background="transparent"}}>
            {choice}
          </div>
        ))}
        <hr style={{ border: 0, borderTop: "1px solid #facc15", margin: "6px 0" }} />
        <div style={{ ...item, fontStyle: "italic" }}
             onMouseDown={(e)=>{e.preventDefault(); pick(lineIdx, tokenIdx, "__MANUAL__");}}>
          Manuelle Eingabe…
        </div>
      </div>
    );
  }

  /* ------ Render ------ */
  const page = { minHeight: "100vh", background: "#f6f7fb", color: "#0f172a", padding: 20, paddingBottom: 150 };
  const wrap = { maxWidth: 1000, margin: "0 auto" };
  const card = { background: "#fff", borderRadius: 16, boxShadow: "0 6px 18px rgba(0,0,0,.06)", padding: 16 };
  const badge = (selected) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid #d1d5db", background: selected ? "#fef3c7" : "#f3f4f6",
    marginTop: 6, fontSize: selected ? 18 : 14, fontWeight: selected ? 700 : 400
  });
  const eng = () => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    background: "transparent", fontSize: 20, fontWeight: 600, cursor: "pointer"
  });

  return (
    <div style={page}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          <b>Aufbereiten</b> zum Start. Klick auf ein Wort: DeepL-Lookup (ohne Kontext) + Alternativen werden übernommen.
        </p>

        <div style={card}>
          <label style={{ fontSize: 14, fontWeight: 600 }}>Englischer Text (jede Zeile separat):</label>
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
                    const isPunctTok = line.tokenMeta[ti]?.isPunct;

                    return (
                      <div key={ti} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: "max-content" }}>
                        <span
                          ref={(el) => (tokenRefs.current[refKey] = el)}
                          style={eng()}
                          onMouseEnter={() => !isPunctTok && onEnter(li, ti)}
                          onMouseLeave={onLeave}
                          onClick={() => !isPunctTok && handleTokenClick(li, ti)}
                          title={isPunctTok ? "" : "Mouseover: Optionen • Klick: DeepL-Lookup"}
                        >
                          {tok.text}
                        </span>
                        <span style={badge(isConfirmed)}>
                          {isPunctTok ? tok.text : (tr && tr.trim()) || "_"}
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
