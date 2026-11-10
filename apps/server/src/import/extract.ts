import { LIMITS, type ImportedProduct } from "@cartguardian/shared";
import { cleanText, firstMeta, readMetadata, type PageMetadata } from "./html.js";

/**
 * Deterministic product extraction from structured page data, in priority order:
 *   1. JSON-LD schema.org Product (offers, brand, category)
 *   2. Product/Open Graph meta tags (product:price:amount, og:title, ...)
 *   3. Microdata itemprop values
 *   4. Standard tags (<title>, meta description)
 * Free text is never parsed for prices, and nothing is inferred by a model.
 */

export interface Extraction {
  product: Omit<ImportedProduct, "sourceUrl" | "retailer">;
  notes: string[];
  /** og:site_name, used as a retailer name fallback. */
  siteName?: string;
  /** True when the page looks like a bot challenge rather than a product page. */
  looksBlocked: boolean;
  jsonLdErrors: number;
  /**
   * Evidence that the page describes one product rather than the whole site:
   * a JSON-LD Product, og:type product, or a structured price.
   */
  hasProductSignal: boolean;
  /** og:title or twitter:title: page-specific, unlike a bare <title> that an app shell shares across pages. */
  hasSocialTitle: boolean;
  /**
   * True when the page says it is really the site's home page (canonical or
   * og:url pointing at "/"). Apps that render products with JavaScript send this
   * shell with site-wide text, which must never be imported as the product.
   */
  isSiteShell: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function typeIs(node: Json, type: string): boolean {
  return asArray(node["@type"] as string | string[]).some((t) => typeof t === "string" && t.replace(/^https?:\/\/schema\.org\//, "") === type);
}

/** Walks JSON-LD (arrays, @graph, nested values) and returns nodes of a type. */
function findNodes(roots: unknown[], type: string, limit = 50): Json[] {
  const out: Json[] = [];
  const seen = new Set<unknown>();
  const stack = [...roots];
  while (stack.length && out.length < limit) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    if (typeIs(v as Json, type)) out.push(v as Json);
    for (const child of Object.values(v as Json)) if (child && typeof child === "object") stack.push(child);
  }
  return out.reverse();
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return cleanText(v) || undefined;
  if (typeof v === "number") return String(v);
  if (isObj(v)) return textOf(v.name ?? v["@value"]);
  if (Array.isArray(v)) return textOf(v[0]);
  return undefined;
}

function imageOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) return imageOf(v[0]);
  if (isObj(v)) return imageOf(v.url ?? v.contentUrl);
  return undefined;
}

/**
 * Turns "1 299,00", "1,299.00", "R 1299", 1299 into "1299.00".
 * Returns undefined for anything ambiguous, zero, negative or not a number.
 */
export function normalizePrice(raw: unknown): string | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw.toFixed(2) : undefined;
  if (typeof raw !== "string") return undefined;
  let s = raw.replace(/[\s  ]/g, "").replace(/^[^\d-]+|[^\d]+$/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return undefined;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    // "1299,50" -> decimal comma; "1,299" or "12,999,000" -> thousands.
    s = /,\d{2}$/.test(s) && s.split(",").length === 2 ? s.replace(",", ".") : s.split(",").join("");
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.split(".").join(""); // "1.299.000" -> thousands dots
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n >= 1_000_000) return undefined;
  return (Math.round(n * 100) / 100).toFixed(2);
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const currencyOf = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : undefined;
  return s && CURRENCY_RE.test(s) ? s : undefined;
};

const LIST_PRICE_TYPES = /ListPrice|StrikethroughPrice|SRP|MSRP|InvoicePrice|MinimumAdvertisedPrice/i;

interface PriceResult {
  price?: string;
  currency?: string;
  notes: string[];
}

/** Picks the current selling price from schema.org offers, skipping list/was prices. */
function priceFromOffers(product: Json): PriceResult {
  const notes: string[] = [];
  const candidates: Array<{ price: string; currency?: string }> = [];
  for (const offer of asArray(product.offers as unknown)) {
    if (!isObj(offer)) continue;
    const currency = currencyOf(offer.priceCurrency);
    if (typeIs(offer, "AggregateOffer")) {
      const low = normalizePrice(offer.lowPrice ?? offer.price);
      const high = normalizePrice(offer.highPrice);
      if (low) {
        candidates.push({ price: low, currency });
        if (high && high !== low) notes.push("The price varies by option; showing the lowest.");
      }
      continue;
    }
    // Offer.price is the selling price. A priceSpecification may also list it, alongside list prices.
    let price = normalizePrice(offer.price);
    let specCurrency: string | undefined;
    for (const spec of asArray(offer.priceSpecification as unknown)) {
      if (!isObj(spec)) continue;
      const isList = typeof spec.priceType === "string" && LIST_PRICE_TYPES.test(spec.priceType);
      if (!isList && !price) {
        price = normalizePrice(spec.price);
        specCurrency = currencyOf(spec.priceCurrency);
      }
      if (isList && normalizePrice(spec.price) && normalizePrice(spec.price) !== price) {
        notes.push("The page also shows a higher list price; using the current selling price.");
      }
    }
    if (price) candidates.push({ price, currency: currency ?? specCurrency });
  }
  if (candidates.length === 0) return { notes };
  const distinct = new Set(candidates.map((c) => c.price));
  if (distinct.size > 1) notes.push("The page lists several offers; using the first one.");
  return { price: candidates[0]!.price, currency: candidates[0]!.currency, notes };
}

function priceFromMeta(md: PageMetadata): PriceResult {
  const notes: string[] = [];
  const sale = normalizePrice(firstMeta(md, "product:sale_price:amount"));
  const regular = normalizePrice(firstMeta(md, "product:price:amount", "og:price:amount", "price"));
  const currency = currencyOf(
    firstMeta(md, sale ? "product:sale_price:currency" : "product:price:currency", "product:price:currency", "og:price:currency", "pricecurrency"),
  );
  if (sale) {
    if (regular && regular !== sale) notes.push("The page shows a sale price and a regular price; using the sale price.");
    return { price: sale, currency, notes };
  }
  return { price: regular, currency, notes };
}

const BLOCK_SIGNS = [/just a moment\.\.\./i, /attention required/i, /cf-chl-|challenge-platform/i, /captcha/i, /access denied/i, /are you a robot/i, /enable javascript and cookies to continue/i];

export function extractProduct(html: string, pageUrl: URL): Extraction {
  const md = readMetadata(html);
  const notes: string[] = [];
  const product: Extraction["product"] = {};

  const ldProduct = findNodes(md.jsonLd, "Product")[0] ?? findNodes(md.jsonLd, "ProductGroup")[0];
  if (md.jsonLdErrors > 0 && !ldProduct) notes.push("Some structured data on the page couldn't be read.");

  // Title
  product.title = textOf(ldProduct?.name) ?? firstMeta(md, "og:title", "twitter:title", "name") ?? md.title;

  // Description
  const desc = textOf(ldProduct?.description) ?? firstMeta(md, "og:description", "description", "twitter:description");
  if (desc) product.description = cleanText(desc).slice(0, LIMITS.description.max);

  // Price: JSON-LD offers first, then product meta tags / microdata.
  let price: PriceResult = ldProduct ? priceFromOffers(ldProduct) : { notes: [] };
  if (!price.price) {
    const metaPrice = priceFromMeta(md);
    price = { ...metaPrice, notes: [...price.notes, ...metaPrice.notes] };
  }
  if (price.price) {
    product.price = price.price;
    if (price.currency) product.currency = price.currency;
  }
  notes.push(...price.notes);

  // Image (resolved against the page, http/https only)
  const img = imageOf(ldProduct?.image) ?? firstMeta(md, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "image");
  if (img) {
    try {
      const abs = new URL(img, pageUrl);
      if (abs.protocol === "https:" || abs.protocol === "http:") product.imageUrl = abs.toString();
    } catch {
      /* ignore unusable image URLs */
    }
  }

  // Brand
  product.brand = textOf(ldProduct?.brand) ?? textOf(ldProduct?.manufacturer) ?? firstMeta(md, "product:brand", "og:brand", "brand");

  // Category: explicit category, else the breadcrumb trail's last parent.
  let category = textOf(ldProduct?.category) ?? firstMeta(md, "product:category", "category");
  if (!category) {
    const crumbs = findNodes(md.jsonLd, "BreadcrumbList")[0];
    const items = asArray(crumbs?.itemListElement as unknown)
      .filter(isObj)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
      .map((it) => textOf(it.name ?? (isObj(it.item) ? it.item.name : undefined)))
      .filter((n): n is string => Boolean(n));
    // The last crumb is usually the product itself; the one before it is its category.
    if (items.length >= 2) category = items[items.length - 2];
  }
  if (category) product.category = cleanText(category).split(/\s*[>/|]\s*/).filter(Boolean).pop();

  // Tidy text fields and drop empties.
  for (const k of ["title", "brand", "category"] as const) {
    const v = product[k];
    if (v !== undefined) {
      const t = cleanText(v);
      if (t) product[k] = t;
      else delete product[k];
    }
  }
  if (product.title) product.title = product.title.slice(0, 120);

  const looksBlocked = !ldProduct && !product.price && BLOCK_SIGNS.some((re) => re.test(md.title ?? "") || re.test(html.slice(0, 4000)));

  const ogType = (firstMeta(md, "og:type") ?? "").toLowerCase();
  const hasProductSignal = Boolean(ldProduct) || ogType.startsWith("product") || Boolean(product.price);
  const isSiteShell = !hasProductSignal && pageUrl.pathname !== "/" && [md.canonical, firstMeta(md, "og:url")].some((u) => pointsAtHome(u, pageUrl));

  return { product, notes, siteName: firstMeta(md, "og:site_name"), looksBlocked,
    jsonLdErrors: md.jsonLdErrors,
    hasProductSignal,
    hasSocialTitle: Boolean(firstMeta(md, "og:title", "twitter:title")),
    isSiteShell,
  };
}

function pointsAtHome(link: string | undefined, pageUrl: URL): boolean {
  if (!link) return false;
  try {
    const u = new URL(link, pageUrl);
    return u.pathname === "/" || u.pathname === "";
  } catch {
    return false;
  }
}
