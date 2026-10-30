import { useState } from "react";
import {
  INSTANCE_LOADING_STATE,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  usePayPal,
} from "@paypal/react-paypal-js/sdk-v6";
import type { Evaluation, OrderSummary } from "@cartguardian/shared";
import { api, ApiError } from "../api";

type State =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "done"; order: OrderSummary; replayed: boolean }
  | { kind: "pending"; order: OrderSummary }
  | { kind: "cancelled" }
  | { kind: "error"; message: string; debugId?: string };

const ERROR_COPY: Record<string, string> = {
  ORDER_NOT_APPROVED: "PayPal hasn't confirmed your approval yet. Try the button again.",
  PAYMENT_DECLINED: "PayPal declined that payment method. Choose a different one and try again.",
  AMOUNT_MISMATCH: "The amount PayPal reported didn't match the price on trial, so the purchase wasn't recorded.",
  PAYPAL_TIMEOUT: "PayPal took too long to respond. It's safe to try again; you won't be charged twice.",
  PAYPAL_NOT_CONFIGURED: "Checkout is off: the server has no PayPal Sandbox credentials.",
};

function describe(err: unknown): { message: string; debugId?: string } {
  if (err instanceof ApiError) {
    const debugId = (err.details as { debugId?: string } | undefined)?.debugId;
    return { message: ERROR_COPY[err.code] ?? err.message, debugId };
  }
  return { message: "PayPal checkout failed to start. Reload the page and try again." };
}

function Buttons({ evaluation, onState }: { evaluation: Evaluation; onState: (s: State) => void }) {
  const { loadingStatus, error } = usePayPal();
  if (loadingStatus === INSTANCE_LOADING_STATE.PENDING) return <p className="muted">Loading PayPal…</p>;
  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED)
    return <p className="err">PayPal couldn't load: {error?.message ?? "unknown error"}. Check the client ID and your network.</p>;

  return (
    <PayPalOneTimePaymentButton
      presentationMode="popup"
      createOrder={async () => {
        onState({ kind: "idle" });
        try {
          // Only the evaluation id is sent. The server decides the amount.
          const { order } = await api.createOrder(evaluation.id);
          return { orderId: order.orderId };
        } catch (err) {
          onState({ kind: "error", ...describe(err) });
          throw err;
        }
      }}
      onApprove={async ({ orderId }) => {
        onState({ kind: "capturing" });
        try {
          const res = await api.capture(orderId);
          onState(res.order.status === "PENDING" ? { kind: "pending", order: res.order } : { kind: "done", order: res.order, replayed: res.replayed });
        } catch (err) {
          onState({ kind: "error", ...describe(err) });
        }
      }}
      onCancel={() => onState({ kind: "cancelled" })}
      onError={(e) => onState({ kind: "error", message: `PayPal reported an error: ${e.message}` })}
    />
  );
}

export function Checkout({ evaluation, clientId }: { evaluation: Evaluation; clientId: string | null }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const price = new Intl.NumberFormat(undefined, { style: "currency", currency: evaluation.amount.currency }).format(Number(evaluation.amount.value));

  if (state.kind === "done") {
    return (
      <section className="checkout success" role="status">
        <h2>Purchased in PayPal Sandbox</h2>
        <p>
          {price} captured for {evaluation.productName}. The server confirmed the order with PayPal before recording it.
        </p>
        <dl className="receipt">
          <div><dt>Order</dt><dd>{state.order.orderId}</dd></div>
          <div><dt>Capture</dt><dd>{state.order.captureId}</dd></div>
          <div><dt>Status</dt><dd>{state.order.status}</dd></div>
        </dl>
        <p className="muted">Sandbox only. No real money moved.</p>
      </section>
    );
  }

  return (
    <section className="checkout">
      <div className="checkout-head">
        <h2>Decided to buy?</h2>
        <p>Pay {price} with PayPal Sandbox. The amount is locked to the price on trial.</p>
      </div>

      {!clientId ? (
        <p className="notice">Checkout is off: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in apps/server/.env, then restart the server.</p>
      ) : (
        <PayPalProvider clientId={clientId} environment="sandbox" components={["paypal-payments"]} pageType="checkout">
          <div className="paypal-slot">
            <Buttons evaluation={evaluation} onState={setState} />
          </div>
        </PayPalProvider>
      )}

      {state.kind === "capturing" && <p className="muted" role="status">Confirming payment with PayPal…</p>}
      {state.kind === "pending" && (
        <p className="notice" role="status">PayPal is holding this payment for review (order {state.order.orderId}). It isn't complete yet.</p>
      )}
      {state.kind === "cancelled" && <p className="muted" role="status">Checkout closed. Nothing was charged.</p>}
      {state.kind === "error" && (
        <p className="err" role="alert">
          {state.message}
          {state.debugId && <> PayPal debug ID: <code>{state.debugId}</code></>}
        </p>
      )}
    </section>
  );
}
