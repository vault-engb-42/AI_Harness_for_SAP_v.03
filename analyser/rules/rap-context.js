import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Cross-artifact RAP rules — the parity deferrals that need BDEF context
 * joined to other bundle artifacts:
 *   CC-3/CC-4   strict-mode BDEF -> its implementation class must not use
 *               CALL TRANSACTION (talos-strict-call-transaction) or direct
 *               DB writes (talos-strict-direct-db)
 *   PERF-71     draft BO child behavior declaring direct `create;`
 *   PERF-72     late-numbering draft whose in-bundle draft table lacks a
 *               DRAFTUUID key field
 *   PERF-10     unbounded SELECT inside a FOR READ handler method
 */

const DB_WRITE_STMTS = new Set(["InsertDatabase", "UpdateDatabase", "ModifyDatabase", "DeleteDatabase"]);

export const rapContextPack = {
  id: "rap-context-pack",
  family: "rap-context-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const objects = objectsOf(ctx.reg);
    const bdefs = objects.filter((o) => o.getType?.() === "BDEF");
    const tables = new Map(objects.filter((o) => o.getType?.() === "TABL").map((o) => [o.getName().toUpperCase(), o]));
    const contexts = bdefs.map((b) => parseBdef(b)).filter(Boolean);

    for (const bctx of contexts) {
      checkDraftChildren(bctx, findings);
      checkDraftTable(bctx, tables, findings);
    }
    const strictByClass = new Map();
    for (const bctx of contexts) {
      if (bctx.implClass) strictByClass.set(bctx.implClass, Math.max(bctx.strict, strictByClass.get(bctx.implClass) ?? 0));
    }
    const handlerClasses = new Set(contexts.map((c) => c.implClass).filter(Boolean));

    for (const obj of objects) {
      if (!(obj instanceof ABAPObject)) continue;
      const name = obj.getName().toUpperCase();
      const strict = strictByClass.get(name) ?? 0;
      if (strict >= 2) checkStrictClass(obj, strict, findings);
      if (handlerClasses.has(name)) checkForReadMethods(obj, findings);
    }
    return findings;
  },
};

/** @returns {{name: string, raw: string, file: string, implClass: string|null, strict: number, draft: boolean, lateNumbering: boolean, draftTable: string|null, behaviors: Array<{entity: string, body: string}>}|null} */
function parseBdef(obj) {
  const file = obj.getFiles?.()[0];
  const raw = file?.getRaw?.();
  if (!raw) return null;
  const implClass = /implementation\s+in\s+class\s+(\w+)/i.exec(raw)?.[1]?.toUpperCase() ?? null;
  const strictM = /\bstrict\s*(?:\(\s*(\d)\s*\))?\s*;/i.exec(raw);
  const strict = strictM ? Number(strictM[1] ?? 1) : 0;
  const behaviors = [];
  const re = /define\s+behavior\s+for\s+(\w+)/gi;
  const marks = [];
  let m;
  while ((m = re.exec(raw)) !== null) marks.push({ entity: m[1].toUpperCase(), start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    behaviors.push({ entity: marks[i].entity, body: raw.slice(marks[i].start, end) });
  }
  return {
    name: obj.getName(),
    raw,
    file: file.getFilename(),
    implClass,
    strict,
    draft: /\bwith\s+draft\b/i.test(raw),
    lateNumbering: /\blate\s+numbering\b/i.test(raw),
    draftTable: /\bdraft\s+table\s+(\w+)/i.exec(raw)?.[1]?.toUpperCase() ?? null,
    behaviors,
  };
}

/** PERF-71: in a draft BO, child behaviors (all blocks after the root) must
 * not declare direct `create;` — creation goes through the parent. */
function checkDraftChildren(bctx, findings) {
  if (!bctx.draft) return;
  for (const child of bctx.behaviors.slice(1)) {
    // direct create = a standalone `create;` outside association blocks
    const withoutAssoc = child.body.replace(/association\s+_\w+\s*\{[^}]*\}/gi, "");
    if (/(?<![\w_])create\s*;/i.test(withoutAssoc)) {
      push(findings, bctx, "talos-rap-draft-child-create", "priority-1", `draft BO ${bctx.name}: child entity ${child.entity} declares direct create — unsupported in draft BOs; create children via the parent (create by association) (ABAP-PERF-71)`);
    }
  }
}

/** PERF-72: late-numbering draft needs a DRAFTUUID key on its draft table. */
function checkDraftTable(bctx, tables, findings) {
  if (!(bctx.draft && bctx.lateNumbering && bctx.draftTable)) return;
  const table = tables.get(bctx.draftTable);
  if (!table) return; // draft table not in bundle — cannot judge
  const keys = (table.parsedData?.fields ?? []).filter((f) => f.KEYFLAG === "X").map((f) => String(f.FIELDNAME).toUpperCase());
  if (!keys.includes("DRAFTUUID")) {
    push(findings, bctx, "talos-rap-draft-table-no-uuid", "priority-1", `late-numbering draft BO ${bctx.name}: draft table ${bctx.draftTable} has no DRAFTUUID key field — late numbering cannot key draft instances (ABAP-PERF-72)`);
  }
}

/** CC-3 / CC-4: statements forbidden inside a strict-mode implementation class. */
function checkStrictClass(obj, strict, findings) {
  for (const file of obj.getABAPFiles()) {
    for (const st of file.getStatements()) {
      const kind = st.get()?.constructor?.name;
      const spec =
        kind === "CallTransaction"
          ? { id: "talos-strict-call-transaction", msg: `CALL TRANSACTION inside a strict(${strict}) RAP implementation class — classic transactions are forbidden at strict mode >= 2; use EML/released APIs (CC-3)` }
          : DB_WRITE_STMTS.has(kind)
            ? { id: "talos-strict-direct-db", msg: `direct database write inside a strict(${strict}) RAP implementation class — persistence goes through EML/managed save at strict mode (CC-4)` }
            : null;
      if (spec) {
        findings.push({ rule_id: spec.id, severity: "priority-1", object: obj.getName(), object_type: obj.getType(), file: file.getFilename(), line: st.getFirstToken()?.getStart()?.getRow?.() ?? 0, message: spec.msg, family: "clean-core" });
      }
    }
  }
}

/** PERF-10: SELECT without UP TO / PACKAGE SIZE inside a FOR READ method. */
function checkForReadMethods(obj, findings) {
  for (const file of obj.getABAPFiles()) {
    const raw = file.getRaw?.() ?? "";
    const readMethods = new Set();
    for (const m of raw.matchAll(/METHODS\s+(\w+)\s+FOR\s+READ\b/gi)) readMethods.add(m[1].toUpperCase());
    if (!readMethods.size) continue;
    let current = null;
    for (const st of file.getStatements()) {
      const kind = st.get()?.constructor?.name;
      const text = st.concatTokens();
      if (kind === "MethodImplementation" || kind === "Method") {
        const name = /^METHOD\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
        current = name && readMethods.has(name) ? name : null;
      } else if (kind === "EndMethod") {
        current = null;
      } else if (current && (kind === "Select" || kind === "SelectLoop")) {
        if (!/\bUP\s+TO\b|\bPACKAGE\s+SIZE\b/i.test(text)) {
          findings.push({ rule_id: "talos-rap-read-unbounded", severity: "priority-1", object: obj.getName(), object_type: obj.getType(), file: file.getFilename(), line: st.getFirstToken()?.getStart()?.getRow?.() ?? 0, message: `SELECT inside FOR READ method ${current} has no UP TO/paging bound — a read-list must never materialize the whole collection (ABAP-PERF-10)`, family: "rap-odata" });
        }
      }
    }
  }
}

function push(findings, bctx, rule_id, severity, message) {
  findings.push({ rule_id, severity, object: bctx.name, object_type: "BDEF", file: bctx.file, line: 1, message, family: "rap-odata" });
}
