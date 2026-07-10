/**
 * Deterministic, recursive sorted-key JSON serializer (MODERNISER_DESIGN §6.3, L6.3).
 *
 * Every content hash the moderniser computes (plan_hash, node-state hashes) must be
 * reproducible regardless of object-key insertion order, so keys are emitted in
 * lexicographic order at every level. Arrays keep their order (arrays are ordered
 * data — callers that treat an array as a *set*, e.g. a dependency list, must sort it
 * before hashing; see plan.js `canonicalNodes`). Total over finite, **acyclic** JSON
 * values; a circular reference throws rather than looping. Unlike the analyser's
 * `run-identity.js` (plain `JSON.stringify` over hand-ordered literals) this is total
 * over arbitrary nested objects.
 */

/**
 * @param {*} value JSON-serializable, acyclic value (no bare undefined / function /
 *   symbol / non-finite number; undefined object properties are dropped, matching JSON)
 * @returns {string} canonical JSON text
 */
export function canonicalJSON(value) {
  return write(value, new WeakSet());
}

function write(v, seen) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") return num(v);
  if (t === "string") return JSON.stringify(v);
  if (t === "object") {
    if (seen.has(v)) throw new Error("canonicalJSON: circular reference");
    seen.add(v);
    const out = Array.isArray(v)
      ? `[${v.map((x) => write(x, seen)).join(",")}]`
      : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${write(v[k], seen)}`).join(",")}}`;
    seen.delete(v); // sibling reuse (a DAG shape) is fine; only true cycles throw
    return out;
  }
  throw new Error(`canonicalJSON: cannot serialize a value of type ${t}`);
}

/** Finite numbers only; `-0` is normalised to `0` so the hash is representation-stable. */
function num(n) {
  if (!Number.isFinite(n)) throw new Error(`canonicalJSON: non-finite number ${n}`);
  return Object.is(n, -0) ? "0" : JSON.stringify(n);
}
