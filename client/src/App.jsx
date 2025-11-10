// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";

/** gleiche Origin wie das Frontend (Server liefert die API-Routen) */
const API_BASE = "";

/* ----------------- Helpers ----------------- */
const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);
const tokenize = (s) => (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map((t) => ({ text: t }));

// dedup + sort by length then alphabetically
function normalizeOptions(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = (s || "").trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  out.sort((a, b) => (a.split(/\s+/).length - b.split(/\s+/).length) || a.localeCompare(b, "de"));
  return out;
}

/* ----------------- Component ----------------- */
export default function App() {
  const [inputText, setInputText] = useState(
`James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad. Will they make it to their destination before sunset? Listen to find out what happens
and to learn some words and culture in the process.`
  );

  const [lines, setLines] = useState([]);
  const [fullGermanText, setFullGermanText] = useState("");
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);
  const [vocabMap, setVocabMap] = useState({});
  const [vocabLoaded, setVocabLoaded] = useState(false);

  // Tooltip
  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef(Object.create(null));

  /* ---- Vokabeldatei laden (Fallback) ---- */
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

  /* ---- Aufbereiten ---- */
  async function handlePrepare() {
    // 1) Volltext für Kontext
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

    // 2) Tokenisieren & Vorschläge aus Datei
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
        meta[idx] = { isPunct: punct, isName: false };

        if (punct) {
          translations[idx] = w; confirmed[idx] = true; opts[idx] = [w];
          return;
        }
        const fromFile = vocabMap[lower] || [];
        translations[idx] = fromFile[0] || "";
        confirmed[idx] = false;
        opts[idx] = fromFile.length ? [...fromFile] : [];
      });

      return { tokens, translations, confirmed, translationOptions: opts, tokenMeta: meta };
    });

    setLines(draft);
  }

  /* ---- Volltext-Button ---- */
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

  /* ---- Einzelwort: DeepL + Alternativen ---- */
  /* -------- Einzelwort-DeepL via Klick (bereinigt + Alternativen) -------- */
async function handleTokenClick(lineIdx, tokenIdx) {
  const line = lines[lineIdx];
  if (!line) return;
  const tok = line.tokens[tokenIdx];
  if (!tok || isPunctuation(tok.text) || line.tokenMeta?.[tokenIdx]?.isName) return;

  const englishWord = tok.text;
  const fullLineContext = line.tokens.map(t => t.text).join(" ");

  try {
    const resp = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phraseText: englishWord,
        contextText: fullLineContext
      })
    });
    if (!resp.ok) return;

    const data = await resp.json();
    // Server liefert bereits gereinigt:
    //   data.translatedText  (string)
    //   data.alts            (array, erster ist identisch mit translatedText)
    const main = (data?.translatedText || "").trim();
    const alts = Array.isArray(data?.alts) ? data.alts : [];

    if (!main && !alts.length) return;

    setLines(prev => {
      const up = [...prev];
      const ln = { ...up[lineIdx] };

      const tr = Array.isArray(ln.translations) ? [...ln.translations] : [];
      const cf = Array.isArray(ln.confirmed) ? [...ln.confirmed] : [];
      const opts = Array.isArray(ln.translationOptions)
        ? ln.translationOptions.map(a => (a ? [...a] : []))
        : [];

      // merge: existierende Optionen + neue Alternativen
      const merged = [...(opts[tokenIdx] || [])];
      for (const a of alts) {
        const k = (a || "").toLowerCase();
        if (k && !merged.some(m => (m || "").toLowerCase() === k)) {
          merged.push(a);
        }
      }

      // setze Hauptübersetzung
      if (main) {
        tr[tokenIdx] = main;
        cf[tokenIdx] = true;
        // stelle sicher, dass main ganz vorne steht
        const withoutMain = merged.filter(x => (x || "").toLowerCase() !== main.toLowerCase());
        opts[tokenIdx] = [main, ...withoutMain];
      } else {
        opts[tokenIdx] = merged;
      }

      ln.translations = tr;
      ln.confirmed = cf;
      ln.translationOptions = opts;
      up[lineIdx] = ln;
      return up;
    });
  } catch (e) {
    console.warn('DeepL click failed:', e);
  }
}

  /* ---- Tooltip ---- */
  function scheduleHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false }), 180);
  }
  function cancelHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }
  const onEnter = (li, ti) => { cancelHide(); setHoverInfo({ lineIdx: li, tokenIdx: ti, overTooltip: false }); };
  const onLeave = () => { if (!hoverInfo.overTooltip) scheduleHide(); };
  const tipEnter = () => { cancelHide(); setHoverInfo(p => ({ ...p, overTooltip: true })); };
  const tipLeave = () => scheduleHide();

  function renderTooltip() {
    const { lineIdx, tokenIdx } = hoverInfo;
    if (lineIdx == null || tokenIdx == null) return null;

    const key = `${lineIdx}-${tokenIdx}`;
    const el = tokenRefs.current[key];
    if (!el || !document.body.contains(el) || typeof el.getBoundingClientRect !== "function") return null;

    const rect = el.getBoundingClientRect();
    const left = rect.left + window.scrollX;
    const top = rect.bottom + window.scrollY + 4;

    const line = lines[lineIdx];
    if (!line || line.tokenMeta[tokenIdx]?.isPunct) return null;

    const w = line.tokens[tokenIdx]?.text || "";
    const lower = w.toLowerCase();

    const fromState = Array.isArray(line.translationOptions[tokenIdx]) ? line.translationOptions[tokenIdx] : [];
    const fromFile = Array.isArray(vocabMap[lower]) ? vocabMap[lower] : [];
    const current = (line.translations[tokenIdx] || "").trim();

    const merged = normalizeOptions([current, ...fromState, ...fromFile].filter(Boolean));

    const tip = {
      position: "absolute", left, top, zIndex: 9999,
      background: "#fff7d6", border: "1px solid #eab308",
      borderRadius: "8px", boxShadow: "0 10px 20px rgba(0,0,0,.15)",
      padding: "8px 10px", fontSize: 14, color: "#1f2937",
      minWidth: 180, maxWidth: 340, maxHeight: 260, overflowY: "auto"
    };
    const item = { cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1.4, fontWeight: 500 };

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
          Mouseover = Optionen • <b>Klick</b> auf EN-Wort holt DeepL-Alternativen
        </div>
        {merged.length ? merged.map((choice, i) => (
          <div key={i}
               style={item}
               onMouseDown={(e) => { e.preventDefault(); pick(lineIdx, tokenIdx, choice); }}
               onMouseOver={(e) => (e.currentTarget.style.background = "#fde68a")}
               onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}>
            {choice}
          </div>
        )) : <div style={{ fontStyle: "italic", color: "#64748b" }}>(keine Optionen)</div>}
      </div>
    );
  }

  function pick(lineIdx, tokenIdx, choice) {
    if (!choice) return;
    setLines(prev => {
      const up = [...prev];
      const ln = { ...up[lineIdx] };
      const tr = [...ln.translations];
      const cf = [...ln.confirmed];
      const opts = ln.translationOptions.map(a => (a ? [...a] : []));
      tr[tokenIdx] = choice; cf[tokenIdx] = true;
      opts[tokenIdx] = normalizeOptions([choice, ...opts[tokenIdx]]);
      ln.translations = tr; ln.confirmed = cf; ln.translationOptions = opts;
      up[lineIdx] = ln; return up;
    });
    setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
  }

  /* ---- Render ---- */
  const page = { minHeight: "100vh", background: "#f6f7fb", color: "#0f172a", padding: 20, paddingBottom: 150 };
  const wrap = { maxWidth: 1000, margin: "0 auto" };
  const card = { background: "#fff", borderRadius: 16, boxShadow: "0 6px 18px rgba(0,0,0,.06)", padding: 16 };
  const badge = (sel) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid #d1d5db", background: sel ? "#fef3c7" : "#f3f4f6",
    marginTop: 6, fontSize: sel ? 18 : 14, fontWeight: sel ? 700 : 400
  });
  const eng = () => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid transparent",
    background: "transparent", fontSize: 20, fontWeight: 600, cursor: "pointer"
  });

  return (
    <div style={page}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Text einfügen → <b>Aufbereiten</b>. Mouseover zeigt Optionen, <b>Klick</b> auf das EN-Wort holt DeepL-Alternativen.
          <br/>API: <code>{API_BASE || "(same origin)"}</code>
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
              style={{ background: vocabLoaded ? "#2563eb" : "#9bb7ff", color: "white", border: 0, padding: "8px 12px",
                       borderRadius: 12, fontWeight: 700, cursor: vocabLoaded ? "pointer" : "not-allowed" }}>
              {vocabLoaded ? "Aufbereiten" : "Vokabeln laden …"}
            </button>
            <button
              disabled={isTranslatingFull}
              onClick={handleFullTextTranslate}
              style={{ background: "#16a34a", color: "white", border: 0, padding: "8px 12px", borderRadius: 12, fontWeight: 700 }}>
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
                    const tr = line.translations[ti] || "";
                    const isConfirmed = !!line.confirmed[ti];
                    const isPunctTok = !!line.tokenMeta[ti]?.isPunct;

                    return (
                      <div key={ti} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: "max-content" }}>
                        <span
                          ref={(el) => (tokenRefs.current[refKey] = el)}
                          style={eng()}
                          onMouseEnter={() => !isPunctTok && onEnter(li, ti)}
                          onMouseLeave={onLeave}
                          onClick={() => !isPunctTok && handleTokenClick(li, ti)}
                          title={isPunctTok ? "" : "Klick = DeepL-Alternativen"}>
                          {tok.text}
                        </span>
                        <span style={badge(isConfirmed)}>{isPunctTok ? tok.text : (tr || "_")}</span>
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
