import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOverrides } from "../src/plan/replan-overrides.js";

// P3 / S-a — the operator's disposition OVERRIDES, read back out of the audited escalations register.
// PURE over (register, run_id). `decide <esc> override:<disposition>` was previously recorded and read by
// nobody; this is the read seam that makes it drive a REPLAN. Scoping is deliberate and fail-closed:
// only RESOLVED DISPOSITION_REVIEW rows, only this run, and the human's temporally FINAL decision wins.

const reg = (...escalations) => ({ escalations });
const row = (o) => ({
  id: "esc-1", kind: "DISPOSITION_REVIEW", node_ids: ["sigA"], status: "RESOLVED",
  opened_at: "2026-08-05T09:00:00.000Z", resolved_at: "2026-08-05T10:00:00.000Z",
  resolved_by: "operator", run_id: "run-A", decision: { verb: "override", disposition: "retire" }, ...o,
});

test("an empty register yields no overrides", () => {
  assert.deepEqual(collectOverrides(reg(), "run-A"), {});
});

test("a resolved override is collected with its accountable human and decision time", () => {
  const out = collectOverrides(reg(row({})), "run-A");
  assert.deepEqual(out, {
    sigA: { disposition: "retire", decided_by: "operator", decided_at: "2026-08-05T10:00:00.000Z" },
  });
});

test("scoped to the run: another run's decision never leaks in", () => {
  // escalations.json is a SHARED, cross-run register — an unscoped read would let a decision made
  // against a discarded run silently re-plan this one.
  assert.deepEqual(collectOverrides(reg(row({ run_id: "run-B" })), "run-A"), {});
});

test("the temporally FINAL decision wins across re-raise/re-decide cycles", () => {
  const out = collectOverrides(
    reg(
      row({ resolved_at: "2026-08-05T10:00:00.000Z", decision: { verb: "override", disposition: "retire" } }),
      row({ resolved_at: "2026-08-05T11:00:00.000Z", decision: { verb: "override", disposition: "refactor" } }),
    ),
    "run-A",
  );
  assert.equal(out.sigA.disposition, "refactor", "the later resolved_at governs");
});

test("a later approve SUPERSEDES an earlier override — the node keeps its classified disposition", () => {
  const out = collectOverrides(
    reg(
      row({ resolved_at: "2026-08-05T10:00:00.000Z", decision: { verb: "override", disposition: "retire" } }),
      row({ resolved_at: "2026-08-05T12:00:00.000Z", decision: { verb: "approve" } }),
    ),
    "run-A",
  );
  assert.deepEqual(out, {}, "a human who changes their mind back must not leave the override standing");
});

test("approve and other:<freeform> are not machine-applicable dispositions", () => {
  assert.deepEqual(collectOverrides(reg(row({ decision: { verb: "approve" } })), "run-A"), {});
  assert.deepEqual(collectOverrides(reg(row({ decision: { verb: "other", freeform: "ask the FI team" } })), "run-A"), {});
});

test("an OPEN row is a request, not a decision — and never voids a decision already made", () => {
  // Deliberately UNLIKE the artifact-time attestation join (cli-attest.js): at plan time there is no
  // artifact, and `disposition` is an idempotent deterministic view of the frozen plan, so a re-raise
  // carries no new information. Letting it void the override would let an innocuous re-run erase the
  // human's decision and rebuild what they said to drop.
  assert.deepEqual(collectOverrides(reg(row({ status: "OPEN", resolved_at: undefined, decision: undefined })), "run-A"), {});
  const out = collectOverrides(
    reg(row({}), row({ status: "OPEN", opened_at: "2026-08-05T13:00:00.000Z", resolved_at: undefined, decision: undefined })),
    "run-A",
  );
  assert.equal(out.sigA.disposition, "retire", "a later re-raise does not erase the earlier decision");
});

test("only DISPOSITION_REVIEW rows are read — another kind's decision is not a disposition", () => {
  const arch = row({ kind: "ARCH_REVIEW", decision: { verb: "override", disposition: "retire" } });
  assert.deepEqual(collectOverrides(reg(arch), "run-A"), {});
});

test("multi-node rows apply to every node they resolved", () => {
  const out = collectOverrides(reg(row({ node_ids: ["sigA", "sigB"] })), "run-A");
  assert.deepEqual(Object.keys(out).sort(), ["sigA", "sigB"]);
});

test("fail closed: an override naming a non-disposition throws rather than planning it", () => {
  // The value is allowlisted at WRITE time, but escalations.json is durable and hand-editable — a
  // register edited to `override:delete_everything` must not reach the frozen plan.
  assert.throws(
    () => collectOverrides(reg(row({ decision: { verb: "override", disposition: "delete_everything" } })), "run-A"),
    /not a disposition/,
  );
});

test("fail closed: an unscoped collect is refused", () => {
  assert.throws(() => collectOverrides(reg(row({})), ""), /run_id is required/);
});
