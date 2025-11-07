import React, { useEffect, useRef, useState } from "react";
import { loadPriority, bumpPriority, sortWithPriority, countFor } from "./priorityStore";

/* … (Mini-Wörterbuch, COMMON_CAP_WORDS etc. bleiben unverändert) … */

const DICT = {
  quick: ["schnell", "rasch", "flink"],
  brown: ["braun"], fox: ["Fuchs"], lazy: ["faul", "träge"], dog: ["Hund"],
  prefer: ["bevorzugen", "vorziehen"], public: ["öffentlich", "allgemein"],
};

const COMMON_CAP_WORDS = new Set(["the","this","that","a","an","in","on","at","for","from","to","and","or","but",
"if","when","while","as","with","by","of","is","are","was","were","it","he","she","they","we","you","i"]);

const API_BASE = "";

// --- Utilitys (unverändert + Morphologie, User-Additions, Phrasen) ---
const isPunctuation = (s) => !!s && /^[^A-Za-zÄÖÜäöüß]+$/.test(s);
function isLikelyName(str){ if(!str||isPunctuation(str)||!/[A-Za-zÄÖÜäöüß]/.test(str))return false;
  if(str===str.toUpperCase()&&str.length>1)return true;
  const cap=str[0]===str[0].toUpperCase()&&str.slice(1)===str.slice(1).toLowerCase();
  if(cap)return !COMMON_CAP_WORDS.has(str.toLowerCase()); return false;}
function guessRole(tokens,idx){const p=tokens[idx-1]?.text?.toLowerCase()||"",p2=tokens[idx-2]?.text?.toLowerCase()||"",n=tokens[idx+1]?.text?.toLowerCase()||"";
  const art=new Set(["a","an","the","this","that","these","those"]), mod=new Set(["will","can","could","should","would","may","might","shall","must"]);
  if(art.has(p))return"noun"; if(p==="to")return"verb"; if(p==="and"&&art.has(n))return"verb"; if(mod.has(p)||mod.has(p2))return"verb"; return"unknown";}
function rankAndKeepAllMeanings(eng,raw,role){const lower=(eng||"").toLowerCase(),looksV=(g)=>/\b\w+(en|ern|eln)\b/.test((g||"").trim()),looksN=(g)=>{const f=(g||"").trim().split(/\s+/)[0]||"";return f&&f[0]===f[0].toUpperCase();};
  const over=new Set(["bevorzugt","bevorzugen"]); const preferish=/^(prefer|prefers|preferred|preference|favor)$/i.test(lower);
  const scored=(raw||[]).map(opt=>{const c=String(opt||"").trim(); if(!c)return null; let s=0; const wc=c.split(/\s+/).length; if(wc<=3)s++; if(wc===1)s++; if(role==="verb"&&looksV(c))s+=2; if(role==="noun"&&looksN(c))s+=2; if(over.has(c.toLowerCase())&&!preferish)s-=3; return{opt:c,score:s};}).filter(Boolean);
  scored.sort((a,b)=>(b.score-a.score)||a.opt.localeCompare(b.opt,"de"));
  const seen=new Set(); const res=[]; for(const {opt} of scored){const k=opt.toLowerCase(); if(seen.has(k))continue; seen.add(k); res.push(opt);} return res;}
const tokenize=(s)=>(s.match(/(\w+|'\w+|[^\s\w]+)/g)||[]).map(t=>({text:t}));
function deriveAdjectiveFromVerb(de){const v=(de||"").trim().toLowerCase(); if(!/(en|ern|eln)$/.test(v))return null; const stem=v.replace(/(en|ern|eln)$/,""); if(!stem)return null; return stem+"end";}

const LS_USER_VOCAB="user_vocab_additions_v1";
function loadUserVocabAdditions(){try{return JSON.parse(localStorage.getItem(LS_USER_VOCAB)||"{}");}catch{return{};}}
function saveUserVocabAdditions(o){try{localStorage.setItem(LS_USER_VOCAB,JSON.stringify(o||{}));}catch{}}
function addUserVocabLocal(eng,de){const adds=loadUserVocabAdditions(); const k=(eng||"").toLowerCase().trim(); const v=(de||"").trim(); if(!k||!v)return;
  adds[k]=adds[k]||[]; if(!adds[k].includes(v))adds[k].push(v); saveUserVocabAdditions(adds);}

function detectPhrases(tokens,vmap){const res=[]; const w=tokens.map(t=>t.text.toLowerCase()); const N=w.length;
  for(let i=0;i<N;i++){ if(i+2<N){const tri=`${w[i]} ${w[i+1]} ${w[i+2]}`; if(vmap[tri]?.length)res.push({start:i,end:i+2,eng:tri,meanings:vmap[tri]});}
    if(i+1<N){const bi=`${w[i]} ${w[i+1]}`; if(vmap[bi]?.length)res.push({start:i,end:i+1,eng:bi,meanings:vmap[bi]});}} return res;}

/* ----------------- App ----------------- */
export default function App(){
  const [inputText,setInputText]=useState(
`James and Luke go on an accidental road trip in the south-west of England and record a rambling podcast,
while slowly going a bit mad. Will they make it to their destination before sunset? Listen to find out what happens
and to learn some words and culture in the process.`);

  const [lines,setLines]=useState([]);
  const [fullGermanText,setFullGermanText]=useState("");
  const [isTranslatingFull,setIsTranslatingFull]=useState(false);

  const [vocabMap,setVocabMap]=useState({});
  const [vocabLoaded,setVocabLoaded]=useState(false);

  const [prioState,setPrioState]=useState({global:{},perEng:{}});
  const [hoverInfo,setHoverInfo]=useState({lineIdx:null,tokenIdx:null,overTooltip:false});
  const hoverTimerRef=useRef(null); const tokenRefs=useRef({});

  useEffect(()=>{ setPrioState(loadPriority()); },[]);

  // Wörterbuch + User-Additions + DICT
  useEffect(()=>{(async()=>{
    try{
      const r=await fetch("/VkblDB.txt"); let map=Object.create(null);
      if(r.ok){ let text=await r.text(); text=text.replace(/^\uFEFF/,"");
        for(const raw of text.split(/\r?\n/)){const line=raw.trim(); if(!line||line.startsWith("//"))continue; const m=line.match(/^([^#]+?)#(.*)$/); if(!m)continue;
          const eng=m[1].trim().toLowerCase(); const ger=m[2].trim(); if(!eng||!ger)continue; (map[eng] ||= []).includes(ger) || map[eng].push(ger);}
      }
      const adds=loadUserVocabAdditions(); for(const eng of Object.keys(adds)){ map[eng]=map[eng]||[]; for(const de of adds[eng]) if(!map[eng].includes(de)) map[eng].push(de); }
      for(const eng of Object.keys(DICT)){ const key=eng.toLowerCase(); map[key]=map[key]||[]; for(const de of DICT[eng]) if(!map[key].includes(de)) map[key].push(de); }
      setVocabMap(map);
    }catch(e){ console.warn("Vokabelladen fehlgeschlagen:",e);} finally{ setVocabLoaded(true); }
  })();},[]);

  // Aufbereiten + Phrasen
  async function handlePrepare(){
    let deepLFull=[];
    try{
      const r=await fetch(`${API_BASE}/api/translate/fulltext`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fullText:inputText})});
      if(r.ok){const d=await r.json(); const txt=d?.translatedText||""; setFullGermanText(txt);
        deepLFull=txt.split(/\r?\n/).map(s=>s.trim().split(/\s+/).filter(Boolean));}
    }catch(e){console.warn("fulltext failed",e);}

    const englishLines=inputText.split(/\r?\n/);
    const draft=englishLines.map((ln,lineIdx)=>{
      const tokens=tokenize(ln); const translations=[],confirmed=[],opts=[],meta=[];
      const contextDE=deepLFull[lineIdx]||[];
      const phrases=detectPhrases(tokens,vocabMap);

      tokens.forEach((tok,idx)=>{
        const w=tok.text, lower=w.toLowerCase(); const punct=isPunctuation(w), isName=isLikelyName(w);
        meta[idx]={isPunct:punct,isName}; if(punct){translations[idx]=w; confirmed[idx]=true; opts[idx]=[w]; return;}
        if(isName){translations[idx]=w; confirmed[idx]=false; opts[idx]=[w]; return;}

        const fromFile=vocabMap[lower]||[]; const role=guessRole(tokens,idx);
        let ranked=rankAndKeepAllMeanings(w,fromFile,role);
        const morph=[]; for(const c of ranked){ const adj=deriveAdjectiveFromVerb(c); if(adj&&!morph.includes(adj)) morph.push(adj); }
        ranked=[...new Set([...ranked,...morph])];

        let deepLCandidate=""; if(contextDE.length){ const win=[idx-1,idx,idx+1,idx+2].filter(i=>i>=0&&i<contextDE.length).map(i=>contextDE[i]);
          deepLCandidate=win.find(x=>!/^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)$/i.test(x))||"";}

        let best=ranked[0]||""; if(deepLCandidate){ const i=ranked.findIndex(o=>o.toLowerCase()===deepLCandidate.toLowerCase()); if(i>0)best=ranked[i]; if(!best)best=deepLCandidate; }

        // Phrasenoptionen sammeln
        const phOpts=[]; for(const ph of phrases){ if(idx>=ph.start&&idx<=ph.end){ for(const m of ph.meanings||[]) if(m&&!phOpts.includes(m)) phOpts.push(m); } }

        const baseOpts=[...(ranked.length?ranked:(best?[best]:[])), ...phOpts];
        const uniq=[...new Set(baseOpts)];
        opts[idx]=sortWithPriority(prioState,w,uniq);
        translations[idx]=best||""; confirmed[idx]=false;
      });

      return { tokens, translations, confirmed, translationOptions: opts, tokenMeta: meta, phrases };
    });

    setLines(draft);
  }

  async function handleFullTextTranslate(){
    try{
      setIsTranslatingFull(true);
      const r=await fetch(`${API_BASE}/api/translate/fulltext`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fullText:inputText})});
      const d=await r.json(); setFullGermanText(d?.translatedText||"(kein Ergebnis)");
    }catch{ setFullGermanText("(Fehler)"); } finally{ setIsTranslatingFull(false); }
  }

  // Wort-Klick: Hauptübersetzung + DeepL-Alternativen einblenden & persistieren
  async function handleTokenClick(lineIdx, tokenIdx){
    const line=lines[lineIdx]; if(!line)return;
    const tok=line.tokens[tokenIdx]; if(!tok||isPunctuation(tok.text)||line.tokenMeta[tokenIdx]?.isName)return;
    const englishWord=tok.text; const context=line.tokens.map(t=>t.text).join(" ");

    const variants=[englishWord, englishWord.toLowerCase()]; const fresh=[];
    for(const v of variants){
      try{
        const r=await fetch(`${API_BASE}/api/translate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phraseText:v,contextText:context})});
        const d=await r.json(); let t=(d?.translatedText||"").trim();
        if(t&&!/^übersetze möglichst|translate/i.test(t)){ t=t.split(/[\r\n]/)[0].split(/[.;!?]/)[0].trim();
          const parts=t.split(/\s+/).filter(Boolean).slice(0,3); const cleaned=parts.join(" "); if(cleaned&&!fresh.includes(cleaned)) fresh.push(cleaned); }
      }catch{}
    }

    // Alternativen holen
    let alt=[];
    try{
      const r=await fetch(`${API_BASE}/api/translate/alternatives`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phraseText:englishWord,contextText:context})});
      const d=await r.json();
      alt=(d?.alternatives||[]).map(s=>String(s||"").trim()).filter(Boolean).slice(0,30);
    }catch{}

    // lokale Vokabelbank um Alternativen erweitern
    if(alt.length){ addUserVocabLocal(englishWord, alt[0]); for(const a of alt) addUserVocabLocal(englishWord, a); }

    // ins UI mergen
    const addAll=[...fresh, ...alt];
    if(!addAll.length) return;

    setLines(prev=>{
      const up=[...prev]; const ln={...up[lineIdx]}; const tr=[...ln.translations]; const cf=[...ln.confirmed];
      const opts=ln.translationOptions.map(a=>(a?[...a]:[]));
      const merged=[...opts[tokenIdx], ...addAll]; const seen=new Set();
      const dedup=merged.filter(o=>{const k=(o||"").toLowerCase().trim(); if(!k||seen.has(k))return false; seen.add(k); return true;});
      const sorted=sortWithPriority(prioState,englishWord,dedup);

      if(fresh.length) { tr[tokenIdx]=fresh[0]; cf[tokenIdx]=true; } // erste frische Lösung direkt setzen
      ln.translations=tr; ln.confirmed=cf; ln.translationOptions=opts; ln.translationOptions[tokenIdx]=sorted; up[lineIdx]=ln; return up;
    });
  }

  function scheduleHide(){ if(hoverTimerRef.current)clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current=setTimeout(()=>setHoverInfo({lineIdx:null,tokenIdx:null,overTooltip:false}),200);}
  function cancelHide(){ if(hoverTimerRef.current)clearTimeout(hoverTimerRef.current); hoverTimerRef.current=null;}
  const onEnter=(li,ti)=>{cancelHide(); setHoverInfo({lineIdx:li,tokenIdx:ti,overTooltip:false});};
  const onLeave=()=>{ if(!hoverInfo.overTooltip) scheduleHide(); };
  const tipEnter=()=>{ cancelHide(); setHoverInfo(p=>({...p,overTooltip:true})); };
  const tipLeave=()=>scheduleHide();

  async function persistUserVocab(eng,de){
    addUserVocabLocal(eng,de);
    try{ await fetch(`${API_BASE}/api/vocab/add`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({eng,de})}); }catch{}
  }

  function pick(lineIdx, tokenIdx, choice){
    if(!choice) return;
    const MANUAL="__MANUAL_INPUT__";
    if(choice===MANUAL){
      const w=lines[lineIdx]?.tokens[tokenIdx]?.text || "";
      const entered=window.prompt(`Deutsche Übersetzung für "${w}" eingeben:`,``);
      const cleaned=(entered||"").trim(); if(!cleaned) return;

      setLines(prev=>{
        const up=[...prev]; const line={...up[lineIdx]}; const tr=[...line.translations]; const cf=[...line.confirmed];
        const opts=line.translationOptions.map(a=>(a?[...a]:[]));
        const merged=[cleaned, ...opts[tokenIdx].filter(o=>o!==cleaned)];
        const seen=new Set(); const dedup=merged.filter(o=>{const k=(o||"").toLowerCase().trim(); if(!k||seen.has(k))return false; seen.add(k); return true;});
        const engWord=line.tokens[tokenIdx]?.text || "";
        const sorted=sortWithPriority(prioState,engWord,dedup);
        tr[tokenIdx]=cleaned; cf[tokenIdx]=true; line.translations=tr; line.confirmed=cf; line.translationOptions=opts; line.translationOptions[tokenIdx]=sorted; up[lineIdx]=line; return up;
      });

      const engWord=(lines[lineIdx]?.tokens[tokenIdx]?.text || "").toLowerCase();
      setPrioState(prev=>bumpPriority({...prev},engWord,cleaned));
      persistUserVocab(engWord,cleaned);
      setHoverInfo({lineIdx:null,tokenIdx:null,overTooltip:false});
      return;
    }

    // normaler Pick
    setLines(prev=>{
      const up=[...prev]; const line={...up[lineIdx]}; const tr=[...line.translations]; const cf=[...line.confirmed];
      const opts=line.translationOptions.map(a=>(a?[...a]:[]));
      const merged=[choice, ...opts[tokenIdx].filter(o=>o!==choice)];
      const seen=new Set(); const dedup=merged.filter(o=>{const k=(o||"").toLowerCase().trim(); if(!k||seen.has(k))return false; seen.add(k); return true;});
      const engWord=line.tokens[tokenIdx]?.text || "";
      const sorted=sortWithPriority(prioState,engWord,dedup);
      tr[tokenIdx]=choice; cf[tokenIdx]=true; line.translations=tr; line.confirmed=cf; line.translationOptions=opts; line.translationOptions[tokenIdx]=sorted; up[lineIdx]=line; return up;
    });

    const engWord=(lines[lineIdx]?.tokens[tokenIdx]?.text || "").toLowerCase();
    setPrioState(prev=>bumpPriority({...prev},engWord,choice));
    persistUserVocab(engWord,choice);
    setHoverInfo({lineIdx:null,tokenIdx:null,overTooltip:false});
  }

  function renderTooltip(){
    const {lineIdx,tokenIdx}=hoverInfo; if(lineIdx==null||tokenIdx==null)return null;
    const key=`${lineIdx}-${tokenIdx}`; const el=tokenRefs.current[key]; if(!el)return null;
    const rect=el.getBoundingClientRect(); const left=rect.left+window.scrollX, top=rect.bottom+window.scrollY+4;
    const line=lines[lineIdx]; if(!line)return null; if(line.tokenMeta[tokenIdx]?.isPunct)return null;

    const w=line.tokens[tokenIdx]?.text || ""; const lower=w.toLowerCase();
    const fromState=line.translationOptions[tokenIdx] || []; const fromFile=vocabMap[lower] || []; const current=line.translations[tokenIdx] || "";

    let merged=[]; if(current) merged.push(current); merged=merged.concat(fromState, fromFile);
    const seen=new Set(); merged=merged.filter(o=>{ if(!o)return false; const k=o.trim().toLowerCase(); if(seen.has(k))return false; seen.add(k); return true; });
    merged=sortWithPriority(prioState, w, merged);

    const MANUAL="__MANUAL_INPUT__"; const items=[...merged, MANUAL];

    const tip={position:"absolute",left,top,zIndex:9999,background:"#fff7d6",border:"1px solid #eab308",borderRadius:"8px",boxShadow:"0 10px 20px rgba(0,0,0,.15)",padding:"8px 10px",fontSize:14,color:"#1f2937",minWidth:200,maxWidth:380,maxHeight:300,overflowY:"auto"};
    const lineStyle={display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,cursor:"pointer",padding:"4px 6px",borderRadius:6,lineHeight:1.4,fontWeight:500};

    return(
      <div style={tip} onMouseEnter={tipEnter} onMouseLeave={tipLeave}>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:6}}>
          Mouseover = Optionen • <b>Klick</b> auf EN-Wort = DeepL-Lookup • Auswahl wird gespeichert
        </div>
        {items.map((choice,i)=>{
          const isManual=choice===MANUAL;
          const display=isManual?"➕ manuelle Eingabe…":choice;
          const cnt=isManual?null:countFor(prioState, w, choice);
          return(
            <div key={i}
                 style={{...lineStyle,color:isManual?"#1d4ed8":"#111827"}}
                 onMouseDown={(e)=>{e.preventDefault(); pick(lineIdx, tokenIdx, choice);}}
                 onMouseOver={(e)=>{e.currentTarget.style.background="#fde68a";}}
                 onMouseOut={(e)=>{e.currentTarget.style.background="transparent";}}>
              <span>{display}</span>
              {!isManual && <span style={{opacity:.7,fontSize:12}}>(×{cnt})</span>}
            </div>
          );
        })}
      </div>
    );
  }

  // --- Render ---
  const page={minHeight:"100vh",background:"#f6f7fb",color:"#0f172a",padding:20,paddingBottom:150};
  const wrap={maxWidth:1000,margin:"0 auto"}; const card={background:"#fff",borderRadius:16,boxShadow:"0 6px 18px rgba(0,0,0,.06)",padding:16};
  const badge=(sel)=>({display:"inline-block",padding:"2px 8px",borderRadius:12,border:"1px solid #d1d5db",background:sel?"#fef3c7":"#f3f4f6",marginTop:6,fontSize:sel?18:14,fontWeight:sel?700:400});
  const eng=(isName)=>({display:"inline-block",padding:"2px 8px",borderRadius:12,border:`1px solid ${isName?"#93c5fd":"transparent"}`,background:isName?"#dbeafe":"transparent",fontSize:20,fontWeight:600,cursor:"pointer"});
  const phraseBadge={display:"inline-block",padding:"0 6px",borderRadius:8,background:"#e0f2fe",color:"#075985",fontSize:12,marginBottom:4,border:"1px solid #7dd3fc"};

  return(
    <div style={page}>
      <div style={wrap}>
        <h1 style={{fontSize:28,fontWeight:800,marginBottom:8}}>Birkenbihllab Trainer (EN → DE)</h1>
        <p style={{color:"#475569",marginBottom:16}}>
          Text einfügen → <b>Aufbereiten</b> • Mouseover zeigt Bedeutungen • Klick holt DeepL + Alternativen •
          eigene <i>manuelle Eingabe…</i> möglich. Alles wird gespeichert & priorisiert.
        </p>

        <div style={card}>
          <label style={{fontSize:14,fontWeight:600}}>Englischer Text (jede Zeile separat):</label>
          <textarea value={inputText} onChange={(e)=>setInputText(e.target.value)}
            style={{width:"100%",minHeight:120,marginTop:8,padding:10,borderRadius:12,border:"1px solid #cbd5e1",background:"#f8fafc",fontFamily:"ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",fontSize:13}}/>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:10}}>
            <button disabled={!vocabLoaded} onClick={handlePrepare}
              style={{background:vocabLoaded?"#2563eb":"#9bb7ff",color:"white",border:0,padding:"8px 12px",borderRadius:12,fontWeight:700,cursor:vocabLoaded?"pointer":"not-allowed"}}>
              {vocabLoaded?"Aufbereiten":"Vokabeln laden …"}
            </button>
            <button disabled={isTranslatingFull} onClick={handleFullTextTranslate}
              style={{background:"#16a34a",color:"white",border:0,padding:"8px 12px",borderRadius:12,fontWeight:700,cursor:"pointer"}}>
              {isTranslatingFull?"Übersetze…":"Gesamten Text auf Deutsch"}
            </button>
          </div>

          {fullGermanText && (
            <div style={{...card,marginTop:12,border:"1px solid #e5e7eb"}}>
              <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>Vollständige Kontext-Übersetzung (DeepL):</div>
              <div style={{whiteSpace:"pre-wrap",lineHeight:1.5}}>{fullGermanText}</div>
            </div>
          )}
        </div>

        <div style={{marginTop:16,display:"grid",gap:16}}>
          {lines.length===0?(
            <div style={{color:"#64748b",fontStyle:"italic"}}>(Noch nichts aufbereitet)</div>
          ):(
            lines.map((line,li)=>(
              <div key={li} style={card}>
                {line.phrases?.length>0 && (
                  <div style={{marginBottom:8,display:"flex",flexWrap:"wrap",gap:8}}>
                    {line.phrases.map((ph,idx)=>(<span key={idx} style={phraseBadge}>⟦ {ph.eng} ⟧ → {ph.meanings?.[0]||"—"}</span>))}
                  </div>
                )}
                <div style={{display:"flex",flexWrap:"wrap",columnGap:16,rowGap:20,alignItems:"flex-start"}}>
                  {line.tokens.map((tok,ti)=>{
                    const refKey=`${li}-${ti}`; const tr=line.translations[ti]; const isConfirmed=line.confirmed[ti];
                    const meta=line.tokenMeta[ti]||{}; const isName=meta.isName, isPunctTok=meta.isPunct;
                    return(
                      <div key={ti} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",minWidth:"max-content"}}>
                        <span ref={(el)=>(tokenRefs.current[refKey]=el)} style={eng(isName)}
                              onMouseEnter={()=>!isPunctTok&&onEnter(li,ti)} onMouseLeave={onLeave}
                              onClick={()=>!isPunctTok&&handleTokenClick(li,ti)}
                              title={isPunctTok?"":"Mouseover = Optionen / Klick = DeepL + Alternativen"}>
                          {tok.text}
                        </span>
                        <span style={badge(isConfirmed)}>{isPunctTok?tok.text:(tr&&tr.trim()!==""?tr:"_")}</span>
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
