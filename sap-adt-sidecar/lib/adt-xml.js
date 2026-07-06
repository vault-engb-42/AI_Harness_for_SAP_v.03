import { XMLParser } from "fast-xml-parser";

/**
 * ADT XML helpers. Parsing is namespace-AGNOSTIC by design: SAP's namespace
 * prefixes vary by release, so elements are matched by local name only
 * (the same approach the TALOS client used with tag.endswith matching).
 * fast-xml-parser dependency justification: hand-rolled regex XML parsing of
 * vendor payloads is a correctness risk; fast-xml-parser is pure-JS, MIT,
 * zero-dependency and actively maintained. Alternative rejected: regex.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true, // namespace-agnostic element AND attribute names
  parseTagValue: false,
  trimValues: true,
});

/** @param {string} s @returns {string} XML-escaped text (5 metacharacters) */
export function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** @param {string} xml @returns {object} parsed document (prefixes stripped) */
export function parseAdtXml(xml) {
  return parser.parse(xml);
}

/**
 * Depth-first collection of every element whose local name matches.
 * @param {object} node parsed document or subtree
 * @param {string} localName element local name (no prefix)
 * @returns {object[]} matching element nodes (attribute keys prefixed with @)
 */
export function findAll(node, localName) {
  const out = [];
  const visit = (n) => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@")) continue;
      if (key === localName) {
        for (const el of Array.isArray(value) ? value : [value]) {
          if (el !== null && typeof el === "object") out.push(el);
          else out.push({ "#text": el });
        }
      }
      visit(value);
    }
  };
  visit(node);
  return out;
}

/**
 * @param {object} el element node
 * @param {string} name attribute local name
 * @returns {string|undefined}
 */
export function attr(el, name) {
  return el?.[`@${name}`];
}
