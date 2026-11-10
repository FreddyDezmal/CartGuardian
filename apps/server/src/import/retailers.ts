import type { ImportedProduct } from "@cartguardian/shared";
import type { Extraction } from "./extract.js";

/**
 * Retailer adapters. Each one recognises its own links, can tidy a URL before
 * fetching, and can adjust what the generic extractor found. Adding a store
 * means adding one object to RETAILERS; the generic adapter handles the rest.
 */
export interface RetailerAdapter {
  id: string;
  name: string;
  /** True for stores tested specifically; false for best-effort generic import. */
  supported: boolean;
  /**
   * Only import pages that show they are about one product: a JSON-LD Product,
   * og:type product, a structured price, or an og:title. A page with none of
   * these (just a <title>) is the store's app shell or an error page.
   */
  requireProductSignal?: boolean;
  matches(url: URL): boolean;
  /** Validate/normalise the link before fetching. Throws RetailerUrlError for unusable links. */
  prepareUrl(url: URL): URL;
  refine(extraction: Extraction, finalUrl: URL): { product: Partial<ImportedProduct>; notes: string[] };
}

export class RetailerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetailerUrlError";
  }
}

const stripSuffix = (title: string | undefined, re: RegExp) => (title ? title.replace(re, "").trim() || title : title);

export const takealot: RetailerAdapter = {
  id: "takealot",
  name: "Takealot",
  supported: true,
  requireProductSignal: true,
  matches: (url) => url.hostname === "takealot.com" || url.hostname.endsWith(".takealot.com"),
  prepareUrl(url) {
    // Product pages carry a PLID (e.g. /some-name/PLID12345678); search and category pages don't.
    if (!/\/PLID\d+/i.test(url.pathname)) {
      throw new RetailerUrlError("That Takealot link isn't a product page. Open the product and copy its link (it contains \"PLID\").");
    }
    const clean = new URL(url.toString());
    clean.protocol = "https:";
    clean.hostname = "www.takealot.com";
    clean.search = ""; // drop tracking parameters
    clean.hash = "";
    return clean;
  },
  refine(extraction, finalUrl) {
    const product: Partial<ImportedProduct> = { ...extraction.product };
    const notes: string[] = [];
    product.title = stripSuffix(product.title, /\s*[|\-–]\s*Takealot(\.com)?\s*$/i);
    // Takealot sells only in South Africa, in rand. Fill the currency only alongside a price the page gave.
    if (product.price && !product.currency) {
      product.currency = "ZAR";
      notes.push("Currency set to ZAR: Takealot prices are in South African rand.");
    }
    return { product: { ...product, sourceUrl: finalUrl.toString() }, notes };
  },
};

export const generic: RetailerAdapter = {
  id: "generic",
  name: "Other store",
  supported: false,
  matches: () => true,
  prepareUrl: (url) => {
    const u = new URL(url.toString());
    u.hash = "";
    return u;
  },
  refine(extraction, finalUrl) {
    return { product: { ...extraction.product, sourceUrl: finalUrl.toString() }, notes: [] };
  },
};

export const RETAILERS: RetailerAdapter[] = [takealot, generic];

export function retailerFor(url: URL): RetailerAdapter {
  return RETAILERS.find((r) => r.matches(url)) ?? generic;
}

/** Store name for display: the adapter's, else og:site_name, else the hostname. */
export function retailerName(adapter: RetailerAdapter, extraction: Extraction, url: URL): string {
  if (adapter.supported) return adapter.name;
  return (extraction.siteName?.trim() || url.hostname.replace(/^www\./, "")).slice(0, 80);
}
