// @awthaq/saml — SafeXml
//
// SFS-003/BEH-EA-238/239: the one way this package parses XML it did not produce. Every document that reaches
// a parser first passes the same lexical gate, because the dangerous constructs are all refusable by name
// before any parser gets to interpret them:
//
//   - a size cap (a parser handed unbounded input is a denial of service independent of any signature bug);
//   - no `<!DOCTYPE`/`<!ENTITY`/`<!ATTLIST` (no external entity, no billion laughs, no XXE) — `<![CDATA[` is
//     the only `<!` allowed;
//   - no processing instructions after the XML declaration (`xml-stylesheet`, and whatever a parser may act on);
//   - no comments (a comment inside a signed value is the classic way to make a verifier and a reader disagree
//     about a NameID; the digest ignores comments, so refusing them is the conservative reading, and
//     signed content is read from canonical bytes that never contain them anyway);
//   - a nesting-depth cap, so a pathological tree cannot exhaust the stack of the DOM walker or the parser.
//
// The parse itself is `@xmldom/xmldom` with an error handler that turns every warning and error into a failure:
// the library's lenient recovery ("keep going after a malformed tag") is exactly how two readers end up
// with two different trees.

import { XmlSignature } from "@awthaq/ports";
import { DOMParser } from "@xmldom/xmldom";
import * as Effect from "effect/Effect";

export const DEFAULT_MAX_BYTES = 256 * 1024;
export const MAX_DEPTH = 64;

const refuse = (reason: XmlSignature.XmlSignatureFailure, detail: string) =>
  Effect.fail(new XmlSignature.XmlSignatureError({ reason, detail }));

/** Lexical refusals, in the order a cheap check should run. Pure: nothing here parses. */
export const screen = Effect.fnUntraced(function* (xml: string, maxBytes: number = DEFAULT_MAX_BYTES) {
  if (new TextEncoder().encode(xml).length > maxBytes) {
    return yield* refuse("tooLarge", `the document is larger than ${maxBytes} bytes`);
  }
  if (xml.trim().length === 0) return yield* refuse("malformed", "the document is empty");
  if (/<!doctype|<!entity|<!attlist|<!element|<!notation/i.test(xml)) {
    return yield* refuse("doctype", "a document type declaration is not accepted");
  }
  if (/<!--/.test(xml)) return yield* refuse("comment", "comments are not accepted");
  // `<!` may only open a CDATA section.
  if (/<!(?!\[CDATA\[)/.test(xml)) return yield* refuse("malformed", "an unexpected markup declaration");
  // The XML declaration may open the document; any other processing instruction is refused.
  const instructions = xml.match(/<\?[A-Za-z_][\w.-]*/g) ?? [];
  const leading = /^\uFEFF?\s*<\?xml[\s?]/i.test(xml);
  const others = instructions.filter(
    (instruction, index) => !(index === 0 && leading && /^<\?xml$/i.test(instruction)),
  );
  if (others.length > 0) {
    return yield* refuse("processingInstruction", "processing instructions are not accepted");
  }
});

/** Screens then parses; every parser warning or error is a failure. */
export const parse = Effect.fnUntraced(function* (xml: string, maxBytes: number = DEFAULT_MAX_BYTES) {
  yield* screen(xml, maxBytes);
  let problem: string | undefined;
  const collect = (message: unknown) => {
    problem ??= typeof message === "string" ? message : "parse error";
  };
  const parser = new DOMParser({ errorHandler: { warning: collect, error: collect, fatalError: collect } });
  const document = yield* Effect.try({
    try: () => parser.parseFromString(xml, "text/xml"),
    catch: () => new XmlSignature.XmlSignatureError({ reason: "malformed", detail: "the document is not well-formed XML" }),
  });
  if (problem !== undefined || document.documentElement === null) {
    return yield* refuse("malformed", "the document is not well-formed XML");
  }
  if (depthOf(document.documentElement) > MAX_DEPTH) {
    return yield* refuse("malformed", `the document nests deeper than ${MAX_DEPTH} levels`);
  }
  return document.documentElement;
});

// ---- a small, allocation-light DOM vocabulary --------------------------------------------------

export const isElement = (node: Node | null): node is Element => node !== null && node.nodeType === 1;

/** Direct element children, in document order. */
export const childElements = (parent: Node): ReadonlyArray<Element> => {
  const found: Array<Element> = [];
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (isElement(child)) found.push(child);
  }
  return found;
};

/** Every element under `root` (inclusive), document order, iteratively (no recursion to overflow). */
export const allElements = (root: Element): ReadonlyArray<Element> => {
  const found: Array<Element> = [];
  const stack: Array<Element> = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    found.push(current);
    const children = childElements(current);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return found;
};

const depthOf = (root: Element): number => {
  let deepest = 0;
  const stack: Array<{ readonly element: Element; readonly depth: number }> = [{ element: root, depth: 1 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    deepest = Math.max(deepest, top.depth);
    if (deepest > MAX_DEPTH) return deepest;
    for (const child of childElements(top.element)) stack.push({ element: child, depth: top.depth + 1 });
  }
  return deepest;
};

export const isNamed = (element: Element, name: XmlSignature.ElementName): boolean =>
  element.localName === name.localName && element.namespaceURI === name.namespace;

export const named = (
  root: Element,
  name: XmlSignature.ElementName,
): ReadonlyArray<Element> => allElements(root).filter((element) => isNamed(element, name));

/** Direct children of `parent` with this name. */
export const childrenNamed = (
  parent: Element,
  name: XmlSignature.ElementName,
): ReadonlyArray<Element> => childElements(parent).filter((element) => isNamed(element, name));

/** The text of an element that has only text children (element or mixed content yields `undefined`). */
export const textOf = (element: Element): string | undefined => {
  let text = "";
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue ?? "";
    else return undefined;
  }
  return text;
};

/** Attribute value or `undefined` (an attribute in no namespace, by local name). */
export const attribute = (element: Element, name: string): string | undefined =>
  element.hasAttribute(name) ? (element.getAttribute(name) ?? undefined) : undefined;
