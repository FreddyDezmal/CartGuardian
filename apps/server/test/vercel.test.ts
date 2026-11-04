import { describe, expect, it } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import request from "supertest";
import handler from "../src/vercel.js";
import { validInput } from "./helpers.js";

/**
 * Reproduces what Vercel's Node runtime does before calling a function when
 * "helpers" are on (copied from @vercel/node 26.0.0 addHelpers/restoreBody):
 * it reads the whole body, replays it through a PassThrough, defines a lazy
 * req.body, and attaches its own res.status/send/json/redirect.
 */
async function vercelHelpers(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  if (req.method !== "GET" && req.method !== "HEAD") for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const replay = new PassThrough();
  const on = replay.on.bind(replay);
  const originalOn = req.on.bind(req);
  const r = req as unknown as Record<string, unknown>;
  r.read = replay.read.bind(replay);
  r.on = r.addListener = (name: string, cb: (...a: unknown[]) => void) => (name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb));
  replay.write(body);
  replay.end();
  Object.defineProperty(req, "body", {
    configurable: true,
    enumerable: true,
    get: () => (body.length ? JSON.parse(body.toString()) : {}),
    set: (value) => Object.defineProperty(req, "body", { configurable: true, enumerable: true, writable: true, value }),
  });
  const s = res as unknown as Record<string, unknown>;
  s.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  s.json = (obj: unknown) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj) + " /*vercel-helper*/");
    return res;
  };
  s.send = s.json;
  s.redirect = () => res;
}

const plain = http.createServer((req, res) => handler(req, res));
const withHelpers = http.createServer(async (req, res) => {
  await vercelHelpers(req, res);
  handler(req, res);
});

describe("Vercel function entry", () => {
  it.each([
    ["without Vercel helpers", plain],
    ["with Vercel helpers on", withHelpers],
  ])("parses JSON bodies and answers through Express %s", async (_label, server) => {
    const created = await request(server).post("/api/evaluations").send(validInput).expect(201);
    expect(created.body.evaluation.amount).toEqual({ currency: "USD", value: "199.90" });
    // Express, not the helper, wrote the response.
    expect(created.text).not.toContain("vercel-helper");

    await request(server).get("/api/health").expect(200);
    const bad = await request(server).post("/api/evaluations").send({ ...validInput, price: "-1" }).expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("serves the original path when the platform passes the rewritten one", async () => {
    const res = await request(plain).get("/api/index.mjs?__cgpath=health").expect(200);
    expect(res.body.status).toBe("ok");
  });
});
