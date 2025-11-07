// client/src/priorityStore.js
const LS_GLOBAL = "prio_global_v1";
const LS_PER_ENG = "prio_per_eng_v1";

export function loadPriority() {
  let global = {};
  let perEng = {};
  try {
    global = JSON.parse(localStorage.getItem(LS_GLOBAL) || "{}");
  } catch {}
  try {
    perEng = JSON.parse(localStorage.getItem(LS_PER_ENG) || "{}");
  } catch {}
  return { global, perEng };
}

function savePriority(state) {
  try {
    localStorage.setItem(LS_GLOBAL, JSON.stringify(state.global || {}));
    localStorage.setItem(LS_PER_ENG, JSON.stringify(state.perEng || {}));
  } catch {}
}

/** Priorität erhöhen (global + pro englischem Wort) */
export function bumpPriority(state, engWord, chosenDe) {
  const eng = (engWord || "").toLowerCase();
  const de = (chosenDe || "").trim();
  if (!de) return state;

  const next = {
    global: { ...(state.global || {}) },
    perEng: { ...(state.perEng || {}) }
  };

  // global
  next.global[de] = (next.global[de] || 0) + 1;

  // per-english
  next.perEng[eng] = next.perEng[eng] || {};
  next.perEng[eng][de] = (next.perEng[eng][de] || 0) + 1;

  savePriority(next);
  return next;
}

/** Liste nach Priorität sortieren: perEng > global > alphabetisch */
export function sortWithPriority(state, engWord, options) {
  const eng = (engWord || "").toLowerCase();
  const per = (state.perEng && state.perEng[eng]) || {};
  const global = state.global || {};

  return [...(options || [])].sort((a, b) => {
    const aa = (a || "").trim();
    const bb = (b || "").trim();
    const pa = per[aa] || 0, pb = per[bb] || 0;
    if (pb !== pa) return pb - pa; // perEng wichtiger
    const ga = global[aa] || 0, gb = global[bb] || 0;
    if (gb !== ga) return gb - ga; // dann global
    return aa.localeCompare(bb, "de");
  });
}
