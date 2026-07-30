/**
 * The CONFORMANCE gate (BUILD_PLAN S7 / MODERNISER_DESIGN §6.13). Post-generation `output ⊨ contract`,
 * CLOSED-WORLD: every pinned object / key / field / association present, no object / field / API outside
 * the ratified Architecture Contract, every `invariants_required` satisfied. Distinct from the gap-2a
 * Clean-Core rule gate — this checks "did you build EXACTLY what was ratified" (no drift, no over-build).
 *
 * Structural comparison rides the S7 CDS-DDL extractor. Annotations are a SUPERSET check (the generator may
 * add framework annotations; the contract pins the required set); keys / fields / associations / grounded
 * APIs are closed-world. Grades only — returns ALL violations, never throws, never mutates. Pure.
 */
import { extractCdsStructure } from "../plan/cds-ddl-extract.js";

/**
 * @param {{objects: Array<{id: string, kind?: string, source?: string, declared_invariants?: string[]}>}} generated
 * @param {{objects: Array<{id: string, spec?: object, grounded_apis?: string[], invariants_required?: string[]}>}} contract
 * @returns {{ok: boolean, violations: string[]}}
 */
export function checkConformance(generated, contract) {
  const violations = [];
  const genObjects = generated?.objects ?? [];
  const contractObjects = contract?.objects ?? [];
  const contractIds = new Set(contractObjects.map((o) => o.id));
  const genById = new Map(genObjects.map((o) => [o.id, o]));

  for (const g of genObjects) {
    if (!contractIds.has(g.id)) violations.push(`object '${g.id}' is not in the contract (closed-world: no over-generation)`);
  }
  for (const c of contractObjects) {
    const g = genById.get(c.id);
    if (!g) {
      violations.push(`contract object '${c.id}' is missing from the generated set`);
      continue;
    }
    if (c.spec) checkCdsObject(c, g, violations);
    for (const inv of c.invariants_required ?? []) {
      if (!(g.declared_invariants ?? []).includes(inv)) violations.push(`object '${c.id}' dropped required invariant '${inv}'`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Compare a generated CDS object's extracted structure to the pinned spec (closed-world where noted). */
function checkCdsObject(c, g, violations) {
  const ext = extractCdsStructure(g.source ?? "");
  const spec = c.spec;
  const V = (m) => violations.push(`object '${c.id}' ${m}`);

  const specKeys = spec.keys ?? [];
  for (const k of specKeys) if (!ext.keys.includes(k)) V(`missing pinned key '${k}'`);
  for (const k of ext.keys) if (!specKeys.includes(k)) V(`has key '${k}' outside the contract`);

  const extFields = new Map(ext.fields.map((f) => [f.name, f]));
  const specFields = new Map((spec.fields ?? []).map((f) => [f.name, f]));
  for (const f of spec.fields ?? []) {
    const gf = extFields.get(f.name);
    if (!gf) V(`missing pinned field '${f.name}'`);
    else if (f.element != null && gf.element !== f.element) V(`field '${f.name}' element '${gf.element}' != pinned '${f.element}'`);
    else if (f.type != null && gf.type !== f.type) V(`field '${f.name}' type '${gf.type}' != pinned '${f.type}'`);
  }
  for (const f of ext.fields) if (!specFields.has(f.name)) V(`has field '${f.name}' outside the contract`);

  const extAssoc = new Map(ext.associations.map((a) => [a.name, a]));
  const specAssoc = new Map((spec.associations ?? []).map((a) => [a.name, a]));
  for (const a of spec.associations ?? []) {
    const ga = extAssoc.get(a.name);
    if (!ga) V(`missing pinned association '${a.name}'`);
    else if (a.target != null && ga.target !== a.target) V(`association '${a.name}' target '${ga.target}' != pinned '${a.target}'`);
  }
  for (const a of ext.associations) if (!specAssoc.has(a.name)) V(`has association '${a.name}' outside the contract`);

  const extAnn = new Map(ext.annotations.map((a) => [a.name, a.value]));
  for (const a of spec.annotations ?? []) {
    if (!extAnn.has(a.name)) V(`missing pinned annotation '${a.name}'`);
    else if (a.value != null && extAnn.get(a.name) !== a.value) V(`annotation '${a.name}' value '${extAnn.get(a.name)}' != pinned '${a.value}'`);
  }

  const refs = [ext.source, ...ext.associations.map((a) => a.target)].filter(Boolean);
  for (const r of refs) if (!(c.grounded_apis ?? []).includes(r)) V(`references ungrounded API '${r}' (not in grounded_apis)`);
}
