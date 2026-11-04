/**
 * Vercel entry point. Bundled by `npm run build:api` into
 * apps/server/dist/vercel.mjs, which /api/index.mjs re-exports as the function.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { bootstrap } from "./bootstrap.js";

const { app } = bootstrap();

/**
 * vercel.json rewrites /api/:path* to this function and also passes the path as
 * ?__cgpath=. If the platform hands us the rewritten URL instead of the original,
 * rebuild /api/<path> from it so Express routes still match.
 */
export function restoreOriginalUrl(url: string): string {
  const u = new URL(url, "http://local");
  const path = u.searchParams.get("__cgpath");
  if (path === null) return url;
  u.searchParams.delete("__cgpath");
  const pathname = u.pathname.startsWith("/api/") && u.pathname !== "/api/index.mjs" ? u.pathname : `/api/${path}`;
  return `${pathname}${u.search}`;
}

/**
 * Vercel's Node "helpers" attach their own res.status/send/json/redirect as own
 * properties, which would shadow Express's response methods. Remove them so
 * Express answers every request itself. (Also disabled via NODEJS_HELPERS=0.)
 */
const HELPER_RES_PROPS = ["status", "send", "json", "redirect"] as const;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  for (const prop of HELPER_RES_PROPS) {
    if (Object.prototype.hasOwnProperty.call(res, prop)) delete (res as unknown as Record<string, unknown>)[prop];
  }
  req.url = restoreOriginalUrl(req.url ?? "/");
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
