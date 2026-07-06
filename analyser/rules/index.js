import { releasedApiRule } from "./released-api.js";
import { invariantAuthCheckRule } from "./invariant-auth-check.js";
import { regexPack } from "./regex-pack.js";
import { statementPack } from "./statement-pack.js";
import { metadataPack } from "./metadata-pack.js";
import { graphPack } from "./graph-pack.js";
import { cdsStructurePack } from "./cds-structure.js";
import { missingTestClassRule } from "./missing-test-class.js";
import { ddicPack } from "./ddic-pack.js";
import { rapContextPack } from "./rap-context.js";
import { flowPack } from "./flow-pack.js";
import { clonePack } from "./clone-pack.js";
import { intfPack } from "./intf-pack.js";
import { testQualityPack } from "./test-quality-pack.js";
import { bfPack } from "./bf-pack.js";
import { srvbPack } from "./srvb-pack.js";

/**
 * The harness-owned rule registry (ALL_RULES is the source of truth). abaplint's
 * ~185 built-in rules run separately via src/abaplint-rules.js; these are the
 * TALOS-family rules the harness ports/owns on top of abaplint.
 *
 * Data-driven packs (regexPack, and the statement/metadata/graph packs) each
 * carry many ported TALOS rules; a pack's findings surface their own rule_id.
 */
export const ALL_RULES = [
  releasedApiRule,
  invariantAuthCheckRule,
  regexPack,
  statementPack,
  metadataPack,
  graphPack,
  cdsStructurePack,
  missingTestClassRule,
  ddicPack,
  rapContextPack,
  flowPack,
  clonePack,
  intfPack,
  testQualityPack,
  bfPack,
  srvbPack,
];
