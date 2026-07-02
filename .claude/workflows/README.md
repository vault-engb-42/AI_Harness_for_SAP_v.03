# Workflows

Dynamic multi-agent workflows. Each `.js` file here auto-registers as a `/<name>` slash command (from its `export const meta` block) — fan out subagents, verify, synthesize.

This harness ships **no** built-in workflows: the lanes in `.claude/skills/` already cover the SAP SDLC. Author project-specific workflows here when a task needs deterministic multi-agent orchestration beyond a single lane — e.g. a package-wide brownfield sweep (`abap-explorer` per package), a mass S/4-readiness audit, or a fan-out `/abap-validate` across every open story group.
