import Stripe from "stripe";
import { getStripeClient, getStripeWebhookSecret } from "@/platform/stripe";
import { handleStripeWebhookEvent } from "@/platform/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(
      payload,
      signature,
      getStripeWebhookSecret()
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook signature";
    return new Response(message, { status: 400 });
  }

  try {
    await handleStripeWebhookEvent(event);
    return new Response("ok", { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe webhook handler failed";
    return new Response(message, { status: 500 });
  }
}
