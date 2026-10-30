import express, { type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import {
  CreateOrderBodySchema,
  MAX_PRICE,
  SUPPORTED_CURRENCIES,
  type HealthResponse,
  type PublicConfig,
} from "@cartguardian/shared";
import type { AppConfig } from "./config.js";
import type { AiAdapter } from "./ai/index.js";
import type { PayPalApi } from "./paypal/client.js";
import type { Store } from "./store.js";
import { EvaluationService } from "./services/evaluations.js";
import { OrderService } from "./services/orders.js";
import { HttpError, errorHandler } from "./errors.js";

export interface AppDeps {
  config: AppConfig;
  ai: AiAdapter;
  paypal: PayPalApi;
  store: Store;
}

const startedAt = Date.now();

export function createApp({ config, ai, paypal, store }: AppDeps) {
  const app = express();
  const evaluations = new EvaluationService(ai, store);
  const webOrigin = config.webOrigins[0] ?? "http://localhost:5173";
  const orders = new OrderService(paypal, store, { returnUrl: `${webOrigin}/?paypal=return`, cancelUrl: `${webOrigin}/?paypal=cancel` });

  app.disable("x-powered-by");
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy); // needed behind Render/Fly etc. for correct client IPs
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Non-browser clients (curl, tests) send no Origin header.
        if (!origin || config.webOrigins.includes(origin)) return cb(null, true);
        cb(new HttpError(403, "CORS_ORIGIN_DENIED", `Origin ${origin} is not allowed. Add it to WEB_ORIGIN.`));
      },
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "16kb" }));

  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute and try again." } });
      },
    });

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      ai: {
        provider: ai.name,
        configured: ai.name === "mock" || Boolean(ai.name === "gemini" ? config.ai.geminiApiKey : config.ai.anthropicApiKey),
        model: ai.model,
      },
      paypal: { environment: "sandbox", configured: paypal.configured },
    };
    res.json(body);
  });

  app.get("/api/config", (_req, res) => {
    const body: PublicConfig = {
      // The client ID is a public identifier; the secret never leaves the server.
      paypalClientId: config.paypal.clientId ?? null,
      paypalEnvironment: "sandbox",
      aiProvider: ai.name,
      currencies: SUPPORTED_CURRENCIES,
      maxPrice: MAX_PRICE,
    };
    res.json(body);
  });

  app.post("/api/evaluations", limiter(config.rateLimits.evaluationsPerMinute), async (req, res) => {
    const evaluation = await evaluations.create(req.body);
    res.status(201).json({ evaluation });
  });

  app.get("/api/evaluations/:id", async (req: Request<{ id: string }>, res) => {
    res.json({ evaluation: await evaluations.get(req.params.id) });
  });

  app.post("/api/orders", limiter(config.rateLimits.ordersPerMinute), async (req, res) => {
    const parsed = CreateOrderBodySchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_FAILED", "evaluationId must be a UUID.");
    // Any amount/currency in the body is ignored by design.
    const order = await orders.create(parsed.data.evaluationId);
    res.status(201).json({ order });
  });

  app.post("/api/orders/:orderId/capture", limiter(config.rateLimits.ordersPerMinute), async (req: Request<{ orderId: string }>, res) => {
    const result = await orders.capture(req.params.orderId);
    res.status(result.order.status === "PENDING" ? 202 : 200).json(result);
  });

  app.get("/api/orders/:orderId", async (req: Request<{ orderId: string }>, res) => {
    res.json(await orders.status(req.params.orderId));
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown API route.")));
  app.use(errorHandler);
  return app;
}
