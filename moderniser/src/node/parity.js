/**
 * Parity — the SCORED proxy (MODERNISER_DESIGN §6.1 / arch §15.4, L8). Program semantic
 * equivalence is undecidable (Rice's theorem), so a static parity check is a conservative
 * proxy, never a proof; a binary PASS/BLOCK forces false certainty on the undecidable
 * middle. The model represents uncertainty as a SCORE + a human-review band.
 *
 * `classifyParity(diff)` derives the mandatory-parity class set (a non-empty set forbids
 * PASS_STRUCTURAL and pulls in the §3.2 uncovered-seam / currency-matrix / negative-path
 * rules). `parity(diff)` runs the cascade:
 *   - VETO → BLOCK regardless of score: `auth_vanished` (auth removed, no relocated DCL grant, L7)
 *     or `reassembly_broken` (an untouched byte changed, L0).
 *   - Score = 1 − Σ weighted deductions, clamped to [0,1].
 *   - Bands (half-open, total): <0.30 → scope_reduced (BLOCK); [0.30,0.70) → needs_review
 *     (→ PARITY_REVIEW escalation; offline never auto-passes); [0.70,1] → equivalent, or
 *     PASS_STRUCTURAL iff the class set is empty.
 *
 * Pure. The before/after AST → `diff` extraction (via @abaplint) is a later I/O step; here
 * `diff` is the already-extracted CPG-diff feature bundle. Two extraction responsibilities are
 * OWED by that step (§6.1): the `money` class relies on resolved CURR/QUAN/DEC operand types,
 * so the extractor must ship a seeded standard-amount-field allowlist (DMBTR/WRBTR/NETWR/…) as
 * the offline fallback when abaplint type inference returns `unknown`; and `client_specified_delta`
 * must fold BOTH §6.1 sub-triggers (a CLIENT SPECIFIED token diff AND a client-dependent↔independent
 * table-access switch) into the single boolean.
 */

// §15.4 semantic-parity deduction weights.
const DEDUCTIONS = {
  auth_object_changed: 0.3,
  exception_path_dropped: 0.4,
  def_use_lost: 0.3,
  cfg_branch_regression: 0.2,
  max_nesting_regression: 0.15,
};

const MONEY_TYPES = new Set(["CURR", "QUAN", "DEC"]);
const DATA_SOURCE_EDGES = new Set(["uses-table", "consumes-cds", "call-function"]);
const READ_IDIOMS = [["SELECT", "EML"], ["CALL-FUNCTION", "CALL-METHOD"]];

/**
 * @param {{changed_edges?: Array<{kind: string, target_before: string, target_after: string}>, transformations?: Array<{kind: string, successor_kind?: string}>, money_operands?: Array<{field: string, type: string}>, client_specified_delta?: boolean, statement_kind_changes?: Array<{from: string, to: string}>}} diff
 * @returns {string[]} sorted mandatory-parity classes
 */
export function classifyParity(diff = {}) {
  const classes = new Set();

  for (const e of diff.changed_edges || []) {
    if (DATA_SOURCE_EDGES.has(e.kind) && e.target_before !== e.target_after) classes.add("data-source");
  }
  for (const t of diff.transformations || []) {
    if (t.kind === "released-api" && ["table", "cds"].includes(t.successor_kind)) classes.add("data-source");
  }
  for (const m of diff.money_operands || []) {
    if (MONEY_TYPES.has(String(m.type).toUpperCase())) classes.add("money");
  }
  if (diff.client_specified_delta === true) classes.add("client");
  for (const s of diff.statement_kind_changes || []) {
    if (isReadIdiom(s)) classes.add("read-idiom");
  }

  return [...classes].sort();
}

/**
 * @param {object} diff the CPG-diff feature bundle (classify signals + deduction/veto flags)
 * @returns {{score: number, verdict: string, classes: string[], evidence: string[]}}
 */
export function parity(diff = {}) {
  const classes = classifyParity(diff);

  if (diff.auth_vanished === true) return { score: 0, verdict: "auth_vanished", classes, evidence: ["veto:auth_vanished"] };
  if (diff.reassembly_broken === true) return { score: 0, verdict: "reassembly_broken", classes, evidence: ["veto:reassembly_broken"] };

  const evidence = [];
  let score = 1;
  for (const [signal, weight] of Object.entries(DEDUCTIONS)) {
    if (diff[signal] === true) {
      score -= weight;
      evidence.push(`deduct:${signal}:-${weight}`);
    }
  }
  score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;

  return { score, verdict: band(score, classes), classes, evidence };
}

function band(score, classes) {
  if (score < 0.3) return "scope_reduced";
  if (score < 0.7) return "needs_review";
  return classes.length === 0 ? "PASS_STRUCTURAL" : "equivalent";
}

function isReadIdiom(s) {
  const from = norm(s.from);
  const to = norm(s.to);
  return READ_IDIOMS.some(([f, t]) => from === f && to === t);
}

const norm = (x) => String(x ?? "").toUpperCase().replace(/_/g, "-");
