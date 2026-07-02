import { releasedApiRule } from "./released-api.js";
import { invariantAuthCheckRule } from "./invariant-auth-check.js";
import { regexPack } from "./regex-pack.js";
import { statementPack } from "./statement-pack.js";

/**
 * The harness-owned rule registry (ALL_RULES is the source of truth). abaplint's
 * ~185 built-in rules run separately via src/abaplint-rules.js; these are the
 * TALOS-family rules the harness ports/owns on top of abaplint.
 *
 * Data-driven packs (regexPack, and the statement/metadata/graph packs) each
 * carry many ported TALOS rules; a pack's findings surface their own rule_id.
 */
export const ALL_RULES = [releasedApiRule, invariantAuthCheckRule, regexPack, statementPack];
