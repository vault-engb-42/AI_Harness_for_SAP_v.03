/**
 * Deterministic, recursive sorted-key JSON serializer (MODERNISER_DESIGN §6.3, L6.3).
 *
 * Every content hash the moderniser computes (plan_hash, node-state hashes) must be
 * reproducible regardless of object-key insertion order, so keys are emitted in
 * lexicographic order at every level. Arrays keep their order (arrays are ordered
 * data). Unlike the analyser's `run-identity.js` — which hashes a plain
 * `JSON.stringify` over hand-ordered literals — this is total over arbitrary nested
 * objects. The moderniser owns this ~1-function helper; a future refactor could share
 * one implementation with the analyser.
 */

/**
 * @param {*} value JSON-serializable value (no bare undefined / function / symbol /
 *   non-finite number; undefined object properties are dropped, matching JSON semantics)
 * @returns {string} canonical JSON text
 */
export function canonicalJSON(value) {
  return write(value);
}

function write(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return num(v);
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${write(v[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJSON: cannot serialize a value of type ${t}`);
}

/** Finite numbers only; `-0` is normalised to `0` so the hash is representation-stable. */
function num(n) {
  if (!Number.isFinite(n)) throw new Error(`canonicalJSON: non-finite number ${n}`);
  return Object.is(n, -0) ? "0" : JSON.stringify(n);
}
