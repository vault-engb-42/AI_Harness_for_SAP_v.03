/**
 * Oscillation detection + clustering (MODERNISER_DESIGN §3.4 #3 — L2, 7.6). A node whose
 * verdicts flip >= 2 times over its LAST 5 verdicts is thrashing: it cannot count toward
 * the ratchet and hard-escalates. Clustering by the shared root signature
 * (failing_atc_rule_id, shared_dep_id) turns one generator weakness into ONE escalation
 * with N instances — never N storms. Pure, deterministic.
 */
const WINDOW = 5;
const FLIP_THRESHOLD = 2;

/** @param {string[]} verdicts chronological verdict tokens @returns {boolean} */
export function isOscillating(verdicts) {
  const win = (verdicts ?? []).slice(-WINDOW);
  let flips = 0;
  for (let i = 1; i < win.length; i += 1) if (win[i] !== win[i - 1]) flips += 1;
  return flips >= FLIP_THRESHOLD;
}

/**
 * @param {Array<{sig: string, top_fail_rule_id?: string, shared_dep?: string, verdicts: string[]}>} nodes
 * @returns {Array<{kind: "OSCILLATION", root_signature: string, node_ids: string[]}>} sorted clusters
 */
export function clusterOscillations(nodes) {
  const groups = new Map();
  for (const n of nodes ?? []) {
    if (!isOscillating(n.verdicts)) continue;
    const key = `${n.top_fail_rule_id ?? "unknown"}|${n.shared_dep ?? "unknown"}`; // fail-safe grouping
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n.sig);
  }
  return [...groups.entries()]
    .map(([root_signature, sigs]) => ({ kind: "OSCILLATION", root_signature, node_ids: [...sigs].sort() }))
    .sort((a, b) => (a.root_signature < b.root_signature ? -1 : a.root_signature > b.root_signature ? 1 : 0));
}
