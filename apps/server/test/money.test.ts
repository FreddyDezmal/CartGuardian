import { describe, expect, it } from "vitest";
import { divideMoney, fromMinorUnits, moneyEquals, normalizeMoney, toMinorUnits } from "../src/money.js";

describe("money", () => {
  it("round-trips minor units without float drift", () => {
    expect(toMinorUnits("0.1")).toBe(10);
    expect(toMinorUnits("129.99")).toBe(12999);
    expect(fromMinorUnits(12999)).toBe("129.99");
    expect(fromMinorUnits(5)).toBe("0.05");
  });

  it("normalises to 2 decimals", () => {
    expect(normalizeMoney("199.9", "USD")).toEqual({ currency: "USD", value: "199.90" });
    expect(normalizeMoney("5", "EUR")).toEqual({ currency: "EUR", value: "5.00" });
  });

  it("rejects malformed values", () => {
    for (const bad of ["-1", "1e3", "1.234", "", "abc", "01.00", " 1"]) {
      expect(() => toMinorUnits(bad), bad).toThrow();
    }
  });

  it("compares by value and currency", () => {
    expect(moneyEquals({ currency: "USD", value: "10.0" }, { currency: "USD", value: "10.00" })).toBe(true);
    expect(moneyEquals({ currency: "USD", value: "10.00" }, { currency: "EUR", value: "10.00" })).toBe(false);
    expect(moneyEquals({ currency: "USD", value: "10.01" }, { currency: "USD", value: "10.00" })).toBe(false);
  });

  it("divides with half-up rounding", () => {
    expect(divideMoney({ currency: "USD", value: "10.00" }, 3)).toEqual({ currency: "USD", value: "3.33" });
    expect(divideMoney({ currency: "USD", value: "0.05" }, 2)).toEqual({ currency: "USD", value: "0.03" });
  });
});
