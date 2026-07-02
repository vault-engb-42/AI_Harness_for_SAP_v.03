import { releasedApiRule } from "./released-api.js";
import { invariantAuthCheckRule } from "./invariant-auth-check.js";

/**
 * The harness-owned rule registry (ALL_RULES is the source of truth). abaplint's
 * ~185 built-in rules run separately via src/abaplint-rules.js; these are the
 * TALOS-family rules the harness ports/owns on top of abaplint.
 */
export const ALL_RULES = [releasedApiRule, invariantAuthCheckRule];
