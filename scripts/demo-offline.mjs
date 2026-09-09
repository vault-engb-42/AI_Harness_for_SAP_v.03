/**
 * `npm run demo:offline` — the offline pipeline, end to end, from a CLEAN CHECKOUT.
 *
 * No SAP, no credentials, no MCP, and NO CORPUS FETCH. Every input it touches is tracked in git: the
 * hand-written MIT seam bundle and the committed demo findings docs. That constraint is the point — the
 * documented entry command was red on a fresh clone for weeks because it depended on git-ignored
 * third-party ABAP, and a demo that cannot be run is a claim rather than a demonstration.
 *
 * Writes only into a temp directory; the repository is left untouched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT = mkdtempSync(join(tmpdir(), "harness-demo-"));
const run = (...a) => execFileSync(process.execPath, a, { encoding: "utf8" });
const json = (...a) => JSON.parse(run(...a));
const step = (n, what, detail) => console.log(`${String(n).padStart(2)}. ${what.padEnd(34)} ${detail}`);

console.log(`\nSAP ABAP Harness — offline pipeline demo\nworkspace: ${OUT}\n${"-".repeat(72)}`);

// 1 — ANALYSE. The analyser builds a code property graph over real (hand-written, MIT) classic ABAP.
const findings = join(OUT, "analyser-findings.json");
run("analyser/cli.js", "moderniser/test/fixtures/seam-bundle/before",
  "--package", "ZSM_SEAM", "--out", findings, "--html", join(OUT, "report.html"));
const doc = JSON.parse(readFileSync(findings, "utf8"));
step(1, "analyse the classic package",
  `${doc.findings.length} findings · ${doc.graph.nodes.length} nodes · S/4 ${doc.s4_readiness.s4_readiness_pct}% · grade ${doc.code_health.clean_core_grade}`);

// 2 — PLAN. A content-hashed, bottom-up dependency plan. Same input always yields the same plan_hash.
const state = ["--state-dir", join(OUT, "state"), "--runs-dir", join(OUT, "runs")];
const planned = json("moderniser/src/cli.js", "plan", findings, ...state);
step(2, "freeze a content-hashed plan", `${planned.run_id} · ${Array.isArray(planned.nodes) ? planned.nodes.length : planned.nodes} nodes · ${Array.isArray(planned.waves) ? planned.waves.length : planned.waves} waves`);

// 3 — GATE 1. Disposition: what should happen to each object, and which need a human.
const disp = json("moderniser/src/cli.js", "disposition", planned.run_id, ...state);
step(3, "disposition gate", `${disp.summary.prompt_count} prompted · ${disp.summary.auto_count} auto`);

// 4 — GATE 2. Architecture: a target shape per re-architected object, or an honest "no shape fits".
const arch = json("moderniser/src/cli.js", "arch", planned.run_id, findings, ...state);
step(4, "architecture gate",
  `${arch.resolved} resolved · ${arch.pending} awaiting a judge · ${arch.unplaceable.length} unplaceable`);

// 5 — The human gates, rendered as the operator actually sees them.
const packets = json("moderniser/src/cli.js", "packets", planned.run_id, "--max", "50", ...state).packets;
const kinds = [...new Set(packets.map((p) => p.kind))];
step(5, "surface the human gates", `${packets.length} packet(s): ${kinds.join(", ") || "none"}`);

// 6 — The before/after comparison, recomputed from committed evidence rather than read from a file.
const cmp = json("analyser/cli.js", "compare",
  "demos/equalize-idoc-2026-07-29/before/analyser-findings.json",
  "demos/equalize-idoc-2026-07-29/after/analyser-findings.json");
const row = (l) => [...cmp.readiness, ...cmp.quality].find((q) => q.label === l);
step(6, "before/after on a real corpus",
  `S/4 ${row("S/4HANA-ready").before}% -> ${row("S/4HANA-ready").after}% · findings ${row("Total findings").before} -> ${row("Total findings").after}`);

console.log(`${"-".repeat(72)}
The offline half is fully demonstrable with no SAP and no fetch. What is NOT shown here needs a live
DEV tier and is refused rather than faked: push, activate, ATC, ABAP Unit, and a GREEN verdict. Offline
never reaches GREEN by design (P6) — it reaches a provisional verdict and a proof bundle a human reads.

Artifacts: ${OUT}\n`);
