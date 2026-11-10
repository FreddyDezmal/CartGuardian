import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { extractProduct, normalizePrice } from "../src/import/extract.js";
import { ProductImportService, type PageFetcher } from "../src/import/service.js";
import { SafeFetchError } from "../src/import/safe-fetch.js";
import { buildTestApp, validInput } from "./helpers.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/import/${name}`, import.meta.url)), "utf8");

/** Serves a fixture for whatever URL is fetched, recording the URLs asked for. */
function fixtureFetcher(name: string, finalUrl?: string): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    return { url: new URL(finalUrl ?? url), status: 200, contentType: "text/html", html: fixture(name) };
  }) as PageFetcher & { asked: string[] };
  f.asked = asked;
  return f;
}
const failingFetcher = (err: SafeFetchError): PageFetcher => async () => {
  throw err;
};

const TAKEALOT = "https://www.takealot.com/philips-3200-series/PLID71234567?gclid=abc#reviews";

describe("normalizePrice", () => {
  it.each([
    [8999, "8999.00"],
    ["8999", "8999.00"],
    ["1,299.00", "1299.00"],
    ["1 299,50", "1299.50"],
    ["R 1 299", "1299.00"],
    ["R 1 299", "1299.00"],
    ["12,999", "12999.00"],
    ["1.299.000", "1299000.00"],
  ])("%s -> %s", (raw, expected) => {
    // 1.299.000 is over the 1,000,000 sanity cap, so it is refused.
    expect(normalizePrice(raw)).toBe(expected === "1299000.00" ? undefined : expected);
  });
  it.each([[0], [-5], ["free"], [""], [null], ["1e5"], [Number.NaN]])("rejects %s", (raw) => {
    expect(normalizePrice(raw)).toBeUndefined();
  });
});

describe("extractProduct", () => {
  it("reads a JSON-LD product and picks the selling price, not the list price or delivery fee", () => {
    const x = extractProduct(fixture("takealot-jsonld.html"), new URL("https://www.takealot.com/p/PLID71234567"));
    expect(x.product).toEqual({
      title: "Philips 3200 Series Fully Automatic Espresso Machine & Milk Frother",
      description: "Enjoy 5 coffee varieties made from fresh beans.",
      price: "8999.00",
      currency: "ZAR",
      imageUrl: "https://media.takealot.com/covers_images/abc123/s-zoom.file",
      brand: "Philips",
      category: "Coffee Machines",
    });
    expect(x.notes).toContain("The page also shows a higher list price; using the current selling price.");
    expect(x.looksBlocked).toBe(false);
  });

  it("prefers the sale price in product meta tags and resolves relative images", () => {
    const x = extractProduct(fixture("generic-meta.html"), new URL("https://outdoor.example/p/1"));
    expect(x.product).toMatchObject({ title: "Trail Running Shoes", price: "119.99", currency: "USD", brand: "Stridewell", category: "Running", imageUrl: "https://outdoor.example/img/shoe.jpg" });
    expect(x.notes).toContain("The page shows a sale price and a regular price; using the sale price.");
    expect(x.siteName).toBe("Outdoor Co");
  });

  it("survives malformed JSON-LD and falls back to Open Graph and microdata", () => {
    const x = extractProduct(fixture("malformed-jsonld.html"), new URL("https://shop.example/lamp"));
    expect(x.jsonLdErrors).toBe(1);
    expect(x.product).toMatchObject({ title: "LED Desk Lamp", price: "1249.50", currency: "EUR", imageUrl: "https://shop.example/lamp.jpg" });
    expect(x.notes).toContain("Some structured data on the page couldn't be read.");
  });

  it("uses the lowest price of an AggregateOffer and says so", () => {
    const x = extractProduct(fixture("aggregate-offer.html"), new URL("https://shop.example/e"));
    expect(x.product).toMatchObject({ title: "Wireless Earbuds", price: "799.00", currency: "ZAR", brand: "Soundly", category: "Audio" });
    expect(x.notes).toContain("The price varies by option; showing the lowest.");
  });

  it("never reads prices from page text", () => {
    const x = extractProduct(fixture("no-metadata.html"), new URL("https://shop.example/"));
    expect(x.product.price).toBeUndefined();
    expect(x.product.title).toBeUndefined();
  });

  it("recognises bot-challenge pages", () => {
    expect(extractProduct(fixture("challenge.html"), new URL("https://shop.example/")).looksBlocked).toBe(true);
  });
});

describe("ProductImportService", () => {
  it("imports a Takealot product, cleaning the link before fetching", async () => {
    const fetcher = fixtureFetcher("takealot-jsonld.html");
    const res = await new ProductImportService({ fetchPage: fetcher }).import({ url: TAKEALOT });
    expect(fetcher.asked).toEqual(["https://www.takealot.com/philips-3200-series/PLID71234567"]);
    expect(res).toMatchObject({
      success: true,
      retailer: { id: "takealot", name: "Takealot", supported: true },
      product: { title: "Philips 3200 Series Fully Automatic Espresso Machine & Milk Frother", price: "8999.00", currency: "ZAR", brand: "Philips", retailer: "Takealot", sourceUrl: "https://www.takealot.com/philips-3200-series/PLID71234567" },
      fieldsMissing: [],
    });
    expect(res.fieldsFound).toEqual(["title", "description", "price", "currency", "imageUrl", "brand", "category"]);
  });

  it("returns a partial import when the price and image are missing", async () => {
    const res = await new ProductImportService({ fetchPage: fixtureFetcher("takealot-og-only.html") }).import({ url: "https://takealot.com/kettle/PLID111" });
    expect(res.product.title).toBe("Russell Hobbs Classic Kettle 1.7L");
    expect(res.product.description).toBe("Fast boil – 2200W.");
    expect(res.product.price).toBeUndefined();
    // No price means no currency is assumed either.
    expect(res.product.currency).toBeUndefined();
    expect(res.fieldsMissing).toEqual(["price", "currency", "imageUrl", "brand", "category"]);
  });

  it("handles a product with no price and no image", async () => {
    const res = await new ProductImportService({ fetchPage: fixtureFetcher("no-price-no-image.html") }).import({ url: "https://crafts.example/mug" });
    expect(res.product).toMatchObject({ title: "Handmade Ceramic Mug", retailer: "crafts.example" });
    expect(res.fieldsMissing).toContain("price");
    expect(res.fieldsMissing).toContain("imageUrl");
  });

  it("imports best-effort from unsupported stores and labels them", async () => {
    const res = await new ProductImportService({ fetchPage: fixtureFetcher("generic-meta.html") }).import({ url: "https://outdoor.example/shoes" });
    expect(res.retailer).toEqual({ id: "generic", name: "Outdoor Co", supported: false });
    expect(res.notes[0]).toBe("Outdoor Co isn't a store CartGuardian specifically supports, so check every field.");
  });

  it("rejects Takealot links that aren't product pages, without fetching", async () => {
    const fetcher = fixtureFetcher("takealot-jsonld.html");
    await expect(new ProductImportService({ fetchPage: fetcher }).import({ url: "https://www.takealot.com/all?qsearch=kettle" })).rejects.toMatchObject({ code: "IMPORT_NOT_A_PRODUCT" });
    expect(fetcher.asked).toEqual([]);
  });

  it("refuses Takealot's app shell instead of importing the store's site-wide title (seen live on 10 Nov)", async () => {
    const run = new ProductImportService({ fetchPage: fixtureFetcher("takealot-app-shell.html") }).import({
      url: "https://www.takealot.com/set-of-two-couple-self-defense-stun-gun-and-pepper-sprays-60ml/PLID91694621",
    });
    await expect(run).rejects.toMatchObject({ code: "IMPORT_NO_PRODUCT_DATA", status: 422 });
    await expect(run).rejects.toThrow(/Takealot didn't include the product's details.*enter the details yourself/);
  });

  it("refuses a product link that redirects to the store's home page (seen live on iStore, 10 Nov)", async () => {
    // A discontinued product: the store redirects to its home page, whose <title> is the store's slogan.
    const fetcher = fixtureFetcher("generic-home-shell.html", "https://shop.example/");
    await expect(new ProductImportService({ fetchPage: fetcher }).import({ url: "https://shop.example/sony-headphones-black" })).rejects.toMatchObject({
      code: "IMPORT_PRODUCT_UNAVAILABLE",
      status: 422,
    });
  });

  it("refuses any store's page that declares itself the home page", async () => {
    const x = extractProduct(fixture("generic-home-shell.html"), new URL("https://shop.example/products/lamp"));
    expect(x.isSiteShell).toBe(true);
    await expect(new ProductImportService({ fetchPage: fixtureFetcher("generic-home-shell.html") }).import({ url: "https://shop.example/products/lamp" })).rejects.toMatchObject({
      code: "IMPORT_NO_PRODUCT_DATA",
    });
    // Linking to the home page itself is not treated as a shell.
    expect(extractProduct(fixture("generic-home-shell.html"), new URL("https://shop.example/")).isSiteShell).toBe(false);
  });

  it("fails clearly when a page has no product data or is a robot check", async () => {
    await expect(new ProductImportService({ fetchPage: fixtureFetcher("no-metadata.html") }).import({ url: "https://shop.example/x" })).rejects.toMatchObject({ code: "IMPORT_NO_PRODUCT_DATA", status: 422 });
    await expect(new ProductImportService({ fetchPage: fixtureFetcher("challenge.html") }).import({ url: "https://www.takealot.com/x/PLID1" })).rejects.toMatchObject({ code: "IMPORT_BLOCKED" });
  });

  it.each([
    [new SafeFetchError("TIMEOUT", "slow"), 504, "IMPORT_TIMEOUT"],
    [new SafeFetchError("BLOCKED", "403", 403), 502, "IMPORT_BLOCKED"],
    [new SafeFetchError("NOT_FOUND", "404", 404), 422, "IMPORT_PAGE_NOT_FOUND"],
    [new SafeFetchError("HTTP_ERROR", "500", 500), 502, "IMPORT_UNREACHABLE"],
    [new SafeFetchError("TOO_LARGE", "big"), 422, "IMPORT_TOO_LARGE"],
    [new SafeFetchError("NOT_HTML", "pdf"), 422, "IMPORT_NOT_A_PAGE"],
    [new SafeFetchError("URL_NOT_ALLOWED", "private"), 400, "IMPORT_URL_NOT_ALLOWED"],
  ])("maps fetch failure %#", async (err, status, code) => {
    const e = await new ProductImportService({ fetchPage: failingFetcher(err) }).import({ url: "https://www.takealot.com/x/PLID1" }).catch((x) => x);
    expect(e).toMatchObject({ status, code });
    expect(e.message).toMatch(/enter the details yourself/i);
  });
});

describe("POST /api/products/import", () => {
  const appWith = (fetchPage: PageFetcher, env: Record<string, string> = {}) =>
    buildTestApp({ importer: new ProductImportService({ fetchPage }), env });

  it("returns the import result", async () => {
    const { app } = appWith(fixtureFetcher("takealot-jsonld.html"));
    const res = await request(app).post("/api/products/import").send({ url: TAKEALOT }).expect(200);
    expect(res.body.product.price).toBe("8999.00");
  });

  it("rejects invalid, local and private links before any request is made", async () => {
    const fetcher = fixtureFetcher("takealot-jsonld.html");
    const { app } = appWith(fetcher);
    await request(app).post("/api/products/import").send({}).expect(400);
    for (const [url, code] of [
      ["not a link", "IMPORT_INVALID_URL"],
      ["file:///etc/passwd", "IMPORT_INVALID_URL"],
      ["http://localhost:8787/api/health", "IMPORT_URL_NOT_ALLOWED"],
      ["http://169.254.169.254/latest/meta-data/", "IMPORT_URL_NOT_ALLOWED"],
      ["http://10.0.0.1/", "IMPORT_URL_NOT_ALLOWED"],
      ["http://[::1]/", "IMPORT_URL_NOT_ALLOWED"],
    ] as const) {
      const res = await request(app).post("/api/products/import").send({ url }).expect(400);
      expect(res.body.error.code, url).toBe(code);
    }
    expect(fetcher.asked).toEqual([]);
  });

  it("uses the real safe fetcher by default, which refuses hosts resolving to private addresses", async () => {
    // localtest.me is public DNS that resolves to 127.0.0.1; even without network the URL is refused or unreachable, never fetched.
    const { app } = buildTestApp();
    const res = await request(app).post("/api/products/import").send({ url: "http://127.0.0.1/" }).expect(400);
    expect(res.body.error.code).toBe("IMPORT_URL_NOT_ALLOWED");
  });

  it("is rate limited", async () => {
    const { app } = appWith(fixtureFetcher("takealot-jsonld.html"), { RATE_LIMIT_IMPORTS_PER_MINUTE: "2" });
    await request(app).post("/api/products/import").send({ url: TAKEALOT }).expect(200);
    await request(app).post("/api/products/import").send({ url: TAKEALOT }).expect(200);
    await request(app).post("/api/products/import").send({ url: TAKEALOT }).expect(429);
  });
});

describe("evaluation with imported details, and manual entry", () => {
  it("still evaluates with no import at all (manual entry)", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/evaluations").send(validInput).expect(201);
    expect(res.body.evaluation.product).toBeUndefined();
  });

  it("evaluates a reviewed import in ZAR and keeps the product context", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/evaluations")
      .send({ productName: "Philips 3200", price: "8999.00", currency: "ZAR", brand: "Philips", category: "Coffee Machines", retailer: "Takealot", sourceUrl: "https://www.takealot.com/p/PLID1", imageUrl: "https://media.takealot.com/x.file" })
      .expect(201);
    expect(res.body.evaluation.amount).toEqual({ currency: "ZAR", value: "8999.00" });
    expect(res.body.evaluation.product).toEqual({ brand: "Philips", category: "Coffee Machines", retailer: "Takealot", sourceUrl: "https://www.takealot.com/p/PLID1", imageUrl: "https://media.takealot.com/x.file" });
  });

  it("applies per-currency price limits and rejects unsafe link fields", async () => {
    const { app } = buildTestApp();
    await request(app).post("/api/evaluations").send({ ...validInput, currency: "ZAR", price: "99999" }).expect(201);
    await request(app).post("/api/evaluations").send({ ...validInput, currency: "ZAR", price: "100000.01" }).expect(400);
    await request(app).post("/api/evaluations").send({ ...validInput, currency: "USD", price: "5000.01" }).expect(400);
    const bad = await request(app).post("/api/evaluations").send({ ...validInput, imageUrl: "javascript:alert(1)" }).expect(400);
    expect(bad.body.error.details[0].field).toBe("imageUrl");
  });

  it("refuses PayPal checkout for ZAR with a clear reason", async () => {
    const { app, paypal } = buildTestApp();
    const ev = await request(app).post("/api/evaluations").send({ ...validInput, currency: "ZAR", price: "8999" }).expect(201);
    const res = await request(app).post("/api/orders").send({ evaluationId: ev.body.evaluation.id }).expect(422);
    expect(res.body.error.code).toBe("CURRENCY_NOT_SUPPORTED_BY_PAYPAL");
    expect(paypal.calls.create).toBe(0);
  });

  it("publishes which currencies checkout supports", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/config").expect(200);
    expect(res.body.currencies).toContain("ZAR");
    expect(res.body.paypalCurrencies).not.toContain("ZAR");
    expect(res.body.maxPriceByCurrency.ZAR).toBe(100000);
  });
});
