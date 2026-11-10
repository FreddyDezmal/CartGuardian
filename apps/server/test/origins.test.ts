import { describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { buildTestApp } from "./helpers.js";

const db = { SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };
// What Vercel sets for a preview deployment of the "fred" branch.
const preview = {
  ...db,
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "cartguardian-abc123-team.vercel.app",
  VERCEL_BRANCH_URL: "cartguardian-git-fred-team.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "cartguardian.vercel.app",
};

describe("allowed origins", () => {
  it("defaults to the Vite dev server locally", () => {
    expect(loadConfig({}).webOrigins).toEqual(["http://localhost:5173"]);
  });

  it("reads WEB_ORIGIN and ignores trailing slashes", () => {
    expect(loadConfig({ WEB_ORIGIN: "https://a.example/, http://localhost:5173" }).webOrigins).toEqual(["https://a.example", "http://localhost:5173"]);
  });

  it("on a Vercel preview, allows that deployment's own addresses but not production's", () => {
    expect(loadConfig(preview).webOrigins).toEqual(["https://cartguardian-git-fred-team.vercel.app", "https://cartguardian-abc123-team.vercel.app"]);
  });

  it("on Vercel production, allows the production domain too, after WEB_ORIGIN", () => {
    const o = loadConfig({ ...preview, VERCEL_ENV: "production", WEB_ORIGIN: "https://cartguardian.example" }).webOrigins;
    expect(o[0]).toBe("https://cartguardian.example");
    expect(o).toContain("https://cartguardian.vercel.app");
  });

  it("ignores Vercel variables when not running on Vercel", () => {
    const { VERCEL: _v, ...notVercel } = preview;
    expect(loadConfig(notVercel).webOrigins).toEqual(["http://localhost:5173"]);
  });

  it("serves requests from the preview's own page and still refuses other sites", async () => {
    const { app } = buildTestApp({ env: preview });
    const ok = await request(app).get("/api/config").set("Origin", "https://cartguardian-git-fred-team.vercel.app");
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://cartguardian-git-fred-team.vercel.app");
    const denied = await request(app).get("/api/config").set("Origin", "https://evil-git-fred-team.vercel.app");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("CORS_ORIGIN_DENIED");
  });
});
