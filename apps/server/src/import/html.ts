/**
 * Minimal, dependency-free reading of the machine-readable parts of an HTML
 * page: <meta> tags, <title>, <link rel="canonical"> and JSON-LD blocks.
 * Nothing is executed and no DOM is built.
 *
 * The page comes from an arbitrary website, so parsing must stay linear in the
 * page size: a single forward scan, no backtracking regular expressions over
 * the whole document (a hostile 2 MB page must not freeze the server).
 */

export interface PageMetadata {
  /** Lower-cased property/name/itemprop -> values in document order. */
  meta: Map<string, string[]>;
  title?: string;
  canonical?: string;
  /** Successfully parsed JSON-LD blocks. */
  jsonLd: unknown[];
  /** Number of JSON-LD blocks that failed to parse. */
  jsonLdErrors: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}\d{0,2});/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16), m);
    if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10), m);
    return ENTITIES[lower] ?? m;
  });
}

function safeCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/** Longest text value considered; everything shown to users is far shorter. */
const MAX_TEXT = 20_000;

/** Collapses whitespace and strips any tags left in a text value (input capped to stay fast). */
export function cleanText(s: string): string {
  // [^<>] keeps tag stripping linear: a "<" with no ">" fails at the next "<"
  // instead of rescanning to the end (quadratic on text full of "<").
  return decodeEntities(s.slice(0, MAX_TEXT).replace(/<[^<>]*>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1") // "beans ." left by a removed tag
    .trim();
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  /** Index just after the closing ">". */
  end: number;
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/**
 * Reads the start tag beginning at `lt` (the "<"). Returns undefined if it isn't
 * a start tag, or null if the document ends inside the tag (stop scanning).
 */
function readTag(doc: string, lt: number): Tag | undefined | null {
  let i = lt + 1;
  if (i >= doc.length || !isNameStart(doc.charCodeAt(i))) return undefined;
  const nameStart = i;
  while (i < doc.length && isNameChar(doc.charCodeAt(i))) i++;
  const name = doc.slice(nameStart, i).toLowerCase();
  const attrs: Record<string, string> = {};

  while (i < doc.length) {
    while (i < doc.length && (isSpace(doc.charCodeAt(i)) || doc[i] === "/")) i++;
    if (i >= doc.length) return null;
    if (doc[i] === ">") return { name, attrs, end: i + 1 };

    // Attribute name: anything up to space, "=", ">" or "/".
    const an = i;
    while (i < doc.length && !isSpace(doc.charCodeAt(i)) && doc[i] !== "=" && doc[i] !== ">" && doc[i] !== "/") i++;
    if (i === an) {
      i++; // stray character; skip it
      continue;
    }
    const attrName = doc.slice(an, i).toLowerCase();
    while (i < doc.length && isSpace(doc.charCodeAt(i))) i++;
    if (doc[i] !== "=") {
      if (!(attrName in attrs)) attrs[attrName] = "";
      continue;
    }
    i++; // "="
    while (i < doc.length && isSpace(doc.charCodeAt(i))) i++;
    if (i >= doc.length) return null;

    let value: string;
    const q = doc[i];
    if (q === '"' || q === "'") {
      // Quotes count only right after "=", as in HTML.
      const close = doc.indexOf(q, i + 1);
      if (close < 0) return null; // unterminated: give up on the rest of the page
      value = doc.slice(i + 1, close);
      i = close + 1;
    } else {
      const vs = i;
      while (i < doc.length && !isSpace(doc.charCodeAt(i)) && doc[i] !== ">") i++;
      value = doc.slice(vs, i);
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value);
  }
  return null;
}

/** Finds a closing tag case-insensitively without lower-casing the whole document per call. */
function indexOfClose(lowerDoc: string, name: string, from: number): number {
  return lowerDoc.indexOf(`</${name}`, from);
}

export function readMetadata(html: string): PageMetadata {
  const doc = html;
  const lower = html.toLowerCase();
  const meta = new Map<string, string[]>();
  const add = (key: string | undefined, value: string | undefined) => {
    if (!key || value === undefined) return;
    const k = key.toLowerCase().trim();
    const v = value.trim();
    if (!v) return;
    const list = meta.get(k);
    if (list) {
      if (list.length < 20) list.push(v);
    } else meta.set(k, [v]);
  };

  let title: string | undefined;
  let canonical: string | undefined;
  const jsonLd: unknown[] = [];
  let jsonLdErrors = 0;

  let pos = 0;
  while (pos < doc.length) {
    const lt = doc.indexOf("<", pos);
    if (lt < 0) break;

    // Comments can hide stale or decoy tags: skip them entirely.
    if (doc.startsWith("<!--", lt)) {
      const close = doc.indexOf("-->", lt + 4);
      if (close < 0) break;
      pos = close + 3;
      continue;
    }

    const tag = readTag(doc, lt);
    if (tag === null) break;
    if (tag === undefined) {
      pos = lt + 1;
      continue;
    }
    pos = tag.end;
    const a = tag.attrs;

    if (tag.name === "meta") {
      const value = a.content ?? a.value;
      add(a.property, value);
      add(a.name, value);
      add(a.itemprop, value);
    } else if (tag.name === "link") {
      if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && a.href) canonical = a.href;
    } else if (tag.name === "title" && title === undefined) {
      const close = indexOfClose(lower, "title", pos);
      if (close >= 0) {
        title = cleanText(doc.slice(pos, close)) || undefined;
        pos = close;
      }
    } else if (tag.name === "script" || tag.name === "style" || tag.name === "template") {
      // Raw-text elements: their content is never markup, so jump past it.
      const close = indexOfClose(lower, tag.name, pos);
      const body = doc.slice(pos, close < 0 ? doc.length : close);
      if (tag.name === "script" && (a.type ?? "").toLowerCase().trim() === "application/ld+json" && jsonLd.length + jsonLdErrors < 20) {
        const raw = body.trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
        try {
          jsonLd.push(JSON.parse(raw));
        } catch {
          jsonLdErrors++;
        }
      }
      if (close < 0) break;
      pos = close;
    } else if (a.itemprop) {
      // Microdata on other elements, e.g. <span itemprop="price" content="1299">.
      if (a.content !== undefined) add(a.itemprop, a.content);
      else if (a.href || a.src) add(a.itemprop, a.href || a.src);
    }
  }

  return { meta, title, canonical, jsonLd, jsonLdErrors };
}

/** First value for any of the keys, in priority order. */
export function firstMeta(md: PageMetadata, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = md.meta.get(k.toLowerCase())?.[0];
    if (v) return v;
  }
  return undefined;
}
