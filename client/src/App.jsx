import React, { useEffect, useRef, useState } from "react";

/** gleiche Origin wie das Frontend (Server liefert die API-Routen) */
const API_BASE = "";

/* ----------------- Hilfsfunktionen ----------------- */
const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);
const tokenize = (s) => (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map((t) => ({ text: t }));

/* ----------------- App-Komponente ----------------- */
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

  // Vokabeldatenbank (aus Datei)
  const [vocabMap, setVocabMap] = useState({});
  const [vocabLoaded, setVocabLoaded] = useState(false);

  // Tooltip-Status
  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef(Object.create(null));

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

  /* -------- Aufbereiten (mit DeepL-Volltext-Kontext) -------- */
  async function handlePrepare() {
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
        deepLFull = txt.split(/\r?\n/).map((s) => s.trim().split(/\s+/).filter(Boolean));
      }
    } catch (e) {
      console.warn("fulltext failed", e);
    }

    const englishLines = inputText.split(/\r?\n/);
    const draft = englishLines.map((ln, lineIdx) => {
      const tokens = tokenize(ln);
      const translations = [];
      const confirmed = [];
      const opts = [];
      const meta = [];
      const contextDE = deepLFull[lineIdx] || [];

      tokens.forEach((tok, idx) => {
        const w = tok.text;
        const lower = w.toLowerCase();
        const punct = isPunctuation(w);
        meta[idx] = { isPunct: punct, isName: false }; // (Namenserkennung hier aktuell nicht aktiv)

        if (punct) {
          translations[idx] = w;
          confirmed[idx] = true;
          opts[idx] = [w];
          return;
        }

        const fromFile = vocabMap[lower] || [];
        // Heuristik: falls DeepL-Kontext nah ein brauchbares Wort zeigt, nimm das als Start
        let deepLCandidate = "";
        if (contextDE.length) {
          const win = [idx - 1, idx, idx + 1, idx + 2].filter(i => i >= 0 && i < contextDE.length);
          deepLCandidate = win.map(i => contextDE[i]).find(x => x && !/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)$/i.test(x)) || "";
        }

        const best = fromFile[0] || deepLCandidate || "";
        translations[idx] = best;
        confirmed[idx] = false;
        const baseOpts = fromFile.length ? [...fromFile] : best ? [best] : [];
        opts[idx] = baseOpts;
      });

      // leichte Entdoppelung in EINER Zeile
      const freq = Object.create(null);
      translations.forEach((t) => { if (t) freq[t] = (freq[t] || 0) + 1; });
      translations.forEach((t, i) => {
        if (!t) return;
        if (freq[t] >= 3 && opts[i] && opts[i].length > 1) {
          const alt = opts[i].find((o) => o !== t);
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

  /* -------- Einzelwort-DeepL via Klick -------- */
  async function handleTokenClick(lineIdx, tokenIdx) {
    const line = lines[lineIdx];
    if (!line) return;
    const tok = line.tokens[tokenIdx];
    if (!tok || isPunctuation(tok.text)) return;

    const englishWord = tok.text;
    const fullLineContext = line.tokens.map((t) => t.text).join(" ");

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
        if (raw && !/^übersetze möglichst|translate/i.test(raw)) {
          let cleaned = raw.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
          const parts = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
          cleaned = parts.join(" ");
          if (cleaned && !newOptions.includes(cleaned)) newOptions.push(cleaned);
        }
      } catch (e) {
        console.warn("deepL single-word failed:", e);
      }
    }

    // zusätzlich: Alternativen aus dem Server (falls verfügbar)
    try {
      const altResp = await fetch(`${API_BASE}/api/alternatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phraseText: englishWord, contextText: fullLineContext }),
      });
      if (altResp.ok) {
        const d = await altResp.json();
        const alts = Array.isArray(d?.alternatives) ? d.alternatives : [];
        for (const a of alts) {
          const aa = String(a || "").trim();
          if (aa && !newOptions.includes(aa)) newOptions.push(aa);
        }
      }
    } catch {}

    if (!newOptions.length) return;

    // Ergebnis mergen + erste neue Option aktiv setzen
    setLines((prev) => {
      const up = [...prev];
      const ln = { ...up[lineIdx] };
      const tr = [...ln.translations];
      const cf = [...ln.confirmed];
      const opts = ln.translationOptions.map((a) => (a ? [...a] : []));

      const merged = [...opts[tokenIdx], ...newOptions];
      const seen = new Set();
      const dedup = merged.filter((o) => {
        const k = (o || "").toLowerCase().trim();
        if (!k) return false;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      tr[tokenIdx] = newOptions[0];
      cf[tokenIdx] = true;
      opts[tokenIdx] = dedup;

      ln.translations = tr;
      ln.confirmed = cf;
      ln.translationOptions = opts;
      up[lineIdx] = ln;
      return up;
    });
  }

  /* ---------------- Tooltip-Logik (stabil) ---------------- */
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

  function safeGetTokenEl(lineIdx, tokenIdx) {
    const key = `${lineIdx}-${tokenIdx}`;
    const el = tokenRefs.current[key];
    if (!el) return null;
    if (!document.body.contains(el)) return null;
    if (typeof el.getBoundingClientRect !== "function") return null;
    return el;
  }

  function handleManualEntry(lineIdx, tokenIdx) {
    const entered = window.prompt("Eigene Übersetzung eingeben:");
    const choice = (entered || "").trim();
    if (!choice) return;

    // Sofort übernehmen
    setLines((prev) => {
      const up = [...prev];
      const ln = { ...up[lineIdx] };
      const tr = [...ln.translations];
      const cf = [...ln.confirmed];
      const opts = ln.translationOptions.map((a) => (a ? [...a] : []));

      tr[tokenIdx] = choice;
      cf[tokenIdx] = true;

      const merged = [choice, ...opts[tokenIdx]];
      const seen = new Set();
      const dedup = merged.filter((o) => {
        const k = (o || "").toLowerCase().trim();
        if (!k) return false;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      opts[tokenIdx] = dedup;

      ln.translations = tr;
      ln.confirmed = cf;
      ln.translationOptions = opts;
      up[lineIdx] = ln;
      return up;
    });

    // Best-effort: an Server melden (optional persistieren)
    try {
      fetch(`${API_BASE}/api/vocab/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          english: (lines[lineIdx]?.tokens?.[tokenIdx]?.text || "").toLowerCase(),
          german: choice
        }),
      }).catch(() => {});
    } catch {}
  }

  function renderTooltip() {
    const { lineIdx, tokenIdx } = hoverInfo;
    if (lineIdx == null || tokenIdx == null) return null;
    if (!Array.isArray(lines) || lineIdx < 0 || lineIdx >= lines.length) return null;
    const line = lines[lineIdx];
    if (!line || !Array.isArray(line.tokens) || tokenIdx < 0 || tokenIdx >= line.tokens.length) return null;
    if (line.tokenMeta?.[tokenIdx]?.isPunct) return null;

    const el = safeGetTokenEl(lineIdx, tokenIdx);
    if (!el) return null;

    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return null; }
    const left = (rect?.left || 0) + window.scrollX;
    const top  = (rect?.bottom || 0) + window.scrollY + 4;

    const w = line.tokens[tokenIdx]?.text || "";
    const lower = w.toLowerCase();
    const fromState = Array.isArray(line.translationOptions?.[tokenIdx]) ? line.translationOptions[tokenIdx] : [];
    const fromFile  = Array.isArray(vocabMap[lower]) ? vocabMap[lower] : [];
    const current   = line.translations?.[tokenIdx] || "";

    // zusammenbauen
    let merged = [];
    if (current) merged.push(current);
    merged = merged.concat(fromState, fromFile);

    // Deduplizieren
    const seen = new Set();
    merged = merged.filter((o) => {
      if (!o) return false;
      const k = o.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Am Ende die manuelle Eingabe anbieten
    merged.push("➕ Manuelle Eingabe…");

    const tip = {
      position: "absolute",
      left, top, zIndex: 9999,
      background: "#fff7d6", border: "1px solid #eab308",
      borderRadius: "8px", boxShadow: "0 10px 20px rgba(0,0,0,.15)",
      padding: "8px 10px", fontSize: 14, color: "#1f2937",
      minWidth: 200, maxWidth: 360, maxHeight: 260, overflowY: "auto",
    };
    const item = { cursor: "pointer", padding: "4px 6px", borderRadius: 6, lineHeight: 1.4, fontWeight: 500 };

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
          Mouseover für Optionen · <b>Klick</b> auf EN-Wort = DeepL-Lookup
        </div>
        {merged.map((choice, i) => {
          const manual = choice === "➕ Manuelle Eingabe…";
          return (
            <div
              key={i}
              style={{ ...item, display: "flex", justifyContent: "space-between", gap: 8 }}
              onMouseDown={(e) => {
                e.preventDefault();
                if (manual) {
                  handleManualEntry(lineIdx, tokenIdx);
                } else {
                  pick(lineIdx, tokenIdx, choice);
                }
              }}
              onMouseOver={(e) => { e.currentTarget.style.background = "#fde68a"; }}
              onMouseOut={(e)  => { e.currentTarget.style.background = "transparent"; }}
            >
              <span>{choice}</span>
              {/* Platz für (künftig) Zähleranzeige rechts */}
            </div>
          );
        })}
      </div>
    );
  }

  function pick(lineIdx, tokenIdx, choice) {
    if (!choice || choice === "(keine Optionen)") return;
    setLines((prev) => {
      if (!Array.isArray(prev) || lineIdx < 0 || lineIdx >= prev.length) return prev;
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = Array.isArray(line.translations) ? [...line.translations] : [];
      const cf = Array.isArray(line.confirmed) ? [...line.confirmed] : [];
      const opts = Array.isArray(line.translationOptions) ? line.translationOptions.map((a) => (a ? [...a] : [])) : [];

      tr[tokenIdx] = choice;
      cf[tokenIdx] = true;
      opts[tokenIdx] = [choice, ...(opts[tokenIdx] || []).filter((o) => o !== choice)];

      line.translations = tr;
      line.confirmed = cf;
      line.translationOptions = opts;
      up[lineIdx] = line;
      return up;
    });

    // Best-effort: an Server melden (optional persistieren)
    try {
      fetch(`${API_BASE}/api/vocab/upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          english: (lines[lineIdx]?.tokens?.[tokenIdx]?.text || "").toLowerCase(),
          german: choice
        }),
      }).catch(() => {});
    } catch {}

    setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
  }

  /* ---------------- Render ---------------- */
  const page = { minHeight: "100vh", background: "#f6f7fb", color: "#0f172a", padding: 20, paddingBottom: 150 };
  const wrap = { maxWidth: 1000, margin: "0 auto" };
  const card = { background: "#fff", borderRadius: 16, boxShadow: "0 6px 18px rgba(0,0,0,.06)", padding: 16 };
  const badge = (selected) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid #d1d5db", background: selected ? "#fef3c7" : "#f3f4f6",
    marginTop: 6, fontSize: selected ? 18 : 14, fontWeight: selected ? 700 : 400,
  });
  const eng = () => ({
    display: "inline-block", padding: "2px 8px", borderRadius: 12,
    border: "1px solid transparent", background: "transparent",
    fontSize: 20, fontWeight: 600, cursor: "pointer",
  });

  return (
    <div style={page}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Text einfügen → <b>Aufbereiten</b> · Mouseover zeigt Optionen · <b>Klick</b> auf EN-Wort = DeepL-Lookup<br/>
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
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13,
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
                    const tr = line.translations?.[ti];
                    const isConfirmed = !!line.confirmed?.[ti];
                    const isPunctTok = !!line.tokenMeta?.[ti]?.isPunct;
                    return (
                      <div key={ti} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: "max-content" }}>
                        <span
                          ref={(el) => (tokenRefs.current[refKey] = el)}
                          style={eng()}
                          onMouseEnter={() => !isPunctTok && onEnter(li, ti)}
                          onMouseLeave={onLeave}
                          onClick={() => !isPunctTok && handleTokenClick(li, ti)}
                          title={isPunctTok ? "" : "Mouseover für Optionen · Klick = DeepL-Lookup"}
                        >
                          {tok.text}
                        </span>
                        <span style={badge(isConfirmed)}>
                          {isPunctTok ? tok.text : tr?.trim() || "_"}
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
