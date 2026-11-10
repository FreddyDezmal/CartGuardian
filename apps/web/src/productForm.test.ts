import { describe, expect, it } from "vitest";
import { EvaluationInputSchema, type ProductImportResponse } from "@cartguardian/shared";
import { applyImport, clearImported, importMessages, editField, initialState, toEvaluationInput, validate, type FormState } from "./productForm";

const fullImport: ProductImportResponse = {
  success: true,
  product: {
    title: "Philips 3200 Espresso Machine",
    description: "Fresh beans, 5 drinks.",
    price: "8999.00",
    currency: "ZAR",
    imageUrl: "https://media.takealot.com/x.file",
    brand: "Philips",
    category: "Coffee Machines",
    retailer: "Takealot",
    sourceUrl: "https://www.takealot.com/p/PLID1",
  },
  fieldsFound: ["title", "description", "price", "currency", "imageUrl", "brand", "category"],
  fieldsMissing: [],
  retailer: { id: "takealot", name: "Takealot", supported: true },
  notes: [],
};

const partialImport: ProductImportResponse = {
  ...fullImport,
  product: { title: "Russell Hobbs Kettle", retailer: "Takealot", sourceUrl: "https://www.takealot.com/k/PLID2" },
  fieldsFound: ["title"],
  fieldsMissing: ["description", "price", "currency", "imageUrl", "brand", "category"],
};

describe("manual entry (no import)", () => {
  it("builds a valid evaluation request from typed values alone", () => {
    let s = initialState();
    s = editField(s, "productName", "Second-hand bicycle");
    s = editField(s, "price", "120");
    const input = toEvaluationInput(s);
    expect(EvaluationInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ productName: "Second-hand bicycle", price: "120", currency: "USD", retailer: undefined, sourceUrl: undefined });
    expect(s.origin).toEqual({});
  });
});

describe("applying an import", () => {
  it("fills found fields and tags them as imported", () => {
    const { state, missing } = applyImport(initialState(), fullImport);
    expect(state.fields).toMatchObject({ productName: "Philips 3200 Espresso Machine", price: "8999.00", currency: "ZAR", brand: "Philips", category: "Coffee Machines" });
    expect(state.origin).toMatchObject({ productName: "imported", price: "imported", currency: "imported", imageUrl: "imported" });
    expect(state.source).toEqual({ retailer: "Takealot", sourceUrl: "https://www.takealot.com/p/PLID1", supported: true });
    expect(missing).toEqual([]);
  });

  it("keeps what the user already typed when the import lacks a field", () => {
    let s = editField(initialState(), "price", "499");
    s = editField(s, "intendedUse", "Morning tea");
    const { state, missing } = applyImport(s, partialImport);
    expect(state.fields.productName).toBe("Russell Hobbs Kettle");
    expect(state.fields.price).toBe("499");
    expect(state.fields.intendedUse).toBe("Morning tea");
    expect(state.origin.price).toBeUndefined();
    expect(missing).toEqual(["description", "price", "image", "brand", "category"]);
  });

  it("does not put a price beside the wrong currency when the page's currency can't be evaluated", () => {
    const res = { ...fullImport, product: { ...fullImport.product, currency: "JPY" } };
    const { state, warnings } = applyImport(editField(initialState(), "price", "10"), res);
    expect(state.fields.currency).toBe("USD");
    expect(state.fields.price).toBe("10");
    expect(warnings.join(" ")).toContain("JPY");
  });

  it("reports missing fields straight from the response, so a partial import is never shown as complete", () => {
    expect(importMessages(partialImport)).toEqual({ missing: ["description", "price", "image", "brand", "category"], warnings: [] });
    expect(importMessages(fullImport)).toEqual({ missing: [], warnings: [] });
  });

  it("passes the server's notes through", () => {
    const res = { ...fullImport, notes: ["The price varies by option; showing the lowest."] };
    expect(applyImport(initialState(), res).warnings).toEqual(["The price varies by option; showing the lowest."]);
  });
});

describe("imported fields stay editable", () => {
  it("lets every imported field be changed, and marks it edited", () => {
    let s: FormState = applyImport(initialState(), fullImport).state;
    s = editField(s, "productName", "Philips 3200 (corrected)");
    s = editField(s, "price", "8499.00");
    s = editField(s, "currency", "USD");
    s = editField(s, "imageUrl", "");
    s = editField(s, "brand", "Philips Domestic");
    expect(s.fields).toMatchObject({ productName: "Philips 3200 (corrected)", price: "8499.00", currency: "USD", imageUrl: "", brand: "Philips Domestic" });
    expect(s.origin).toMatchObject({ productName: "edited", price: "edited", currency: "edited", imageUrl: "edited", brand: "edited", category: "imported" });
  });

  it("submits the reviewed values, not the import response", () => {
    let s = applyImport(initialState(), fullImport).state;
    s = editField(s, "price", "8499.00");
    s = editField(s, "imageUrl", "");
    const input = toEvaluationInput(s);
    expect(input).toMatchObject({ price: "8499.00", currency: "ZAR", brand: "Philips", retailer: "Takealot", sourceUrl: "https://www.takealot.com/p/PLID1" });
    expect(input.imageUrl).toBeUndefined();
    expect(EvaluationInputSchema.safeParse(input).success).toBe(true);
  });

  it("can discard imported details while keeping the user's own fields", () => {
    let s = editField(initialState(), "intendedUse", "Weekend baking");
    s = applyImport(s, fullImport).state;
    s = clearImported(s);
    expect(s.fields).toMatchObject({ productName: "", price: "", currency: "USD", brand: "", imageUrl: "", intendedUse: "Weekend baking" });
    expect(s.source).toBeUndefined();
    expect(s.origin).toEqual({});
  });
});

describe("validation", () => {
  it("uses per-currency limits and checks image links", () => {
    const base = { ...initialState().fields, productName: "Fridge" };
    expect(validate({ ...base, price: "15000", currency: "ZAR" })).toEqual({});
    expect(validate({ ...base, price: "15000", currency: "USD" }).price).toMatch(/5\D?000 USD/); // digit grouping follows the machine's locale, e.g. "5 000" in en-ZA
    expect(validate({ ...base, price: "1.999" }).price).toMatch(/2 decimals/);
    expect(validate({ ...base, price: "10", imageUrl: "javascript:alert(1)" }).imageUrl).toBeDefined();
    expect(validate({ ...initialState().fields, price: "10" }).name).toBe("Name the product.");
  });
});
