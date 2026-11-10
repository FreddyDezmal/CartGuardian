/**
 * Runs one product link import exactly as the API would, and prints the result.
 * Use it to see what a real store page gives CartGuardian, from your own machine:
 *   npm run import:check -w @cartguardian/server -- "https://www.takealot.com/.../PLID12345678"
 * Add --save <file> to also write the raw page the store sent (for debugging an adapter):
 *   npm run import:check -w @cartguardian/server -- "<link>" --save takealot.import.html
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProductImportService } from "../src/import/service.js";
import { HttpError } from "../src/errors.js";
import { safeFetchHtml, type FetchedPage } from "../src/import/safe-fetch.js";

const args = process.argv.slice(2);
const saveAt = args.indexOf("--save");
const saveTo = saveAt >= 0 ? args[saveAt + 1] : undefined;
const url = args.find((a, i) => !a.startsWith("--") && (saveAt < 0 || i !== saveAt + 1));
if (!url || (saveAt >= 0 && !saveTo)) {
  console.error('Usage: npm run import:check -w @cartguardian/server -- "<product link>" [--save takealot.import.html]');
  process.exit(1);
}

// Same safe fetcher as the API; when saving, keep a copy of what came back.
const fetchPage = async (u: string): Promise<FetchedPage> => {
  const page = await safeFetchHtml(u);
  if (saveTo) {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), saveTo);
    writeFileSync(path, page.html);
    console.log(`Saved the page (${page.html.length} characters, HTTP ${page.status}, from ${page.url}) to ${path}\n`);
  }
  return page;
};

const started = Date.now();
new ProductImportService({ fetchPage })
  .import({ url })
  .then((res) => {
    console.log(JSON.stringify(res, null, 2));
    console.log(`\n✓ Imported from ${res.retailer.name} in ${Date.now() - started} ms`);
    console.log(`  Found:   ${res.fieldsFound.join(", ") || "(nothing)"}`);
    console.log(`  Missing: ${res.fieldsMissing.join(", ") || "(nothing)"}`);
  })
  .catch((err) => {
    if (err instanceof HttpError) console.error(`✗ ${err.code} (${err.status}): ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}`);
    else console.error("✗", err);
    process.exit(1);
  });
