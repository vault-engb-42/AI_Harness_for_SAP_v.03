/**
 * S/4HANA readiness status normalization and effort-tier mapping.
 *
 * The raw status of an API/object comes from two sources with different
 * vocabularies: the bundled cloudification dataset and live ADT
 * get_migration_analysis. Both are folded into a controlled enum
 * (released | deprecated | removed | unknown), which maps to the
 * analyser-findings schema's node.effort_tier
 * (keep-and-clean | re-platform | retire | unknown).
 */

/** @typedef {"released"|"deprecated"|"removed"|"unknown"} S4Status */

/**
 * Raw status alias -> normalized S4Status. Covers both the bundled
 * cloudification dataset vocabulary (released / deprecated / notToBeReleased
 * from objectReleaseInfo; classicAPI / noAPI from objectClassifications) and
 * live ADT get_migration_analysis synonyms.
 */
const STATUS_ALIASES = new Map([
  ["released", "released"],
  ["released_with_restrictions", "released"],
  ["classified", "released"],
  ["not_released", "deprecated"],
  ["not_released_in_cloud", "deprecated"],
  ["nottobereleased", "deprecated"], // dataset: no cloud release path -> re-platform
  ["classicapi", "deprecated"], // dataset: classic API, migrate to released successor
  ["deprecated", "deprecated"],
  ["obsolete", "deprecated"],
  ["noapi", "removed"], // dataset: no API path forward -> retire the usage
  ["removed", "removed"],
  ["deleted", "removed"],
  ["not_available", "removed"],
]);

/**
 * @param {string|null|undefined} raw
 * @returns {S4Status}
 */
export function normalizeS4Status(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "unknown";
  return STATUS_ALIASES.get(raw.trim().toLowerCase()) ?? "unknown";
}

/** Normalized S4Status -> effort tier. */
const STATUS_TO_TIER = {
  released: "keep-and-clean",
  deprecated: "re-platform",
  removed: "retire",
  unknown: "unknown",
};

/**
 * @param {string|null|undefined} status raw or normalized status
 * @returns {"retire"|"re-platform"|"keep-and-clean"|"unknown"}
 */
export function effortTierForStatus(status) {
  return STATUS_TO_TIER[normalizeS4Status(status)];
}
