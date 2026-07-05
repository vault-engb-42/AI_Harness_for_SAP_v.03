import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Flow/window analyses over the statement stream — the parity deferrals that
 * need statement-range context rather than single-statement matching:
 *   PERF-34   lock held across unrelated external calls (ENQUEUE_..DEQUEUE_ window)
 *   HARDY-6   field-symbol assigned in a loop, used after ENDLOOP without UNASSIGN
 *   PERF-5    heavy per-row calculation in a loop (AMDP/table-function candidate;
 *             threshold-calibrated advisory — see PARITY.md)
 *   PERF-31   GET_ENTITYSET handling $filter in ABAP (unfiltered SELECT)
 *   CLOUD-28  app-level legacy-UI rollup (3+ legacy UI statements per object)
 */

const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);
const HEAVY_CALC_THRESHOLD = 8;
const LEGACY_UI_THRESHOLD = 3;
const LEGACY_UI_RE = /^(?:WRITE\b|CALL\s+SCREEN\b|SET\s+SCREEN\b|LEAVE\s+(?:SCREEN|PROGRAM)\b|CALL\s+FUNCTION\s+'REUSE_ALV)/i;
// ABAP requires spaces around arithmetic operators (`a + b`), while a structure
// field selector is unspaced (`struct-comp`) — so a SPACED operator distinguishes
// genuine arithmetic from a field move. Literals are blanked first so a `/`/`-`
// inside a string is not miscounted.
const ARITH_ASSIGN_RE = /^\w[\w-]*\s*=\s*.*\s[-+*/]+\s/;

export const flowPack = {
  id: "flow-pack",
  family: "flow-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (!(obj instanceof ABAPObject)) continue;
      // CLOUD-28 is an app-level rollup, so the legacy-UI count aggregates
      // across ALL of the object's includes and emits at most once per object.
      let legacyUiCount = 0;
      let firstLegacyUi = null; // { st, file }
      for (const file of obj.getABAPFiles()) {
        const ui = scanFile(file, obj, findings);
        legacyUiCount += ui.count;
        if (!firstLegacyUi && ui.firstSt) firstLegacyUi = { st: ui.firstSt, file };
      }
      if (legacyUiCount >= LEGACY_UI_THRESHOLD && firstLegacyUi) {
        findings.push({
          rule_id: "talos-legacy-ui-rollup",
          severity: "priority-2",
          object: obj.getName(),
          object_type: obj.getType(),
          file: firstLegacyUi.file.getFilename(),
          line: firstLegacyUi.st?.getFirstToken()?.getStart()?.getRow?.() ?? 1,
          message: `${legacyUiCount} classic-UI statements (WRITE/Dynpro/ALV) in this object — the app rides the legacy UI stack; target RAP/Fiori (CLOUD-28)`,
          family: "clean-core",
        });
      }
    }
    return findings;
  },
};

function scanFile(file, obj, findings) {
  const stmts = file.getStatements();
  const mk = (rule_id, severity, message, family, st) =>
    findings.push({ rule_id, severity, object: obj.getName(), object_type: obj.getType(), file: file.getFilename(), line: st?.getFirstToken()?.getStart()?.getRow?.() ?? 1, message, family });

  const raw = file.getRaw?.() ?? "";
  const entitysetMethods = new Set([...raw.matchAll(/METHODS\s+(\w*get_entityset\w*)/gi)].map((m) => m[1].toUpperCase()));

  let depth = 0;
  let lockHolder = null; // { name, st }
  let loopCalcCount = 0;
  let loopStart = null;
  const loopAssigns = new Map(); // <fs> -> assign statement (from the last closed loop)
  let currentMethod = null;
  let legacyUiCount = 0;
  let firstLegacyUi = null;

  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    const kind = st.get()?.constructor?.name;
    const text = st.concatTokens();

    trackLock(kind, text, st, mk, { get holder() { return lockHolder; }, set holder(v) { lockHolder = v; } });

    if (kind === "MethodImplementation" || kind === "Method") {
      currentMethod = /^METHOD\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
    } else if (kind === "EndMethod") {
      currentMethod = null;
      loopAssigns.clear();
      lockHolder = null; // an enqueue window cannot legitimately span a method boundary
    }

    if (currentMethod && entitysetMethods.has(currentMethod) && (kind === "Select" || kind === "SelectLoop") && !/\bWHERE\b/i.test(text)) {
      mk("talos-filter-not-delegated", "priority-2", `unfiltered SELECT inside ${currentMethod} — $filter must push down to the WHERE clause, not be applied in ABAP after the fetch (ABAP-PERF-31)`, "rap-odata", st);
    }

    if (LEGACY_UI_RE.test(text)) {
      legacyUiCount++;
      firstLegacyUi ??= st;
    }

    if (LOOP_OPEN.has(kind)) {
      if (depth === 0) {
        loopCalcCount = 0;
        loopStart = st;
      }
      depth++;
    } else if (LOOP_CLOSE.has(kind)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && loopCalcCount >= HEAVY_CALC_THRESHOLD) {
        mk("talos-heavy-loop-calc", "priority-3", `${loopCalcCount} arithmetic assignments per row in this loop — push the calculation down to CDS/AMDP (ABAP-PERF-5; threshold ${HEAVY_CALC_THRESHOLD})`, "performance", loopStart);
      }
    } else if (depth > 0) {
      if (ARITH_ASSIGN_RE.test(text.replace(/'[^']*'/g, "''"))) loopCalcCount++;
      const fs = /^ASSIGN\b.*\bTO\s+FIELD-SYMBOL\(?(<\w+>)/i.exec(text)?.[1] ?? /^ASSIGN\b.*\bTO\s+(<\w+>)/i.exec(text)?.[1];
      if (fs) loopAssigns.set(fs.toUpperCase(), st);
    } else {
      checkDanglingFs(text, loopAssigns, mk, st);
    }
  }

  // The legacy-UI rollup is aggregated per object in check(), not per file.
  return { count: legacyUiCount, firstSt: firstLegacyUi };
}

/** PERF-34: between ENQUEUE_* and its DEQUEUE_*, unrelated external calls hold the lock. */
function trackLock(kind, text, st, mk, lock) {
  if (kind === "CallFunction") {
    const fm = /CALL\s+FUNCTION\s+'([^']+)'/i.exec(text)?.[1]?.toUpperCase() ?? "";
    if (fm.startsWith("ENQUEUE_")) {
      lock.holder = { name: fm, st };
      return;
    }
    if (fm.startsWith("DEQUEUE_")) {
      lock.holder = null;
      return;
    }
    if (lock.holder) {
      mk("talos-lock-held-across-calls", "priority-2", `lock ${lock.holder.name} is still held while calling ${fm} — keep the enqueue window minimal; call before locking or after DEQUEUE (ABAP-PERF-34)`, "performance", st);
      lock.holder = null; // one finding per window
    }
  }
}

/** HARDY-6: a loop-assigned field symbol referenced after the loop without UNASSIGN. */
function checkDanglingFs(text, loopAssigns, mk, st) {
  if (loopAssigns.size === 0) return;
  const un = /^UNASSIGN\s+(<\w+>)/i.exec(text)?.[1];
  if (un) {
    loopAssigns.delete(un.toUpperCase());
    return;
  }
  // An `IS [NOT] ASSIGNED` / `IS BOUND` check is a defensive guard on the field
  // symbol, not a dangling deref — clear it rather than flag it.
  const guarded = /(<\w+>)\s+IS\s+(?:NOT\s+)?(?:ASSIGNED|BOUND)\b/i.exec(text)?.[1];
  if (guarded) {
    loopAssigns.delete(guarded.toUpperCase());
    return;
  }
  for (const [fs] of loopAssigns) {
    if (text.toUpperCase().includes(fs)) {
      mk("talos-dangling-field-symbol", "priority-2", `${fs} was assigned inside the loop and is used after ENDLOOP — it dangles on the last row (or stays unassigned for an empty table); UNASSIGN or re-ASSIGN first (HARDY-6)`, "invariant", st);
      loopAssigns.delete(fs);
    }
  }
}
