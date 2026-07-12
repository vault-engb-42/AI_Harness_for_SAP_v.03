import { test } from "node:test";
import assert from "node:assert/strict";
import { tryPark, reEnter } from "../src/exception/park.js";

// §3.4 #5 (L7) — the PARK register: bounded, audited, distinct from a P4 waiver. Parking
// requires the deterministic NO_RELEASED_SUCCESSOR reason AND a named human sign-off with
// justification; parked nodes re-enter when the cloudification registry ships the
// successor. Pure copy-on-write over the park-register file shape (§3.4 #6).

const A = "a".repeat(64);
const B = "b".repeat(64);
const empty = () => ({ parked: [] });
const signoff = { signed_by: "j.doe", justification: "BKPF direct write has no released successor yet", successor_probe: "I_JOURNALENTRYTP", ts: "T1" };

test("a valid park records the full audited row", () => {
  const r = tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff });
  assert.deepEqual(r.parked, [
    {
      node_id: A,
      reason: "NO_RELEASED_SUCCESSOR",
      signed_by: "j.doe",
      justification: "BKPF direct write has no released successor yet",
      successor_probe: "I_JOURNALENTRYTP",
      parked_at: "T1",
    },
  ]);
});

test("parking is refused without the deterministic reason, a named signer, or a justification (L7)", () => {
  assert.throws(() => tryPark(empty(), A, { reason: "P4_VIOLATION", ...signoff }), /NO_RELEASED_SUCCESSOR/i, "never a defect park");
  assert.throws(() => tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff, signed_by: undefined }), /sign/i);
  assert.throws(() => tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff, justification: "" }), /justif/i);
});

test("double-parking the same node is refused (bounded register)", () => {
  const r = tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff });
  assert.throws(() => tryPark(r, A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff }), /already/i);
});

test("reEnter releases exactly the nodes whose successor now ships, keeping the rest parked", () => {
  let r = tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff });
  r = tryPark(r, B, { reason: "NO_RELEASED_SUCCESSOR", ...signoff, successor_probe: "I_SUPPLIERINVOICE" });
  const { register, reentered } = reEnter(r, { available: new Set(["I_JOURNALENTRYTP"]) });
  assert.deepEqual(reentered, [A], "A's probed successor shipped");
  assert.deepEqual(register.parked.map((p) => p.node_id), [B], "B stays parked");
  assert.deepEqual(r.parked.length, 2, "input register untouched (copy-on-write)");
});

test("reEnter with nothing available is a no-op; the register is never mutated", () => {
  const r = tryPark(empty(), A, { reason: "NO_RELEASED_SUCCESSOR", ...signoff });
  const { register, reentered } = reEnter(r, { available: new Set() });
  assert.deepEqual(reentered, []);
  assert.deepEqual(register, r);
});
