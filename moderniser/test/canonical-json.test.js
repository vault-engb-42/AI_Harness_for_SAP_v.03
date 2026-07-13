import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJSON } from "../src/state/canonical-json.js";

// §6.3 / L6.3 — a recursive sorted-key serializer so every content hash the
// moderniser computes is reproducible regardless of key insertion order.

test("canonicalJSON sorts object keys recursively — insertion order irrelevant", () => {
  const a = canonicalJSON({ b: 1, a: { d: 4, c: 3 } });
  const b = canonicalJSON({ a: { c: 3, d: 4 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
});

test("L3: non-plain objects (Date/Map/Set) throw — never a silent '{}' hash degeneracy", () => {
  assert.throws(() => canonicalJSON(new Date(1)), /non-plain/i);
  assert.throws(() => canonicalJSON({ t: new Map([["a", 1]]) }), /non-plain/i);
  assert.throws(() => canonicalJSON([new Set([1])]), /non-plain/i);
  // plain shapes are untouched, including null-prototype objects
  assert.equal(canonicalJSON({ a: 1 }), '{"a":1}');
  assert.equal(canonicalJSON(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');
});

test("canonicalJSON preserves array order (arrays are ordered data)", () => {
  assert.equal(canonicalJSON([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalJSON([1, 2]), canonicalJSON([2, 1]));
});

test("canonicalJSON round-trips (parse deep-equals the original)", () => {
  const v = { z: [1, { y: "x" }], a: true, n: null, f: 0.25 };
  assert.deepEqual(JSON.parse(canonicalJSON(v)), v);
});

test("canonicalJSON escapes strings and drops undefined object properties", () => {
  assert.equal(canonicalJSON({ k: 'a"b\\c' }), '{"k":"a\\"b\\\\c"}');
  assert.equal(canonicalJSON({ a: 1, b: undefined }), '{"a":1}');
});

test("canonicalJSON normalises -0 to 0 and rejects non-finite / bare undefined", () => {
  assert.equal(canonicalJSON(-0), "0");
  assert.equal(canonicalJSON(0), "0");
  assert.throws(() => canonicalJSON(NaN));
  assert.throws(() => canonicalJSON(Infinity));
  assert.throws(() => canonicalJSON(undefined));
});

test("canonicalJSON sorts keys of objects INSIDE arrays (element key-order independent)", () => {
  assert.equal(canonicalJSON([{ b: 1, a: 2 }]), canonicalJSON([{ a: 2, b: 1 }]));
  assert.equal(canonicalJSON([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});

test("canonicalJSON throws on a circular reference; a shared (DAG) sibling is fine", () => {
  const o = { a: 1 };
  o.self = o;
  assert.throws(() => canonicalJSON(o), /circular/);
  const shared = { x: 1 };
  assert.equal(canonicalJSON({ p: shared, q: shared }), '{"p":{"x":1},"q":{"x":1}}');
});
