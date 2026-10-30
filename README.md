# CartGuardian

CartGuardian puts a purchase on trial before you pay. It argues the strongest honest case for and against buying, labels what each point rests on, and then offers a PayPal Sandbox checkout locked to the exact price that was evaluated.

Built for the PayPal AI Hackathon 2026.

- **AI:** Claude (Anthropic API) via forced tool use and schema validation, behind a pluggable adapter. A labelled rule-based mock runs without any key.
- **PayPal:** Orders v2 REST API on the server (create, capture with `PayPal-Request-Id`, verification); PayPal v6 Web SDK in the browser via `@paypal/react-paypal-js/sdk-v6`. Sandbox only.

## Run it

Requires Node 22.12+.

```bash
npm install
npm run check                      # typecheck + tests + build
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Terminal 1: `npm run dev:server` (API on http://localhost:8787)
Terminal 2: `npm run dev:web` (app on http://localhost:5173)

Without credentials, the app runs with the mock AI and checkout disabled. To enable each integration, fill in `apps/server/.env` and verify it in isolation:

```bash
npm run paypal:check -w @cartguardian/server   # PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (Sandbox)
npm run ai:check -w @cartguardian/server       # AI_PROVIDER=anthropic, ANTHROPIC_API_KEY
```

Then restart the API. In the PayPal popup, sign in with your **Sandbox Personal** account.

## How it keeps money honest

- The browser sends only an evaluation ID when creating an order; the server reads the amount it stored. The AI's output schema has no money field.
- Capture succeeds only if PayPal reports the order and capture `COMPLETED` and the amount, currency and reference match.
- Repeat or concurrent captures hit PayPal once; a deterministic `PayPal-Request-Id` guards retries.

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): architecture, API reference, security model, troubleshooting, schedule and demo script.

## Licence

MIT, see [LICENSE](LICENSE).
