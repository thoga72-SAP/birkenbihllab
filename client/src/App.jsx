import React, { useEffect, useRef, useState } from "react";

/** gleiche Origin wie das Frontend (Server liefert die API-Routen) */
const API_BASE = "";

/* ----------------- Hilfen ----------------- */

const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);
const tokenize = (s) => (s.match(/(\w+|'\w+|[^\s\w]+)/g) || []).map(t => ({ text: t }));

function parseJSONSafe(txt, fallback) {
  try { const v = JSON.parse(txt); return v ?? fallback; } catch { return fallback; }
}

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

  // Tooltip
  const [hoverInfo, setHoverInfo] = useState({ lineIdx: null, tokenIdx: null, overTooltip: false });
  const hoverTimerRef = useRef(null);
  const tokenRefs = useRef(Object.create(null));

  // Cache für Vokabeln (aus DB) während der Session
  // map: eng(lower) -> [{ger, cnt}]
  const [vocabCache, setVocabCache] = useState({});

  /* -------- Aufbereiten: Volltext + Batch-Vokabeln -------- */
  async function handlePrepare() {
    // 1) Volltext-Kontext
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

    // 2) Tokens bilden
    const englishLines = inputText.split(/\r?\n/);
    const tokenLines = englishLines.map(ln => tokenize(ln));

    // 3) Einmal alle relevanten Wörter in Batch vom Server holen
    const uniqWords = [];
    {
      const set = new Set();
      for (const toks of tokenLines) {
        for (const t of toks) {
          const w = t.text;
          if (!w || isPunctuation(w)) continue;
          const lower = w.toLowerCase();
          if (!set.has(lower)) set.add(lower);
        }
      }
      uniqWords.push(...set);
    }

    let batchMap = {};
    try {
      const r = await fetch(`${API_BASE}/api/vocab/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: uniqWords }),
      });
      const d = await r.json();
      batchMap = d?.entries || {};
    } catch (e) {
      console.warn('batch vocab failed', e);
    }

    setVocabCache(batchMap);

    // 4) Start-Übersetzungen setzen
    const draft = tokenLines.map((tokens, lineIdx) => {
      const translations = [];
      const confirmed = [];
      const opts = [];
      const meta = [];
      const contextDE = deepLFull[lineIdx] || [];

      tokens.forEach((tok, idx) => {
        const w = tok.text;
        const lower = w.toLowerCase();

        if (isPunctuation(w)) {
          translations[idx] = w;
          confirmed[idx] = true;
          opts[idx] = [w];
          meta[idx] = { isPunct: true };
          return;
        }
        meta[idx] = { isPunct: false };

        const fromDB = Array.isArray(batchMap[lower]) ? batchMap[lower] : [];
        // Sortierung (falls Server aus irgendeinem Grund unsortiert liefert)
        fromDB.sort((a,b) => (b.cnt - a.cnt) || a.ger.localeCompare(b.ger, 'de'));

        // simplen Kontext-Kandidaten aus Volltext wählen (wenn vorhanden)
        let deepLCandidate = "";
        if (contextDE.length) {
          const windowIdxs = [idx - 1, idx, idx + 1, idx + 2].filter(i => i >= 0 && i < contextDE.length);
          const candidates = windowIdxs.map(i => contextDE[i]).filter(Boolean);
          deepLCandidate = candidates.find(x => !/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)$/i.test(x)) || "";
        }

        let best = fromDB[0]?.ger || "";
        if (deepLCandidate) {
          // wenn deepLCandidate bereits in DB vorhanden, nimm es nach vorn
          const hit = fromDB.find(e => e.ger.toLowerCase() === deepLCandidate.toLowerCase());
          if (hit) best = hit.ger;
          if (!best) best = deepLCandidate;
        }

        translations[idx] = best || "";
        confirmed[idx] = false;
        // Tooltip-Quelle: wir mappen zu einfacher Liste, Anzeige bekommt (Wort, cnt)
        opts[idx] = fromDB.length ? fromDB.map(e => `${e.ger}:::${e.cnt}`) : (best ? [`${best}:::0`] : []);
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

  /* -------- DeepL-Klick für EIN Wort (+ Seed in DB) -------- */
  async function handleTokenClick(lineIdx, tokenIdx) {
    const line = lines[lineIdx]; if (!line) return;
    const tok = line.tokens[tokenIdx]; if (!tok || isPunctuation(tok.text)) return;

    const englishWord = tok.text;
    const fullLineContext = line.tokens.map(t => t.text).join(" ");

    try {
      const resp = await fetch(`${API_BASE}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phraseText: englishWord, contextText: fullLineContext }),
      });
      const data = await resp.json();
      const alts = Array.isArray(data?.alts) ? data.alts : [];
      if (!alts.length) return;

      // lokal mergen (mit cnt=0, bis Nutzer klickt)
      setLines(prev => {
        const up = [...prev];
        const ln = { ...up[lineIdx] };
        const tr = [...ln.translations];
        const cf = [...ln.confirmed];
        const opts = ln.translationOptions.map(a => (a ? [...a] : []));

        const existing = new Set((opts[tokenIdx] || []).map(s => s.split(':::')[0].toLowerCase()));
        for (const g of alts) {
          const k = g.toLowerCase();
          if (!existing.has(k)) {
            opts[tokenIdx].push(`${g}:::0`);
            existing.add(k);
          }
        }

        // Erste Alternative als aktuelle Übersetzung übernehmen
        tr[tokenIdx] = alts[0];
        cf[tokenIdx] = true;

        // Sortiere nach cnt desc, dann alphabetisch
        opts[tokenIdx].sort((a, b) => {
          const [ga, ca] = a.split(':::'); const [gb, cb] = b.split(':::');
          const ia = parseInt(ca || '0', 10) || 0;
          const ib = parseInt(cb || '0', 10) || 0;
          if (ib !== ia) return ib - ia;
          return ga.localeCompare(gb, 'de');
        });

        ln.translations = tr;
        ln.confirmed = cf;
        ln.translationOptions = opts;
        up[lineIdx] = ln;
        return up;
      });

    } catch (e) {
      console.warn('deepl single word failed', e);
    }
  }

  /* ---------------- Tooltip-Logik ---------------- */

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
    if (!choice || choice === "(keine Optionen)") return;
    const [word, countStr] = choice.split(':::');
    const ger = word;

    setLines(prev => {
      const up = [...prev];
      const line = { ...up[lineIdx] };
      const tr = [...line.translations];
      const cf = [...line.confirmed];
      const opts = line.translationOptions.map(a => (a ? [...a] : []));

      tr[tokenIdx] = ger;
      cf[tokenIdx] = true;

      // Count lokal +1
      const updated = opts[tokenIdx].map(s => {
        const [g, cnt] = s.split(':::');
        if (g === ger) {
          const v = (parseInt(cnt || '0', 10) || 0) + 1;
          return `${g}:::${v}`;
        }
        return s;
      });

      // Falls ger noch nicht drin war (z.B. manuell): hinzufügen mit 1
      if (!updated.find(s => s.split(':::')[0] === ger)) {
        updated.push(`${ger}:::1`);
      }

      // Resort
      updated.sort((a, b) => {
        const [ga, ca] = a.split(':::'); const [gb, cb] = b.split(':::');
        const ia = parseInt(ca || '0', 10) || 0;
        const ib = parseInt(cb || '0', 10) || 0;
        if (ib !== ia) return ib - ia;
        return ga.localeCompare(gb, 'de');
      });

      opts[tokenIdx] = updated;
      line.translations = tr;
      line.confirmed = cf;
      line.translationOptions = opts;
      up[lineIdx] = line;
      return up;
    });

    // Persistenz cnt += 1
    try {
      const eng = (lines[lineIdx]?.tokens?.[tokenIdx]?.text || '');
      await fetch(`${API_BASE}/api/vocab/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eng, ger, increment: true }),
      });
    } catch { /* ignore */ }

    setHoverInfo({ lineIdx: null, tokenIdx: null, overTooltip: false });
  }

  async function manual(lineIdx, tokenIdx) {
    const val = window.prompt('Eigene Übersetzung eingeben:');
    const ger = String(val || '').trim();
    if (!ger) return;

    // lokal setzen
    await pick(lineIdx, tokenIdx, `${ger}:::0`);
  }

  function renderTooltip() {
    const { lineIdx, tokenIdx } = hoverInfo;
    if (lineIdx == null || tokenIdx == null) return null;

    const key = `${lineIdx}-${tokenIdx}`;
    const el = tokenRefs.current[key];
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;

    const rect = el.getBoundingClientRect();
    const left = rect.left + window.scrollX;
    const top  = rect.bottom + window.scrollY + 4;

    const line = lines[lineIdx]; if (!line) return null;
    if (line.tokenMeta?.[tokenIdx]?.isPunct) return null;

    // Merged Liste aus State
    let merged = Array.isArray(line.translationOptions?.[tokenIdx]) ? [...line.translationOptions[tokenIdx]] : [];
    // Dedup
    const seen = new Set();
    merged = merged.filter(s => {
      const g = s.split(':::')[0]?.toLowerCase();
      if (!g || seen.has(g)) return false;
      seen.add(g);
      return true;
    });

    if (!merged.length) merged = ["(keine Optionen)"];

    const tip = {
      position: 'absolute', left, top, zIndex: 9999,
      background: '#fff7d6', border: '1px solid #eab308',
      borderRadius: '8px', boxShadow: '0 10px 20px rgba(0,0,0,.15)',
      padding: '8px 10px', fontSize: 14, color: '#1f2937',
      minWidth: 220, maxWidth: 380, maxHeight: 260, overflowY: 'auto',
    };

    const row = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, cursor: 'pointer', padding: '4px 6px', borderRadius: 6, lineHeight: 1.4, fontWeight: 500,
    };

    const hint = { fontSize: 12, color: '#6b7280', marginBottom: 6 };

    return (
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={hint}>
          Mouseover für Optionen · <b>Klick</b> = übernehmen · <b>Doppelklick</b> auf EN-Wort = DeepL
        </div>

        {merged.map((entry, i) => {
          const [g, cntStr] = entry.split(':::');
          const cnt = parseInt(cntStr || '0', 10) || 0;
          return (
            <div
              key={i}
              style={row}
              onMouseDown={(e) => { e.preventDefault(); pick(lineIdx, tokenIdx, entry); }}
              onMouseOver={(e)=>{e.currentTarget.style.background = '#fde68a'}}
              onMouseOut={(e)=>{e.currentTarget.style.background = 'transparent'}}
            >
              <span>{g}</span>
              <span style={{ opacity: 0.7 }}>{cnt}</span>
            </div>
          );
        })}

        <div
          style={{ ...row, borderTop: '1px dashed #eab308', marginTop: 6, paddingTop: 8 }}
          onMouseDown={(e) => { e.preventDefault(); manual(lineIdx, tokenIdx); }}
          onMouseOver={(e)=>{e.currentTarget.style.background = '#fde68a'}}
          onMouseOut={(e)=>{e.currentTarget.style.background = 'transparent'}}
        >
          <span>+ Manuelle Eingabe</span>
          <span style={{ opacity: 0.5 }}>neu</span>
        </div>
      </div>
    );
  }

  /* ---------------- Render ---------------- */
  const page = { minHeight: '100vh', background: '#f6f7fb', color: '#0f172a', padding: 20, paddingBottom: 150 };
  const wrap = { maxWidth: 1000, margin: '0 auto' };
  const card = { background: '#fff', borderRadius: 16, boxShadow: '0 6px 18px rgba(0,0,0,.06)', padding: 16 };
  const badge = (selected) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 12,
    border: '1px solid #d1d5db', background: selected ? '#fef3c7' : '#f3f4f6',
    marginTop: 6, fontSize: selected ? 18 : 14, fontWeight: selected ? 700 : 400,
  });
  const eng = { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 20, fontWeight: 600, cursor: 'pointer' };

  return (
    <div style={page}>
      <div style={wrap}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Text einfügen → <b>Aufbereiten</b> · Mouseover zeigt DB-Vorschläge (mit Zähler).
          <br/>Ein-Klick auf EN-Wort: Auswahl · <b>Doppelklick</b> auf EN-Wort: DeepL-Alternativen holen/seed.
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
              onClick={handlePrepare}
              style={{ background: "#2563eb", color: "white", border: 0, padding: "8px 12px",
                borderRadius: 12, fontWeight: 700, cursor: "pointer" }}>
              Aufbereiten
            </button>
            <button
              disabled={isTranslatingFull}
              onClick={handleFullTextTranslate}
              style={{ background: "#16a34a", color: "white", border: 0, padding: "8px 12px",
                borderRadius: 12, fontWeight: 700, cursor: "pointer", opacity: isTranslatingFull ? 0.7 : 1 }}>
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
                          style={eng}
                          onMouseEnter={() => !isPunctTok && onEnter(li, ti)}
                          onMouseLeave={onLeave}
                          onClick={() => !isPunctTok && pick(li, ti, `${(tr||'').trim()||'_'}:::0`)}
                          onDoubleClick={() => !isPunctTok && handleTokenClick(li, ti)}
                          title={isPunctTok ? "" : "Mouseover: Optionen · Klick: übernehmen · Doppelklick: DeepL-Alternativen"}
                        >
                          {tok.text}
                        </span>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                          border: "1px solid #d1d5db", background: isConfirmed ? "#fef3c7" : "#f3f4f6",
                          marginTop: 6, fontSize: isConfirmed ? 18 : 14, fontWeight: isConfirmed ? 700 : 400
                        }}>
                          {isPunctTok ? tok.text : (tr?.trim() || "_")}
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
