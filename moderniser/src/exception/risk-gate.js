/**
 * Per-level risk gate (MODERNISER_DESIGN §3.4 #2, L2). The per-level pause is a
 * human-approval BATCHING rhythm over already-green nodes only — it never gates
 * scheduling. All-clear → 'AUTO' (advance silently); ANY flagged node → 'REVIEW' (exactly
 * one RISK_LEVEL_REVIEW escalation for the level, naming every flagged node + reasons).
 * Missing evidence is FLAGGED, never assumed clear (fail-closed). Pure, deterministic.
 */
const PASS_PARITY = new Set(["equivalent", "PASS_STRUCTURAL"]);

/**
 * @param {Array<{sig: string, atc_p1?: number, atc_p2?: number, parity?: string, touches_ddic?: boolean, touches_invariant?: boolean, touches_data_source?: boolean, touches_money?: boolean, blast_total?: number}>} levelNodes green nodes of the level
 * @param {{blastThreshold: number}} opts
 * @returns {{disposition: "AUTO"|"REVIEW", flagged: Array<{sig: string, reasons: string[]}>}}
 */
export function levelDisposition(levelNodes, { blastThreshold }) {
  if (!Number.isFinite(blastThreshold)) throw new Error("risk-gate: a finite blastThreshold is required");
  const flagged = [];
  for (const n of levelNodes ?? []) {
    const reasons = [];
    if (n.atc_p1 !== 0) reasons.push("atc-p1-nonzero-or-missing");
    if (n.atc_p2 !== 0) reasons.push("atc-p2-nonzero-or-missing"); // C3 (P6): priority-2 blocks like priority-1
    if (!PASS_PARITY.has(n.parity)) reasons.push(`parity:${n.parity ?? "missing"}`);
    if (n.touches_ddic !== false) reasons.push("touches-ddic-or-unknown");
    if (n.touches_invariant !== false) reasons.push("touches-invariant-or-unknown");
    if (n.touches_data_source !== false) reasons.push("touches-data-source-or-unknown");
    if (n.touches_money !== false) reasons.push("touches-money-or-unknown");
    if (!(Number.isFinite(n.blast_total) && n.blast_total <= blastThreshold)) reasons.push(`blast:${n.blast_total ?? "missing"}>${blastThreshold}`);
    if (reasons.length > 0) flagged.push({ sig: n.sig, reasons });
  }
  flagged.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
  return { disposition: flagged.length === 0 ? "AUTO" : "REVIEW", flagged };
}
