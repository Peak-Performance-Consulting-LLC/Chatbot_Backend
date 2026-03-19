import Stripe from "stripe";
import { assertEnvVars, getEnv } from "@/config/env";
import { HttpError } from "@/lib/httpError";

let cachedStripeClient: Stripe | null = null;

function assertStripeSecretKey(value: string) {
  if (value.startsWith("sk_") || value.startsWith("rk_")) {
    return value;
  }

  if (value.startsWith("pk_")) {
    throw new HttpError(
      500,
      "STRIPE_SECRET_KEY must be a Stripe secret key (sk_... or rk_...), not a publishable key (pk_...)."
    );
  }

  throw new HttpError(500, "STRIPE_SECRET_KEY must be a Stripe secret key starting with sk_ or rk_.");
}

function buildStripeClient() {
  assertEnvVars(["STRIPE_SECRET_KEY"]);
  return new Stripe(assertStripeSecretKey(getEnv().STRIPE_SECRET_KEY));
}

export function getStripeClient() {
  if (!cachedStripeClient) {
    cachedStripeClient = buildStripeClient();
  }

  return cachedStripeClient;
}

export function getStripeWebhookSecret() {
  assertEnvVars(["STRIPE_WEBHOOK_SECRET"]);
  const value = getEnv().STRIPE_WEBHOOK_SECRET;

  if (!value.startsWith("whsec_")) {
    if (value.startsWith("pk_")) {
      throw new HttpError(
        500,
        "STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_...), not a publishable key (pk_...)."
      );
    }

    throw new HttpError(500, "STRIPE_WEBHOOK_SECRET must start with whsec_.");
  }

  return value;
}

export function getStripePriceId(plan: "starter" | "growth") {
  const envKey = plan === "starter" ? "STRIPE_PRICE_STARTER" : "STRIPE_PRICE_GROWTH";
  assertEnvVars([envKey]);
  const value = plan === "starter" ? getEnv().STRIPE_PRICE_STARTER : getEnv().STRIPE_PRICE_GROWTH;

  if (!value.startsWith("price_")) {
    if (value.startsWith("prod_")) {
      throw new HttpError(
        500,
        `${envKey} must be a Stripe Price ID (price_...), not a Product ID (${value}). Open the product in Stripe and copy its recurring monthly price ID.`
      );
    }

    throw new HttpError(500, `${envKey} must be a Stripe Price ID starting with price_.`);
  }

  return value;
}

export function buildPlatformCheckoutUrls(plan: "starter" | "growth") {
  const appUrl = getEnv().PLATFORM_APP_URL.replace(/\/$/, "");

  return {
    success_url: `${appUrl}/platform/app/pricing?checkout=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/platform/app/pricing?checkout=cancel&plan=${plan}`
  };
}

export function normalizeStripeMetadataValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function toIsoFromStripeTimestamp(input: number | null | undefined) {
  if (!input || !Number.isFinite(input)) {
    return new Date().toISOString();
  }

  return new Date(input * 1000).toISOString();
}

export function isPaidPlan(plan: string | null | undefined): plan is "starter" | "growth" {
  return plan === "starter" || plan === "growth";
}
