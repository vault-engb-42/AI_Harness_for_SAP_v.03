/**
 * Error sanitization + classification, ported from the TALOS adapter
 * (adapter.py _sanitize_error 134-146, _classify_error 270-277). Every error
 * detail returned to a caller passes through sanitizeError so credentials
 * never leak into logs or MCP tool results.
 */

/**
 * @param {string} message
 * @returns {string} credential-scrubbed message, max 500 chars
 */
export function sanitizeError(message) {
  let out = String(message ?? "");
  // userinfo in URLs: https://user:pass@host -> https://***@host
  out = out.replace(/https?:\/\/[^@\s]+@/g, "https://***@");
  // leaked credential headers: X-SAP-Password: xyz -> X-SAP-Password: ***
  out = out.replace(/(X-SAP-(?:Password|User|Host))\s*[:=]\s*\S+/gi, "$1: ***");
  return out.slice(0, 500);
}

/**
 * @param {string} message
 * @returns {401|502|500} HTTP status for the error class
 */
export function classifyError(message) {
  const m = String(message ?? "").toLowerCase();
  if (m.includes("401") || m.includes("auth") || m.includes("unauthorized")) return 401;
  if (m.includes("connect") || m.includes("unreachable")) return 502;
  return 500;
}
