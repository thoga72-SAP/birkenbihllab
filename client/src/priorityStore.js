// client/src/priorityStore.js

const LS_KEY = "prio_v1"; // alles hier drin

// Struktur in localStorage:
// {
//   global: { "machen": 12, "finden": 4, ... },
//   perEng: { "make": { "machen": 7, "herstellen": 3 }, "find": {...} }
// }

export function loadPriority() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { global: {}, perEng: {} };
    const parsed = JSON.parse(raw);
    return {
      global: parsed.global || {},
      perEng: parsed.perEng || {},
    };
  } catch {
    return { global: {}, perEng: {} };
  }
}

export function savePriority(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch { /* ignore quota errors */ }
}

// ++1 für eine gewählte Übersetzung
export function bumpPriority(state, engWord, germanChoice) {
  const eng = String(engWord || "").toLowerCase();
  const ger = String(germanChoice || "").toLowerCase();

  // global
  state.global[ger] = (state.global[ger] || 0) + 1;

  // pro englisches Wort
  if (!state.perEng[eng]) state.perEng[eng] = {};
  state.perEng[eng][ger] = (state.perEng[eng][ger] || 0) + 1;

  savePriority(state);
  return state;
}

// Sortiert Kandidaten nach:
// 1) perEng[eng][ger] absteigend
// 2) global[ger] absteigend
// 3) alphabetisch (de)
export function sortWithPriority(state, engWord, candidates) {
  const eng = String(engWord || "").toLowerCase();
  const per = state.perEng[eng] || {};
  const glob = state.global || {};

  return [...candidates].sort((a, b) => {
    const aa = String(a || "").toLowerCase();
    const bb = String(b || "").toLowerCase();

    const pa = per[aa] || 0;
    const pb = per[bb] || 0;
    if (pb !== pa) return pb - pa;

    const ga = glob[aa] || 0;
    const gb = glob[bb] || 0;
    if (gb !== ga) return gb - ga;

    return String(a).localeCompare(String(b), "de");
  });
}
