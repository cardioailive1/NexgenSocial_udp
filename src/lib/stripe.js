// Stripe client, created lazily so the app still boots without a key --
// ads then fall back to the plain payment link rather than crashing the
// whole server on startup.
let stripeClient = null;

function getStripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require("stripe");
    stripeClient = new Stripe(key);
    return stripeClient;
  } catch (err) {
    console.error("Stripe SDK failed to initialise:", err.message);
    return null;
  }
}

function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

module.exports = { getStripe, isStripeConfigured };
