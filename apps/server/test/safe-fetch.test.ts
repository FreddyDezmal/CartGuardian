import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { isPublicAddress, safeFetchHtml, validateUrl, type ResolvedAddress } from "../src/import/safe-fetch.js";

/**
 * A local server plays every "website". A fake resolver maps test hostnames to
 * addresses, and the address policy allows only 127.0.0.1 (where the server
 * runs), so private-address cases are exercised without real network access.
 */
let server: http.Server;
let port = 0;
let hits: string[] = [];

const DNS: Record<string, string[]> = {
  "shop.test": ["127.0.0.1"],
  "other.test": ["127.0.0.1"],
  "internal.test": ["10.1.2.3"],
  "metadata.test": ["169.254.169.254"],
  "mixed.test": ["127.0.0.1", "192.168.1.10"],
};
const resolve = async (host: string): Promise<ResolvedAddress[]> =>
  (DNS[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const testOpts = () => ({ resolve, isAddressAllowed: (a: string) => a === "127.0.0.1", allowedPorts: [String(port)], timeoutMs: 1500 });
const u = (host: string, path: string) => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    switch (req.url) {
      case "/ok":
        return send(200, "<html><title>Kettle</title></html>");
      case "/latin1":
        res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
        return res.end(Buffer.from([0x43, 0x61, 0x66, 0xe9])); // "Café" in Latin-1
      case "/redirect-ok":
        return send(302, "", { location: u("other.test", "/ok") });
      case "/redirect-private":
        return send(302, "", { location: u("internal.test", "/admin") });
      case "/redirect-metadata":
        return send(301, "", { location: "http://169.254.169.254/latest/meta-data/" });
      case "/redirect-loop":
        return send(302, "", { location: "/redirect-loop" });
      case "/hang":
        return; // never answer
      case "/json":
        return send(200, "{}", { "content-type": "application/json" });
      case "/forbidden":
        return send(403, "captcha");
      case "/gone":
        return send(404, "nope");
      case "/boom":
        return send(500, "error");
      case "/big-declared":
        res.writeHead(200, { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) });
        return res.end("x");
      case "/big-chunked": {
        res.writeHead(200, { "content-type": "text/html" });
        const chunk = "x".repeat(64 * 1024);
        for (let i = 0; i < 64; i++) res.write(chunk); // 4 MB, no length header
        return res.end();
      }
      case "/gzip-bomb": {
        const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20)); // ~20 KB on the wire, 20 MB unpacked
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(bomb.length) });
        return res.end(bomb);
      }
      case "/gzip-ok": {
        const body = zlib.gzipSync(Buffer.from("<html>compressed</html>"));
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(body);
      }
      default:
        return send(404, "");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("validateUrl", () => {
  it.each([
    ["ftp://example.com/x", "INVALID_URL"],
    ["file:///etc/passwd", "INVALID_URL"],
    ["javascript:alert(1)", "INVALID_URL"],
    ["not a url", "INVALID_URL"],
    ["https://user:pass@example.com/", "URL_NOT_ALLOWED"],
    ["https://example.com:8443/", "URL_NOT_ALLOWED"],
    ["http://localhost/", "URL_NOT_ALLOWED"],
    ["http://admin.localhost/", "URL_NOT_ALLOWED"],
    ["http://printer.local/", "URL_NOT_ALLOWED"],
    ["http://intranet/", "URL_NOT_ALLOWED"],
    ["http://127.0.0.1/", "URL_NOT_ALLOWED"],
    ["http://10.0.0.8/", "URL_NOT_ALLOWED"],
    ["http://192.168.1.1/", "URL_NOT_ALLOWED"],
    ["http://172.20.0.1/", "URL_NOT_ALLOWED"],
    ["http://169.254.169.254/latest/meta-data/", "URL_NOT_ALLOWED"],
    ["http://100.100.100.200/", "URL_NOT_ALLOWED"],
    ["http://0.0.0.0/", "URL_NOT_ALLOWED"],
    ["http://2130706433/", "URL_NOT_ALLOWED"], // decimal 127.0.0.1
    ["http://0x7f000001/", "URL_NOT_ALLOWED"], // hex 127.0.0.1
    ["http://[::1]/", "URL_NOT_ALLOWED"],
    ["http://[::ffff:127.0.0.1]/", "URL_NOT_ALLOWED"],
    ["http://[fd00:ec2::254]/", "URL_NOT_ALLOWED"], // AWS IPv6 metadata
    ["http://[fe80::1]/", "URL_NOT_ALLOWED"],
  ])("rejects %s", (raw, code) => {
    expect(() => validateUrl(raw)).toThrow(expect.objectContaining({ code }));
  });

  it("accepts normal https product links", () => {
    expect(validateUrl("  https://www.takealot.com/x/PLID123  ").hostname).toBe("www.takealot.com");
    expect(validateUrl("http://93.184.215.14/page").hostname).toBe("93.184.215.14");
  });
});

describe("isPublicAddress", () => {
  it("allows public unicast and refuses everything else", () => {
    for (const a of ["8.8.8.8", "41.0.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ["127.0.0.1", "10.2.3.4", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::1", "not-an-ip"])
      expect(isPublicAddress(a), a).toBe(false);
  });
});

describe("safeFetchHtml", () => {
  it("fetches an HTML page", async () => {
    const page = await safeFetchHtml(u("shop.test", "/ok"), testOpts());
    expect(page.html).toContain("Kettle");
    expect(page.status).toBe(200);
  });

  it("decodes the declared charset and gzip bodies", async () => {
    expect((await safeFetchHtml(u("shop.test", "/latin1"), testOpts())).html).toBe("Café");
    expect((await safeFetchHtml(u("shop.test", "/gzip-ok"), testOpts())).html).toBe("<html>compressed</html>");
  });

  it("refuses hostnames that resolve to private addresses, before connecting", async () => {
    hits = [];
    await expect(safeFetchHtml(u("internal.test", "/"), testOpts())).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(safeFetchHtml(u("metadata.test", "/"), testOpts())).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    expect(hits).toEqual([]);
  });

  it("refuses a hostname when any of its addresses is private (rebinding-style answers)", async () => {
    hits = [];
    await expect(safeFetchHtml(u("mixed.test", "/ok"), testOpts())).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    expect(hits).toEqual([]);
  });

  it("uses the real default policy: even the test server's own address is refused", async () => {
    await expect(safeFetchHtml(u("shop.test", "/ok"), { resolve, allowedPorts: [String(port)] })).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });

  it("follows safe redirects and re-validates every hop", async () => {
    const page = await safeFetchHtml(u("shop.test", "/redirect-ok"), testOpts());
    expect(page.url.hostname).toBe("other.test");
    await expect(safeFetchHtml(u("shop.test", "/redirect-private"), testOpts())).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(safeFetchHtml(u("shop.test", "/redirect-metadata"), testOpts())).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(safeFetchHtml(u("shop.test", "/redirect-loop"), testOpts())).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("times out", async () => {
    const started = Date.now();
    await expect(safeFetchHtml(u("shop.test", "/hang"), { ...testOpts(), timeoutMs: 300 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("caps response size, including after decompression", async () => {
    const opts = { ...testOpts(), maxBytes: 1024 * 1024 };
    await expect(safeFetchHtml(u("shop.test", "/big-declared"), opts)).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(safeFetchHtml(u("shop.test", "/big-chunked"), opts)).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(safeFetchHtml(u("shop.test", "/gzip-bomb"), opts)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("accepts only HTML and maps HTTP errors", async () => {
    await expect(safeFetchHtml(u("shop.test", "/json"), testOpts())).rejects.toMatchObject({ code: "NOT_HTML" });
    await expect(safeFetchHtml(u("shop.test", "/forbidden"), testOpts())).rejects.toMatchObject({ code: "BLOCKED", status: 403 });
    await expect(safeFetchHtml(u("shop.test", "/gone"), testOpts())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(safeFetchHtml(u("shop.test", "/boom"), testOpts())).rejects.toMatchObject({ code: "HTTP_ERROR", status: 500 });
  });

  it("reports unknown hosts as network errors", async () => {
    await expect(safeFetchHtml(u("nowhere.test", "/"), testOpts())).rejects.toMatchObject({ code: "NETWORK" });
  });
});
