import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Fetches a public web page for product import without letting a user point
 * the server at internal systems (SSRF).
 *
 * - Only http/https on the default ports, no credentials in the URL.
 * - Every address a hostname resolves to must be public; the socket then
 *   connects to exactly the address that was checked (custom `lookup`), so a
 *   DNS answer can't change between the check and the connection (rebinding).
 * - IP-literal hosts are checked directly (Node skips `lookup` for them).
 * - Redirects are followed manually and every hop is re-validated.
 * - One deadline covers the whole fetch; the body is capped after decompression.
 * - Only HTML is accepted, and nothing in it is ever executed.
 */

export type FetchFailure =
  | "INVALID_URL"
  | "URL_NOT_ALLOWED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "NOT_HTML"
  | "BLOCKED"
  | "NOT_FOUND"
  | "HTTP_ERROR"
  | "TOO_MANY_REDIRECTS"
  | "NETWORK";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: FetchFailure,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** DNS resolution. Injected in tests; defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address policy. Injected in tests; defaults to public addresses only. */
  isAddressAllowed?: (address: string) => boolean;
  /** Ports allowed in URLs. Defaults to the standard web ports; tests add their local port. */
  allowedPorts?: string[];
}

export interface FetchedPage {
  url: URL;
  status: number;
  contentType: string;
  html: string;
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 4,
  userAgent: "Mozilla/5.0 (compatible; CartGuardian/0.1; user-requested product import)",
};

const DEFAULT_PORTS = ["", "80", "443"];
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

// Non-public ranges: private, loopback, link-local (incl. cloud metadata 169.254.169.254
// and fd00:ec2::254), CGNAT (incl. 100.100.100.200), documentation, benchmarking,
// multicast, reserved, and IPv6 transition ranges that can wrap private IPv4.
const BLOCKED = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net6, prefix, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) -> judge the embedded IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !BLOCKED.check(address, "ipv6");
  }
  return false;
}

/** Parses and checks a user-supplied URL before any network activity. */
export function validateUrl(raw: string, allowedPorts: readonly string[] = DEFAULT_PORTS): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError("INVALID_URL", "That doesn't look like a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SafeFetchError("INVALID_URL", "Only http and https links can be imported.");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("URL_NOT_ALLOWED", "Links with a username or password can't be imported.");
  }
  if (!allowedPorts.includes(url.port)) {
    throw new SafeFetchError("URL_NOT_ALLOWED", "Links to non-standard ports can't be imported.");
  }
  const host = hostOf(url);
  if (!host || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SafeFetchError("URL_NOT_ALLOWED", "That address points at a private or local network.");
  }
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new SafeFetchError("URL_NOT_ALLOWED", "That address points at a private or local network.");
  }
  if (!net.isIP(host) && !host.includes(".")) {
    // Single-label names (e.g. "intranet") only resolve on internal networks.
    throw new SafeFetchError("URL_NOT_ALLOWED", "That address points at a private or local network.");
  }
  return url;
}

function hostOf(url: URL): string {
  // URL keeps IPv6 literals in brackets.
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

const systemResolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export async function safeFetchHtml(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const opts = { ...DEFAULTS, ...options };
  const resolve = options.resolve ?? systemResolve;
  const allowed = options.isAddressAllowed ?? isPublicAddress;
  const deadline = Date.now() + opts.timeoutMs;

  const ports = options.allowedPorts ?? DEFAULT_PORTS;
  let url = validateUrl(rawUrl, ports);
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await requestOnce(url, { ...opts, resolve, allowed, deadline });
    if (res.redirect) {
      if (hop === opts.maxRedirects) throw new SafeFetchError("TOO_MANY_REDIRECTS", "The page redirected too many times.");
      let next: URL;
      try {
        next = new URL(res.redirect, url);
      } catch {
        throw new SafeFetchError("INVALID_URL", "The page redirected to an invalid address.");
      }
      url = validateUrl(next.toString(), ports); // every hop is checked again
      continue;
    }
    return { url, status: res.status, contentType: res.contentType, html: res.html! };
  }
  throw new SafeFetchError("TOO_MANY_REDIRECTS", "The page redirected too many times.");
}

interface HopResult {
  status: number;
  contentType: string;
  redirect?: string;
  html?: string;
}

function requestOnce(
  url: URL,
  o: typeof DEFAULTS & { resolve: (h: string) => Promise<ResolvedAddress[]>; allowed: (a: string) => boolean; deadline: number },
): Promise<HopResult> {
  const remaining = o.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new SafeFetchError("TIMEOUT", "The store took too long to respond."));

  const host = hostOf(url);
  if (net.isIP(host) && !o.allowed(host)) {
    return Promise.reject(new SafeFetchError("URL_NOT_ALLOWED", "That address points at a private or local network."));
  }

  // Resolve, check every address, and hand the socket only checked addresses.
  const lookup = (
    hostname: string,
    lookupOpts: { all?: boolean } | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void,
  ) => {
    o.resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), "");
          return;
        }
        // Strict: one private answer is enough to refuse (mixed answers are a rebinding trick).
        if (addresses.some((a) => !o.allowed(a.address))) {
          callback(Object.assign(new Error("Resolved to a non-public address"), { code: "CG_PRIVATE_ADDRESS" }), "");
          return;
        }
        if (typeof lookupOpts === "object" && lookupOpts?.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };

  return new Promise<HopResult>((resolvePromise, reject) => {
    let settled = false;
    const fail = (err: SafeFetchError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    };
    const succeed = (r: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };

    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: lookup as unknown as net.LookupFunction,
        // Never reuse pooled sockets: each request must go through our lookup.
        agent: false,
        headers: {
          "User-Agent": o.userAgent,
          Accept: "text/html,application/xhtml+xml;q=0.9",
          "Accept-Language": "en-ZA,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          succeed({ status, contentType, redirect: String(res.headers.location) });
          return;
        }
        if (status === 401 || status === 403 || status === 429 || status === 503) {
          res.resume();
          fail(new SafeFetchError("BLOCKED", "The store didn't let CartGuardian read this page.", status));
          return;
        }
        if (status === 404 || status === 410) {
          res.resume();
          fail(new SafeFetchError("NOT_FOUND", "The store says this page doesn't exist.", status));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          fail(new SafeFetchError("HTTP_ERROR", `The store responded with an error (${status}).`, status));
          return;
        }
        if (!/^(text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
          res.resume();
          fail(new SafeFetchError("NOT_HTML", "That link isn't a web page CartGuardian can read."));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          res.resume();
          fail(new SafeFetchError("TOO_LARGE", "That page is too large to import."));
          return;
        }

        let body: Readable = res;
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        if (encoding === "gzip" || encoding === "x-gzip") body = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") body = res.pipe(zlib.createInflate());
        else if (encoding === "br") body = res.pipe(zlib.createBrotliDecompress());

        // Count bytes after decompression, so a small compressed bomb can't explode in memory.
        const chunks: Buffer[] = [];
        let total = 0;
        body.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > o.maxBytes) {
            body.destroy();
            fail(new SafeFetchError("TOO_LARGE", "That page is too large to import."));
            return;
          }
          chunks.push(chunk);
        });
        body.on("error", () => fail(new SafeFetchError("NETWORK", "The page couldn't be read.")));
        body.on("end", () => succeed({ status, contentType, html: decode(Buffer.concat(chunks), contentType) }));
      },
    );

    const timer = setTimeout(() => fail(new SafeFetchError("TIMEOUT", "The store took too long to respond.")), Math.max(1, o.deadline - Date.now()));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "CG_PRIVATE_ADDRESS") fail(new SafeFetchError("URL_NOT_ALLOWED", "That address points at a private or local network."));
      else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") fail(new SafeFetchError("NETWORK", "That website couldn't be found."));
      else fail(new SafeFetchError("NETWORK", "The store couldn't be reached."));
    });
    req.end();
  });
}

function decode(buf: Buffer, contentType: string): string {
  const charset = /charset=([^;\s]+)/.exec(contentType)?.[1]?.replace(/["']/g, "");
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
