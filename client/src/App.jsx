// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import {
  loadPriority,
  updatePriority,
  sortWithPriority,
} from "./priorityStore";

/** gleiche Origin wie das Frontend (Server liefert die API-Routen) */
const API_BASE = "";

/* ----------------- Hilfsfunktionen ----------------- */

const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);

/** Sehr defensive JSON-Parser-Hilfe */
function parseJSONSafe(txt, fallback) {
  try {
    const v = JSON.parse(txt);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Einfacher Tokenizer: Wörter + Satzzeichen als einzelne Tokens */
function tokenize(s) {
  return (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map((t) => ({ text: t }));
}

/** Heuristik: Kandidaten von DeepL sauber halten */
function cleanCandidates(list) {
  const bad = [
    /^januar\s+\d{4}\s*:?/i,
    /^februar\s+\d{4}\s*:?/i,
    /^märz\s+\d{4}\s*:?/i,
    /^april\s+\d{4}\s*:?/i,
    /^mai\s+\d{4}\s*:?/i,
    /^juni\s+\d{4}\s*:?/i,
    /^juli\s+\d{4}\s*:?/i,
    /^august\s+\d{4}\s*:?/i,
    /^september\s+\d{4}\s*:?/i,
    /^oktober\s+\d{4}\s*:?/i,
    /^november\s+\d{4}\s*:?/i,
    /^dezember\s+\d{4}\s*:?/i,
  ];
  const keepLen = (s) => s.trim().split(/\s+/).length <= 4;

  return (list || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .filter((s) => bad.every((rx) => !rx.test(s)))
    .filter(keepLen);
}

/* ----------------- Komponente ----------------- */

export default function App() {
  const [inputText, setInputText] = useState(
    `James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad.`
  );

  // Daten je Lernzeile
  const [lines, setLines] = useState([]);
  const [fullGermanText, setFullGermanText] = useState("");
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);

  // Tooltip-Steuerung
  const [hoverInfo, setHoverInfo] = useState({
    lineIdx: null,
    tokenIdx: null,
    overTooltip: false,
  });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef(Object.create(null));

  // Priority-Store (lokal im Browser)
  const [priorityState, setPriorityState] = useState(() => loadPriority());

  useEffect(() => {
    // Priority-State in localStorage persistieren
    try {
      // updatePriority übernimmt selbst das Speichern; hier nur Fallback, falls du mal direkt speicherst
      // (falls dein priorityStore bereits speichert, kannst du diesen Effekt weglassen)
    } catch {
      /* ignore */
    }
  }, [priorityState]);

  /* ---------------- Token-Ref Helper ---------------- */

  function registerTokenRef(lineIdx, tokenIdx, el) {
    const key = `${lineIdx}:${tokenIdx}`;
    if (!el) {
      delete tokenRefs.current[key];
    } else {
      tokenRefs.current[key] = el;
    }
  }

  function safeGetTokenEl(lineIdx, tokenIdx) {
    const key = `${lineIdx}:${tokenIdx}`;
    const el = tokenRefs.current[key];
    if (!el) return null;
    if (!document.body.contains(el)) return null;
    if (typeof el.getBoundingClientRect !== "function") return null;
    return el;
  }

  /* ---------------- Zeilen vorbereiten ---------------- */

  function handlePrepare() {
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
          translations[idx] = w;
          confirmed[idx] = true;
          opts[idx] = [w];
          return;
        }

        // Erstmal leer, füllen wir später über DeepL/DB
        translations[idx] = "";
        confirmed[idx] = false;
        opts[idx] = [];
      });

      return {
        tokens,
        translations,
        confirmed,
        translationOptions: opts,
        tokenMeta: meta,
      };
    });

    setLines(draft);
    setFullGermanText("");
  }

  /* ---------------- Volltext-Übersetzung ---------------- */

  async function handleFullTextTranslate() {
    try {
      setIsTranslatingFull(true);
      const r = await fetch(`${API_BASE}/api/translate/fulltext`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullText: inputText }),
      });
      if (!r.ok) {
        console.warn("fulltext HTTP error", r.status);
        return;
      }
      const d = await r.json();
      const txt = d?.translatedText || "";
      setFullGermanText(txt);
    } catch (e) {
      console.warn("fulltext failed", e);
    } finally {
      setIsTranslatingFull(false);
    }
  }

  /* ---------------- Einzelwort-Klick: DeepL + DB-Vorschläge ---------------- */

  function handleTokenClick(lineIdx, tokenIdx) {
    const line = lines[lineIdx];
    if (!line) return;
    const tok = line.tokens[tokenIdx];
    if (!tok) return;

    if (isPunctuation(tok.text) || line.tokenMeta?.[tokenIdx]?.isName) return;

    const englishWord = tok.text;
    const lower = englishWord.toLowerCase();
    const payload = { phraseText: englishWord, wantAlternatives: true };

    (async () => {
      try {
        // Parallel: DeepL + DB-Vorschläge
        const dlReq = fetch(`${API_BASE}/api/lookup/single`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const dbReq = fetch(
          `${API_BASE}/api/vocab/suggest?eng=${encodeURIComponent(
            lower
          )}&limit=25`
        );

        const [dlRes, dbRes] = await Promise.allSettled([dlReq, dbReq]);

        let primary = "";
        let alts = [];

        if (dlRes.status === "fulfilled" && dlRes.value.ok) {
          const j = await dlRes.value.json();
          primary = (j?.primary || "").trim();
          alts = cleanCandidates(j?.alternatives || []);
        }

        let dbOptions = [];
        if (dbRes.status === "fulfilled" && dbRes.value.ok) {
          const j2 = await dbRes.value.json();
          dbOptions = Array.isArray(j2?.options)
            ? j2.options
                .map((o) => (o?.ger || "").trim())
                .filter(Boolean)
            : [];
        }

        // Merge: DB zuerst, dann DeepL
        const merged = [...dbOptions, primary, ...alts];

        // Dedupe (case-insensitiv)
        const seen = new Set();
        const dedup = merged.filter((o) => {
          const k = (o || "").toLowerCase().trim();
          if (!k) return false;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        // Kopf (DB sortiert vom Server), Rest mit local priority sortieren
        const dbCount = dbOptions.length;
        const head = dedup.slice(0, dbCount);
        const tail = dedup.slice(dbCount);
        const tailSorted = sortWithPriority(priorityState, lower, tail);
        const finalOptions = [...head, ...tailSorted];

        setLines((prev) => {
          const copy = [...prev];
          const L = { ...copy[lineIdx] };
          const opts = [...(L.translationOptions || [])];
          const tr = [...(L.translations || [])];
          const cf = [...(L.confirmed || [])];

          opts[tokenIdx] = finalOptions;

          // Falls noch nichts gewählt: erste Option übernehmen
          if (!cf[tokenIdx] && finalOptions.length > 0) {
            tr[tokenIdx] = finalOptions[0];
            cf[tokenIdx] = true;
          }

          L.translationOptions = opts;
          L.translations = tr;
          L.confirmed = cf;
          copy[lineIdx] = L;
          return copy;
        });

        // primary als "Hint" in DB speichern (optional)
        if (primary) {
          try {
            fetch(`${API_BASE}/api/vocab/save`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                eng: lower,
                ger: primary,
              }),
            });
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        console.warn("DeepL single-word / DB failed:", e);
      }
    })();
  }

  /* ---------------- Tooltip-Logik ---------------- */

  function scheduleHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(
      () => setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false }),
      200
    );
  }

  function cancelHide() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }

  const onEnterToken = (li, ti) => {
    cancelHide();
    setHoverInfo({ lineIdx: li, tokenIdx: ti, overTooltip: false });
  };

  const onLeaveToken = () => {
    scheduleHide();
  };

  const onEnterTooltip = () => {
    cancelHide();
    setHoverInfo((h) => ({ ...h, overTooltip: true }));
  };

  const onLeaveTooltip = () => {
    scheduleHide();
  };

  function renderTooltip() {
    const { lineIdx, tokenIdx } = hoverInfo;
    if (lineIdx == null || tokenIdx == null) return null;
    if (!Array.isArray(lines) || lineIdx < 0 || lineIdx >= lines.length)
      return null;
    const line = lines[lineIdx];
    if (
      !line ||
      !Array.isArray(line.tokens) ||
      tokenIdx < 0 ||
      tokenIdx >= line.tokens.length
    )
      return null;
    if (line.tokenMeta?.[tokenIdx]?.isPunct) return null;

    const el = safeGetTokenEl(lineIdx, tokenIdx);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const scrollX =
      window.scrollX != null ? window.scrollX : document.documentElement.scrollLeft || 0;
    const scrollY =
      window.scrollY != null ? window.scrollY : document.documentElement.scrollTop || 0;

    const left = rect.left + scrollX;
    const top = rect.bottom + scrollY + 4;

    const options =
      line.translationOptions?.[tokenIdx]?.filter(Boolean) || [];

    const tooltipStyle = {
      position: "absolute",
      left,
      top,
      background: "#fff7d6",
      border: "1px solid #eab308",
      borderRadius: 8,
      boxShadow: "0 10px 20px rgba(15,23,42,0.25)",
      padding: "8px 10px",
      zIndex: 9999,
      minWidth: 120,
      maxWidth: 260,
      fontSize: 14,
    };

    const optionStyle = {
      cursor: "pointer",
      padding: "3px 6px",
      borderRadius: 4,
      marginBottom: 2,
      fontWeight: 500,
      lineHeight: 1.3,
    };

    const pick = (choice) => {
      if (!choice) return;
      const tok = line.tokens[tokenIdx];
      const lower = tok.text.toLowerCase();

      // Priority lokal
      const newState = updatePriority(priorityState, lower, choice);
      setPriorityState(newState);

      // Priority in DB / cnt
      try {
        fetch(`${API_BASE}/api/vocab/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eng: lower, ger: choice }),
        });
      } catch {
        /* noop */
      }

      setLines((prev) => {
        const copy = [...prev];
        const L = { ...copy[lineIdx] };
        const tr = [...(L.translations || [])];
        const cf = [...(L.confirmed || [])];
        tr[tokenIdx] = choice;
        cf[tokenIdx] = true;
        L.translations = tr;
        L.confirmed = cf;
        copy[lineIdx] = L;
        return copy;
      });

      setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
    };

    if (!options.length) return null;

    return (
      <div
        style={tooltipStyle}
        onMouseEnter={onEnterTooltip}
        onMouseLeave={onLeaveTooltip}
      >
        {options.map((opt, idx) => (
          <div
            key={idx}
            style={optionStyle}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(opt);
            }}
          >
            {opt}
          </div>
        ))}
      </div>
    );
  }

  /* ---------------- Render ---------------- */

  const page = {
    minHeight: "100vh",
    background: "#f6f7fb",
    color: "#0f172a",
    padding: 20,
    paddingBottom: 150,
  };
  const wrap = { maxWidth: 1000, margin: "0 auto" };
  const card = {
    background: "#fff",
    borderRadius: 16,
    padding: 20,
    boxShadow: "0 12px 30px rgba(15,23,42,0.12)",
    marginBottom: 20,
  };
  const h1 = { fontSize: 26, marginBottom: 10 };
  const h2 = { fontSize: 18, margin: "16px 0 8px" };

  return (
    <div style={page}>
      <div style={wrap}>
        <div style={card}>
          <h1 style={h1}>Birkenbihllab Trainer (EN → DE)</h1>
          <label style={{ fontWeight: 500 }}>Englischer Input-Text</label>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            style={{
              width: "100%",
              minHeight: 120,
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              border: "1px solid #cbd5f5",
              fontFamily: "monospace",
              fontSize: 14,
            }}
          />

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              onClick={handlePrepare}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: "none",
                background: "#3b82f6",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Zeilen vorbereiten
            </button>
            <button
              onClick={handleFullTextTranslate}
              disabled={isTranslatingFull}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: "none",
                background: "#0ea5e9",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                opacity: isTranslatingFull ? 0.7 : 1,
              }}
            >
              {isTranslatingFull ? "Übersetze…" : "Volltext übersetzen"}
            </button>
          </div>
        </div>

        <div style={card}>
          <h2 style={h2}>Zeilen & Tokens</h2>
          {lines.length === 0 && (
            <div style={{ color: "#64748b", fontSize: 14 }}>
              Klicke oben auf <b>„Zeilen vorbereiten“</b>, um zu starten.
            </div>
          )}
          {lines.length > 0 &&
            lines.map((line, li) => (
              <div
                key={li}
                style={{
                  padding: "6px 0",
                  borderBottom: "1px dashed #e2e8f0",
                  fontSize: 15,
                }}
              >
                {line.tokens.map((tok, ti) => {
                  const isPunct = line.tokenMeta?.[ti]?.isPunct;
                  const isConfirmed = !!line.confirmed?.[ti];
                  const ger = line.translations?.[ti] || "";
                  const color = isPunct
                    ? "#0f172a"
                    : isConfirmed
                    ? "#0f172a"
                    : "#64748b";

                  const wrapperStyle = {
                    display: "inline-block",
                    marginRight: isPunct ? 2 : 4,
                    cursor: isPunct ? "default" : "pointer",
                    padding: isPunct ? "0 0" : "0 2px",
                    borderRadius: 4,
                    background: isConfirmed ? "rgba(34,197,94,0.08)" : "none",
                  };

                  return (
                    <span
                      key={ti}
                      ref={(el) => registerTokenRef(li, ti, el)}
                      onMouseEnter={() => onEnterToken(li, ti)}
                      onMouseLeave={onLeaveToken}
                      onClick={() => handleTokenClick(li, ti)}
                      style={wrapperStyle}
                    >
                      <div style={{ color }}>{tok.text}</div>
                      {!isPunct && ger && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#16a34a",
                            lineHeight: 1.1,
                          }}
                        >
                          {ger}
                        </div>
                      )}
                    </span>
                  );
                })}
              </div>
            ))}
        </div>

        <div style={card}>
          <h2 style={h2}>Volltext-Übersetzung</h2>
          <textarea
            value={fullGermanText}
            readOnly
            style={{
              width: "100%",
              minHeight: 120,
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              border: "1px solid #cbd5f5",
              fontFamily: "monospace",
              fontSize: 14,
            }}
          />
        </div>
      </div>

      {renderTooltip()}
    </div>
  );
}
