import { test } from "node:test";
import assert from "node:assert/strict";
import { validateShared } from "../src/cli-arch-verdict.js";

// F-9.5 — the judge's app-level grouping crosses into `putEntry`, which freezes it in the CROSS-RUN verdict
// cache with no eviction path, and it is rendered into the gate artifact the operator ratifies. Members were
// already bounded (they must be arch-gated plan sigs of THIS run); the group ID was free text. An id is an
// identifier here, not prose — it names a service or app in a document a human signs off.

const plan = { nodes: [{ id: "sig-a", disposition: "re_architect" }, { id: "sig-b", disposition: "re_architect" }] };
const withId = (id) => ({ services: [{ id, members: ["sig-a"] }] });

test("a normal identifier passes", () => {
  for (const id of ["SRV_IDOC_INBOUND", "srv.orders", "app:billing", "a-b_c.d:e"]) {
    assert.deepEqual(validateShared(withId(id), plan), withId(id));
  }
});

test("an over-long id is refused before it reaches the permanent cache", () => {
  assert.throws(() => validateShared(withId("A".repeat(65)), plan), /over the 64 limit/);
});

test("prose and control characters are refused — an id is not a sentence", () => {
  const ids = ["bad id", "has spaces", ["newline", "id"].join("\n"), "tab\tid", "emoji\u{1F600}"];
  for (const id of ids) {
    assert.throws(() => validateShared(withId(id), plan), /must be/, `${JSON.stringify(id)} must be refused`);
  }
});

test("the existing member and shape guards still hold", () => {
  assert.throws(() => validateShared({ services: [{ id: "ok", members: ["sig-unknown"] }] }, plan), /not an arch-gated plan node/);
  assert.throws(() => validateShared({ nope: [] }, plan), /unknown group kind/);
  assert.throws(() => validateShared({ services: [{ id: "", members: [] }] }, plan), /no non-empty string id/);
});
