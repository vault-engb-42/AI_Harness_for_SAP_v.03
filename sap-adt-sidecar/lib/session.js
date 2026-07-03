import { parseSetCookies, cookieHeader, isValidCsrfToken, buildBaseUrl, withSapClient } from "./session-utils.js";

/**
 * A real SAP ADT HTTP session, ported from the TALOS accelerator's
 * SAPADTClient auth flow (spec: discovery GET with basic auth + csrf fetch +
 * manual cookie capture; every request carries Authorization + Cookie +
 * x-csrf-token + x-sap-adt-sessiontype and ?sap-client=).
 *
 * Port fix (spec "CRITICAL"): the TALOS adapter never authenticated before
 * dispatch, null-dereferencing on several paths. Here authenticate() is
 * called eagerly by the server before any handler runs.
 *
 * TLS note: a self-signed S/4 (trial) certificate needs
 * NODE_TLS_REJECT_UNAUTHORIZED=0 on the sidecar process (documented in the
 * README); the X-SAP-SSL-Verify header keeps its upstream meaning
 * (https vs http scheme), unchanged for compatibility.
 */

const TIMEOUT_MS = 60_000;
const DISCOVERY = "/sap/bc/adt/discovery";
const CSRF_SOURCES = [DISCOVERY, "/sap/bc/adt/repository/nodestructure", "/sap/bc/adt/packages"];

export class SapSession {
  /**
   * @param {{host: string, port: string, client: string, username: string,
   *          password: string, language?: string, secure?: boolean}} conn
   */
  constructor(conn) {
    this.conn = conn;
    const host = conn.secure === false && !/^https?:\/\//i.test(conn.host) ? `http://${conn.host}` : conn.host;
    this.baseUrl = buildBaseUrl(host, conn.port);
    this.cookies = {};
    this.csrfToken = null;
    this.authenticated = false;
  }

  /** @returns {string} Basic auth header value */
  basicAuth() {
    return "Basic " + Buffer.from(`${this.conn.username}:${this.conn.password}`).toString("base64");
  }

  /**
   * Headers for every ADT request (spec: _get_appropriate_headers). SAP
   * validates the CSRF token against the session cookies — both must travel.
   * @param {Record<string, string>} [extra]
   */
  headers(extra = {}) {
    const h = {
      Authorization: this.basicAuth(),
      "x-sap-adt-sessiontype": "stateful",
      "x-csrf-token": isValidCsrfToken(this.csrfToken) ? this.csrfToken : "fetch",
      "User-Agent": "ABAP-Harness-ADT-Sidecar/1.0.0",
      ...extra,
    };
    const cookie = cookieHeader(this.cookies);
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /**
   * Raw ADT request. Appends ?sap-client, applies the session headers, 60s
   * timeout, and absorbs Set-Cookie from every response into the jar.
   * @param {string} method
   * @param {string} path ADT path (no sap-client yet)
   * @param {{headers?: Record<string,string>, body?: string}} [opts]
   * @returns {Promise<Response>}
   */
  async request(method, path, opts = {}) {
    const url = this.baseUrl + withSapClient(path, this.conn.client);
    const res = await fetch(url, {
      method,
      headers: this.headers(opts.headers),
      body: opts.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    parseSetCookies(res.headers.getSetCookie?.() ?? [], this.cookies);
    const token = res.headers.get("x-csrf-token");
    if (isValidCsrfToken(token)) this.csrfToken = token;
    return res;
  }

  /**
   * Login: basic auth against ADT discovery, capturing CSRF token + cookies
   * (spec: _authenticate_basic sap_client.py:483-534). Throws on failure.
   */
  async authenticate() {
    const res = await this.request("GET", DISCOVERY, {
      headers: { Accept: "application/atomsvc+xml, application/xml, text/xml, */*" },
    });
    if (res.status !== 200) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`SAP ADT authentication failed: HTTP ${res.status} on ${DISCOVERY} (${body})`);
    }
    this.authenticated = true;
    return { csrfToken: this.csrfToken, cookies: Object.keys(this.cookies) };
  }

  /**
   * Ensure a real (non-placeholder) CSRF token before a write (spec:
   * _refresh_csrf_token 632-696 — try the three known token sources).
   */
  async ensureFreshCsrf() {
    if (isValidCsrfToken(this.csrfToken)) return this.csrfToken;
    for (const path of CSRF_SOURCES) {
      const res = await this.request("GET", path, { headers: { Accept: "application/xml, */*" } });
      await res.text(); // drain
      if (isValidCsrfToken(this.csrfToken)) return this.csrfToken;
    }
    throw new Error("could not obtain a CSRF token from SAP (tried discovery, nodestructure, packages)");
  }
}
