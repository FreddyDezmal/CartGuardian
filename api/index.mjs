// Vercel Function: every /api/* request is rewritten here (see vercel.json).
// The Express app is bundled by `npm run build:vercel` before Vercel builds functions.
export { default } from "../apps/server/dist/vercel.mjs";
