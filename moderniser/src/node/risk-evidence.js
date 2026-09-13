/**
 * The per-node RISK EVIDENCE the wave gate scores (§3.4 #2, L2).
 *
 * `exception/risk-gate.js levelDisposition` has been built, tested and callerless since the arc began, and
 * the reason was never a missing call: MEASURED 2026-09-13, five of its eight inputs — all four `touches_*`
 * flags and `blast_total` — had no producer anywhere in `src`. Since it is FAIL-CLOSED by design (missing
 * evidence is FLAGGED, never assumed clear), wiring it against those absences would have flagged EVERY wave
 * and turned the human into the volume gate §3.4 forbids. The evidence comes first; this module is it.
 *
 * DERIVED STRICTLY FROM THE DIFF (operator-ratified 2026-09-13). Every flag answers "did this CHANGE?", not
 * "does this EXIST?". A node that reads a table before and after touches no new data source; one that
 * introduces a table read does. The alternative — flagging on mere presence — is simpler to compute and
 * would fire on almost every node, which is the same failure as not wiring it at all.
 *
 * ABSENCE FLAGS, it never passes. `blast_total` is null when no analysis was supplied rather than 0,
 * because `levelDisposition` treats a finite value within threshold as CLEAR: reporting 0 for "nobody
 * looked" would launder missing evidence into a clean bill of health, the exact inversion the offline
 * `--findings` guard (F5) exists to prevent.
 *
 * Pure over two assembled bundles; the caller owns all I/O.
 */

/** abapGit object types that ride a DDIC transport — a change to any of them is a dictionary change. */
const DDIC_EXT = /\.(tabl|dtel|doma|ttyp|shlp|enqu|view|indx|tabu)\./i;

/** The statement kinds that reach DATA. A change in this profile is a change in how the node reads/writes. */
const DATA_ACCESS = /^(select|insert|update|modify|delete|read_table|loop_at_screen|open_cursor|fetch|exec_sql)/i;

/**
 * @param {{before: object, after: object, beforeFiles?: Array<{filename: string}>,
 *          afterFiles?: Array<{filename: string}>, invariants?: object, analysis?: object}} input
 * @returns {{touches_ddic: boolean, touches_invariant: boolean, touches_data_source: boolean,
 *            touches_money: boolean, blast_total: number|null}}
 */
export function riskEvidence(input = {}) {
  const { before = {}, after = {}, beforeFiles = [], afterFiles = [], invariants, analysis } = input;
  return {
    touches_ddic: ddicSet(afterFiles) !== ddicSet(beforeFiles),
    // The invariant diff is EXACT and already computed by the checkpoint, so this one needs no proxy:
    // a moved authorization footprint or a broken P4 invariant is a touch by definition.
    touches_invariant: invariants?.auth_delta === true || invariants?.intact === false,
    touches_data_source: profile(after.statement_kinds) !== profile(before.statement_kinds),
    touches_money: moneySet(after.money_operands) !== moneySet(before.money_operands),
    blast_total: Array.isArray(analysis?.blast_radius) ? analysis.blast_radius.length : null,
  };
}

/** The DDIC artifacts present, as a stable key. Names only — a rename IS a dictionary change. */
const ddicSet = (files) =>
  [...new Set((files ?? []).map((f) => String(f?.filename ?? "")).filter((n) => DDIC_EXT.test(n)))].sort().join("|");

/**
 * The data-access statement profile: kind → count, for the kinds that reach data.
 *
 * COUNTS, not just presence. A node that went from one SELECT to four is reading differently even though
 * "it selects" both before and after, and parity already uses this same statement_kinds channel for its
 * SELECT→EML read-idiom diff — so this is the established evidence for exactly this question, not a new
 * signal invented for the gate.
 */
const profile = (kinds) =>
  Object.entries(kinds ?? {})
    .filter(([k]) => DATA_ACCESS.test(k))
    .map(([k, v]) => `${String(k).toLowerCase()}:${v}`)
    .sort()
    .join("|");

/** The money-typed operands, by field and type — a CURR/QUAN/WAERS field appearing or changing type. */
const moneySet = (operands) =>
  [...new Set((operands ?? []).map((m) => `${String(m?.field ?? "").toUpperCase()}:${String(m?.type ?? "").toUpperCase()}`))]
    .sort()
    .join("|");
