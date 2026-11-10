import {
  IMPORT_FIELDS,
  ProductImportRequestSchema,
  type ImportField,
  type ImportedProduct,
  type ProductImportResponse,
} from "@cartguardian/shared";
import { HttpError } from "../errors.js";
import { extractProduct } from "./extract.js";
import { RetailerUrlError, retailerFor, retailerName } from "./retailers.js";
import { SafeFetchError, safeFetchHtml, validateUrl, type FetchedPage, type SafeFetchOptions } from "./safe-fetch.js";

export type PageFetcher = (url: string) => Promise<FetchedPage>;

/** Friendly messages: every one ends by pointing at the manual form. */
const MANUAL = "You can enter the details yourself below.";
function mapFetchError(err: SafeFetchError): HttpError {
  switch (err.code) {
    case "INVALID_URL":
      return new HttpError(400, "IMPORT_INVALID_URL", `${err.message} ${MANUAL}`);
    case "URL_NOT_ALLOWED":
      return new HttpError(400, "IMPORT_URL_NOT_ALLOWED", `CartGuardian can only import public web pages. ${MANUAL}`);
    case "TIMEOUT":
      return new HttpError(504, "IMPORT_TIMEOUT", `The store took too long to respond. Try again, or ${MANUAL.charAt(0).toLowerCase()}${MANUAL.slice(1)}`);
    case "TOO_LARGE":
      return new HttpError(422, "IMPORT_TOO_LARGE", `That page is too large to import. ${MANUAL}`);
    case "NOT_HTML":
      return new HttpError(422, "IMPORT_NOT_A_PAGE", `That link isn't a product web page. ${MANUAL}`);
    case "BLOCKED":
      return new HttpError(502, "IMPORT_BLOCKED", `The store didn't let CartGuardian read this page. ${MANUAL}`, { status: err.status });
    case "NOT_FOUND":
      return new HttpError(422, "IMPORT_PAGE_NOT_FOUND", `The store says this page doesn't exist. Check the link, or ${MANUAL.charAt(0).toLowerCase()}${MANUAL.slice(1)}`);
    case "TOO_MANY_REDIRECTS":
    case "HTTP_ERROR":
    case "NETWORK":
      return new HttpError(502, "IMPORT_UNREACHABLE", `CartGuardian couldn't load that page. ${MANUAL}`, err.status ? { status: err.status } : undefined);
  }
}

export class ProductImportService {
  private readonly fetchPage: PageFetcher;

  constructor(opts: { fetchPage?: PageFetcher; fetchOptions?: SafeFetchOptions } = {}) {
    this.fetchPage = opts.fetchPage ?? ((url) => safeFetchHtml(url, opts.fetchOptions));
  }

  async import(rawBody: unknown): Promise<ProductImportResponse> {
    const parsed = ProductImportRequestSchema.safeParse(rawBody);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Paste a product link.");

    let target: URL;
    let adapter;
    try {
      // Cheap checks first, so obviously bad links never trigger a request.
      const url = validateUrl(parsed.data.url);
      adapter = retailerFor(url);
      target = adapter.prepareUrl(url);
    } catch (err) {
      if (err instanceof SafeFetchError) throw mapFetchError(err);
      if (err instanceof RetailerUrlError) throw new HttpError(400, "IMPORT_NOT_A_PRODUCT", `${err.message} ${MANUAL}`);
      throw err;
    }

    let page: FetchedPage;
    try {
      page = await this.fetchPage(target.toString());
    } catch (err) {
      if (err instanceof SafeFetchError) throw mapFetchError(err);
      console.error("Product import fetch failed unexpectedly", err);
      throw new HttpError(502, "IMPORT_UNREACHABLE", `CartGuardian couldn't load that page. ${MANUAL}`);
    }

    // Stores send links to products they no longer list to their home page.
    // Importing that page would fill the form with the store's own name.
    if (isHomePage(page.url) && !isHomePage(target)) {
      throw new HttpError(
        422,
        "IMPORT_PRODUCT_UNAVAILABLE",
        `The store sent CartGuardian to its home page instead of the product, so it may no longer be listed. Check the link, or ${MANUAL.charAt(0).toLowerCase()}${MANUAL.slice(1)}`,
      );
    }

    // A redirect can land on another store; let that store's adapter handle it.
    const finalAdapter = retailerFor(page.url);
    const extraction = extractProduct(page.html, page.url);
    if (extraction.looksBlocked) {
      throw new HttpError(502, "IMPORT_BLOCKED", `The store showed a robot check instead of the product. ${MANUAL}`);
    }
    if (extraction.isSiteShell || (finalAdapter.requireProductSignal && !extraction.hasProductSignal && !extraction.hasSocialTitle)) {
      // The page came back without the product in it (often a JavaScript app shell
      // carrying the store's site-wide title). Importing that would fill the form
      // with the store's name, so say so instead.
      throw new HttpError(
        422,
        "IMPORT_NO_PRODUCT_DATA",
        `${retailerName(finalAdapter, extraction, page.url)} didn't include the product's details in the page CartGuardian received. ${MANUAL}`,
      );
    }
    const refined = finalAdapter.refine(extraction, page.url);
    const product: ImportedProduct = {
      ...pickDefined(refined.product),
      retailer: retailerName(finalAdapter, extraction, page.url),
      sourceUrl: refined.product.sourceUrl ?? page.url.toString(),
    };

    const fieldsFound = IMPORT_FIELDS.filter((f) => product[f] !== undefined && product[f] !== "");
    const fieldsMissing = IMPORT_FIELDS.filter((f) => !fieldsFound.includes(f)) as ImportField[];
    if (!product.title && !product.price) {
      throw new HttpError(422, "IMPORT_NO_PRODUCT_DATA", `CartGuardian couldn't find product details on that page. ${MANUAL}`);
    }

    const notes = [...extraction.notes, ...refined.notes];
    if (!finalAdapter.supported) notes.unshift(`${product.retailer} isn't a store CartGuardian specifically supports, so check every field.`);
    if (adapter.id !== finalAdapter.id) notes.push(`The link redirected to ${product.retailer}.`);

    return {
      success: true,
      product,
      fieldsFound,
      fieldsMissing,
      retailer: { id: finalAdapter.id, name: product.retailer ?? finalAdapter.name, supported: finalAdapter.supported },
      notes: [...new Set(notes)],
    };
  }
}

function pickDefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

const isHomePage = (u: URL) => u.pathname === "/" || u.pathname === "";
