/**
 * Pure session helpers for the SAP ADT session (cookie jar, CSRF validity,
 * URL building). Ported from sap_client.py with the porting fixes the spec
 * called out: cookies split on the FIRST '=' only (SAP session ids contain
 * base64 '='), and CSRF placeholder values rejected.
 */

/**
 * @param {string[]} setCookieHeaders raw Set-Cookie header values
 * @param {Record<string, string>} [jar] existing jar to merge into
 * @returns {Record<string, string>}
 */
export function parseSetCookies(setCookieHeaders, jar = {}) {
  for (const raw of setCookieHeaders ?? []) {
    const pair = String(raw).split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

/** @param {Record<string, string>} jar @returns {string} Cookie header value */
export function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** SAP returns these placeholder values instead of a real token. */
const CSRF_PLACEHOLDERS = new Set(["required", "fetch", ""]);

/** @param {string|undefined|null} token @returns {boolean} */
export function isValidCsrfToken(token) {
  if (typeof token !== "string") return false;
  return !CSRF_PLACEHOLDERS.has(token.trim().toLowerCase());
}

/**
 * Ported from adapter.py _build_sap_url (200-208): keep an explicit scheme,
 * default to https, always append the port.
 * @param {string} host
 * @param {string} port
 * @returns {string}
 */
export function buildBaseUrl(host, port) {
  const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return `${base.replace(/\/+$/, "")}:${port}`;
}

/**
 * Every ADT URL carries ?sap-client={client} (spec: auth flow item 7).
 * @param {string} path
 * @param {string} client
 * @returns {string}
 */
export function withSapClient(path, client) {
  return `${path}${path.includes("?") ? "&" : "?"}sap-client=${client}`;
}
