/**
 * The RAP/EML idiom knowledge base — the shared first-pass-intelligence asset.
 *
 * Keyed by the analyser's structural rule_id, each entry carries the root CAUSE, the FIX, and a
 * BEFORE→AFTER exemplar of the batched / pre-loaded / guarded form the generator must emit. The
 * same asset serves two consumers:
 *   - groundingBrief(findings) — a PRE-generation "avoid these anti-patterns" block, so the
 *     generator writes the fixed form on the first pass instead of reproducing the source defect;
 *   - repairBrief(hits)       — a POST-gate "fix and regenerate" block, so a blocked node
 *     self-corrects against a concrete exemplar rather than re-deriving the batched form.
 *
 * Unknown rule_ids fall back to the finding's own one-line `message` (the analyser already embeds
 * a remediation) — the brief is never blank and never crashes. Pure. No I/O.
 */

export const IDIOM_KB = Object.freeze({
  "talos-rap-modify-in-loop": {
    cause: "MODIFY ENTITIES was issued once per loop iteration — N EML round-trips instead of one.",
    fix: "Collect every instance into one internal table inside the loop, then issue a SINGLE MODIFY ENTITIES … WITH lt_instances AFTER the loop.",
    before: "LOOP AT keys ASSIGNING FIELD-SYMBOL(<k>).\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x\n    UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = <k>-%tky f = <k>-f ) ).\nENDLOOP.",
    after: "LOOP AT keys ASSIGNING FIELD-SYMBOL(<k>).\n  APPEND VALUE #( %tky = <k>-%tky f = <k>-f ) TO lt_upd.\nENDLOOP.\nIF lt_upd IS NOT INITIAL.\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x\n    UPDATE FIELDS ( f ) WITH lt_upd REPORTED DATA(rep) FAILED DATA(fail).\nENDIF.",
  },
  "talos-select-in-loop": {
    cause: "A SELECT inside the loop makes one DB round-trip per iteration (N+1).",
    fix: "Pre-load all needed rows once BEFORE the loop with a single set-based read; READ TABLE inside the loop.",
    before: "LOOP AT keys INTO DATA(k).\n  SELECT SINGLE * FROM ztab INTO @DATA(w) WHERE id = @k-id.\nENDLOOP.",
    after: "IF keys IS NOT INITIAL.\n  SELECT id, val FROM ztab FOR ALL ENTRIES IN @keys\n    WHERE id = @keys-id ORDER BY id INTO TABLE @DATA(rows).\nENDIF.\nLOOP AT keys INTO DATA(k).\n  READ TABLE rows INTO DATA(w) WITH KEY id = k-id BINARY SEARCH.\nENDLOOP.",
  },
  "talos-rap-modify-entities-in-read-handler": {
    cause: "A FOR READ handler mutated buffer state with MODIFY ENTITIES — read paths must be side-effect-free.",
    fix: "Remove the MODIFY from the read handler; model the side effect as a FOR MODIFY action or a determination on modify/save.",
    before: "METHOD read.\n  READ ENTITIES OF zi_x IN LOCAL MODE ENTITY x ALL FIELDS WITH keys RESULT result.\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH lt_upd.\nENDMETHOD.",
    after: "METHOD read.\n  READ ENTITIES OF zi_x IN LOCAL MODE ENTITY x ALL FIELDS WITH keys RESULT result.\nENDMETHOD.\n\" the state change belongs in a FOR MODIFY action or a determination, never the read path",
  },
  "talos-rap-modify-no-guard": {
    cause: "MODIFY ENTITIES on a runtime table with no IS NOT INITIAL guard — an empty table wastes an EML call.",
    fix: "Guard the driver with IF lt_x IS NOT INITIAL. An inline WITH VALUE #( … ) literal is non-empty by construction and needs no guard.",
    before: "MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH lt_x.",
    after: "IF lt_x IS NOT INITIAL.\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH lt_x.\nENDIF.",
  },
  "talos-rap-commit-in-loop": {
    cause: "COMMIT ENTITIES inside the loop commits once per iteration instead of once per logical unit of work.",
    fix: "Issue COMMIT ENTITIES once, after the loop completes.",
    before: "LOOP AT keys INTO DATA(k).\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = k ) ).\n  COMMIT ENTITIES RESPONSE OF zi_x FAILED DATA(f).\nENDLOOP.",
    after: "LOOP AT keys INTO DATA(k).\n  APPEND VALUE #( %tky = k ) TO lt_upd.\nENDLOOP.\nIF lt_upd IS NOT INITIAL.\n  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH lt_upd.\nENDIF.\nCOMMIT ENTITIES RESPONSE OF zi_x FAILED DATA(f).",
  },
});

const indent = (block) => block.split("\n").map((l) => `      ${l}`).join("\n");

/** Render one finding/hit into a KB-backed item, or fall back to its own message. */
function renderItem(item) {
  const loc = `${item.file ?? "?"}:${item.line ?? "?"}`;
  const e = IDIOM_KB[item.rule_id];
  if (!e) return `- [${item.rule_id}] ${loc} — ${item.message ?? "(no detail)"}`;
  return (
    `- [${item.rule_id}] ${loc} — ${e.cause}\n  FIX: ${e.fix}\n` +
    `  BEFORE:\n${indent(e.before)}\n  AFTER:\n${indent(e.after)}`
  );
}

const render = (items, header) => {
  const list = (items ?? []).filter((i) => i && i.rule_id);
  return list.length === 0 ? "" : `${header}\n\n${list.map(renderItem).join("\n\n")}`;
};

/**
 * PRE-generation grounding: the object's known structural anti-patterns, framed so the generator
 * emits the fixed form directly rather than reproducing them.
 * @param {Array<{rule_id: string, file?: string, line?: number, message?: string}>} findings
 * @returns {string}
 */
export function groundingBrief(findings) {
  return render(findings, "Known anti-patterns in the source you are rewriting — do NOT reproduce these; emit the fixed form directly:");
}

/**
 * POST-gate repair: the structural defects the offline rule gate blocked, framed for regeneration.
 * @param {Array<{rule_id: string, file?: string, line?: number, message?: string}>} hits
 * @returns {string}
 */
export function repairBrief(hits) {
  return render(hits, "The offline rule gate blocked your output on these structural defects — fix each and regenerate:");
}
