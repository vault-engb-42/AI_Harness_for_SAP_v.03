// model-tier.js — re-tune the SAP agent roster's model pins with one command.
// Presets: cost / balanced (shipped default) / max-quality. Generation runs on
// Sonnet, judgment on Opus; --apply rewrites each agent file's `model:` line.
//
//   node .claude/scripts/model-tier.js --print <preset>
//   node .claude/scripts/model-tier.js --apply <preset>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";

const ROLES = [
  "planner",
  "abap-generator",
  "abap-evaluator",
  "abap-design-critic",
  "abap-security-reviewer",
  "abap-diff-reviewer",
  "clean-core-reviewer",
  "abap-explorer",
  "transport-manager",
  // Reasoned-architecture (B3.5, S14): the judgment-correctness reviewer (an agent file) and the
  // `arch-judge` LOGICAL role — fileless, its pinned model_id keys the verdict cache so a model swap is
  // a surfaced MISS (never silent). Both run judgment on Opus in every preset (not in any sonnet list).
  "abap-arch-reviewer",
  "arch-judge",
];

// Every role on Opus except those named — the harness spends Opus on judgment.
const allOpusExcept = (sonnetRoles) =>
  Object.fromEntries(ROLES.map((r) => [r, sonnetRoles.includes(r) ? SONNET : OPUS]));

export const PRESETS = {
  cost: allOpusExcept(["abap-generator", "abap-explorer", "transport-manager"]),
  balanced: allOpusExcept(["abap-generator", "abap-explorer", "transport-manager"]),
  "max-quality": allOpusExcept(["abap-explorer"]),
};

// The model id for a role under a preset, or null if either is unknown.
export function modelForRole(preset, role) {
  const p = PRESETS[preset];
  if (!p || !(role in p)) return null;
  return p[role];
}

// Replace the frontmatter `model:` line (first, anchored) with the given model.
export function rewriteModelLine(content, model) {
  return content.replace(/^model:\s*.*$/m, `model: ${model}`);
}

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

// Apply a preset to every agent file; returns the roles whose model changed.
function applyPreset(preset, { write }) {
  const changed = [];
  for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))) {
    const role = file.replace(/\.md$/, "");
    const model = modelForRole(preset, role);
    if (!model) continue;
    const path = join(AGENTS_DIR, file);
    const content = readFileSync(path, "utf8");
    const next = rewriteModelLine(content, model);
    if (next !== content) {
      changed.push(`${role} -> ${model}`);
      if (write) writeFileSync(path, next);
    }
  }
  return changed;
}

function main(argv) {
  const [flag, preset] = argv;
  if (!["--print", "--apply"].includes(flag) || !PRESETS[preset]) {
    process.stderr.write("usage: model-tier.js --print|--apply <cost|balanced|max-quality>\n");
    process.exit(1);
  }
  if (flag === "--print") {
    for (const role of ROLES) process.stdout.write(`${role}: ${modelForRole(preset, role)}\n`);
    return;
  }
  const changed = applyPreset(preset, { write: true });
  process.stdout.write(changed.length ? `updated ${changed.length} role(s):\n${changed.join("\n")}\n` : `no changes — already ${preset}\n`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
