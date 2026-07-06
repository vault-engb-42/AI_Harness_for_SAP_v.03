# sap-adt-sidecar — machine notes

> Audience: a Claude session (or engineer) with zero memory of the port. This
> is the operating manual + provenance record for the harness's own MCP-ADT
> sidecar. Read this BEFORE modifying anything under `sap-adt-sidecar/`.

## What this is

The harness's real ADT backend: a Node HTTP service implementing the 17
`aws_abap_cb_*` tools against a live SAP system via the ADT REST protocol.
It is a **port** of the TALOS reference (`TALOS-SAP-S4HANA-SDLC-Accelerator/
docker/sap-adt/{adapter.py, real_handlers.py, real_handler_serializers.py}`),
rebuilt as real working code under the operator directive (2026-07-03,
verbatim): *"all stubs, mocks, fakes will turn into real working functional
code, stub tests will become end to end tests."* There is **no mock mode** —
do not add one.

Call chain in production:
`Claude agent → mcp-adt-bridge (MCP stdio) → THIS sidecar (HTTP 127.0.0.1:8090) → SAP ADT REST`.

## Contract (kept bridge-compatible — do not break)

- `POST /mcp` body `{"tool": "<aws_abap_cb_*>", "params": {...}}` +
  credential headers `X-SAP-Host` (required), `X-SAP-User` (required),
  `X-SAP-Password` (required), `X-SAP-Port` (default 44300), `X-SAP-Client`
  (default 100), `X-SAP-Language` (default EN), `X-SAP-SSL-Verify`
  (default true; upstream semantics = https-vs-http scheme, NOT cert check).
- Success: `200 {"result": <tool payload>}`. Errors: `{"detail": "<sanitized>"}`
  with 400 (bad body/missing tool/missing headers), 404 (unknown tool),
  401/502/500 via `lib/security.js` `classifyError`. Every error detail passes
  `sanitizeError` — credentials must never appear in a response or log.
- `GET /health` → `{status, adapter, version, mode: "real", mode_reason}`.
- Env: `ADAPTER_PORT` (default 8090; `0` = ephemeral, actual port printed on
  stdout as `listening on http://127.0.0.1:<port>`). Binds **127.0.0.1 only**
  (parallel-safety rule; the TALOS reference bound 0.0.0.0 — do not regress).
- TLS: for self-signed (trial) SAP certificates run the sidecar with
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. There is no per-request cert toggle.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | HTTP envelope, credential extraction, tool routing, eager auth |
| `lib/session.js` | `SapSession`: discovery login (basic auth + `x-csrf-token: fetch`), manual cookie jar, header assembly, `?sap-client=` on every URL, 60s timeout, CSRF refresh for writes |
| `lib/session-utils.js` | pure: cookie parse (**first `=` only** — SAP session ids contain base64 `=`), CSRF placeholder rejection (`Required`/`Fetch`/`fetch`), URL builders |
| `lib/adt-xml.js` | fast-xml-parser wrapper, **namespace-agnostic** (`removeNSPrefix`) because SAP prefixes vary by release; `findAll(doc, localName)` + `attr(el, name)` |
| `lib/adt-uris.js` | every type→URI decision: object roots, activation URIs + subtypes, creation collections + content types, ATC/source URIs |
| `lib/security.js` | `sanitizeError` (URL userinfo + X-SAP header scrub, 500-char cap), `classifyError` |
| `handlers/read.js` | connection_status, get_objects, get_source, search_object, get_test_classes, get_transport_requests, scmon/smodilog |
| `handlers/quality.js` | check_syntax, activate_object(+batch), run_atc_check, run_unit_tests, get_migration_analysis |
| `handlers/write.js` | create_object, update_source, create_or_update_test_class (lock → PUT → unlock) |

## Deliberate divergences from the TALOS reference (do NOT "fix" these back)

1. **Write tools are real.** Reference returned hardcoded `{created: true}` /
   `{updated: true}` without touching SAP (`real_handlers.py:102-140`). Here:
   create = POST to the type's creation collection; update/test-class =
   `POST {uri}?_action=LOCK&accessMode=MODIFY` → `PUT .../source/main?lockHandle=..[&corrNr=..]`
   → `POST {uri}?_action=UNLOCK`.
2. **Errors propagate.** Reference: ATC exceptions → `[]` (looks clean),
   ABAP Unit failure → synthetic SUCCESS results, migration analysis failure →
   fabricated findings. All three now throw; the adapter returns a sanitized
   error. This is P6 (a missing/failed check is FAIL, never pass) and P2
   (never ground decisions on fabricated data).
3. **Eager authentication.** Reference never called `connect()` and
   null-dereferenced on several paths (spec finding). `server.js` awaits
   `session.authenticate()` before dispatching any handler.
4. **get_transport_requests is real** (CTS query `/sap/bc/adt/cts/transportrequests?user=..&targets=true`);
   reference returned an honest-empty list.
5. **scmon/smodilog stay `data_available:false` WITH a `reason` field** — ADT
   REST exposes no SCMON/SMODILOG endpoint; an RFC/table gateway would be
   needed. This is a truthful no-data answer, not a fake. Consumers must never
   read it as "unused/unmodified" (schema `signals` contract).

## Testing

- Offline (in `npm test`): `test/lib.test.js` (pure units), `test/server.test.js`
  (spawn the REAL process; health, envelope errors, missing-credential list,
  REAL unreachable-SAP failure, all-17-routable). No SAP required, no doubles.
- `npm run test:live` (needs `SAP_HOST`/`SAP_USER`/`SAP_PASSWORD`, optional
  `SAP_PORT`/`SAP_CLIENT`/`SAP_TEST_PACKAGE`/`SAP_TEST_CLASS`): read-only chain
  incl. bridge→sidecar→SAP and the analyser live pull. **Fails loudly without
  creds — never skip, never fake.**
- `npm run test:live:write` (adds `LIVE_WRITE_PACKAGE`, optional
  `LIVE_WRITE_TRANSPORT`): DEV-only (P5) — creates `ZCL_HARNESS_E2E_<ts>`,
  writes source + test class, syntax-checks, activates, runs ABAP Unit. The
  object intentionally remains for inspection.

## Live-failure debugging playbook (first live run WILL surface release quirks)

| Symptom | Likely cause / fix |
|---|---|
| `authentication failed: HTTP 401` | wrong creds/client; check `SAP_CLIENT`; user needs ADT authorization (S_ADT_RES) |
| TLS error (`self-signed certificate`) | run sidecar with `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| 403 "System error in lock management" on writes | CSRF token not paired with session cookies — verify the jar is populated (cookie parse) and `ensureFreshCsrf` ran; SAP validates token AGAINST cookies |
| `get_objects` returns empty on a non-empty package | nodestructure row element names differ by release — inspect the raw XML, adjust `textOf` keys in `handlers/read.js` (keep namespace-agnostic matching) |
| ATC findings empty but expected | check variant name exists on the system (`ABAP_CLEAN_CORE_DEVELOPMENT` needs cloud-readiness add-on); worklist XML attribute names may need widening in `pollAtcWorklist` |
| `get_migration_analysis` HTTP 404 | `/sap/bc/adt/migration/analysis` is not standard on all releases — the error message already points to the analyser's bundled cloudification registry as the fallback |
| create_object 400 with content-type complaint | the `CREATION` content-type version (e.g. `...classes.v2+xml`) may need bumping per release; inspect the error detail |

When fixing a live quirk: adjust the handler, add/extend an offline envelope
test if the fix is envelope-visible, re-run `npm test` (must stay green), then
re-run the live suite. Never insert a fallback that fabricates success.

## Provenance

Port spec produced 2026-07-03 by a 3-reader workflow over the TALOS source
(routing/envelope, per-tool endpoints+payloads, import trace + auth flow),
with file:line evidence. The TALOS `aws_abap_accelerator` library (~25K lines)
was NOT ported wholesale — only the auth/session flow and per-tool ADT calls
its adapter actually used; SAML/IAM/RBAC/enterprise modules are confirmed
unused on this path. The reference's own Dockerfile likely cannot even import
its real mode (PYTHONPATH gap) — the auth flow, not the container, was the
porting target.
