export type Bindings = {
  DB: D1Database;
  /** One PanelRelay Durable Object per device: the panel's socket, and the relay over it. */
  PANEL: DurableObjectNamespace;
  /** Where this Worker is published, no trailing slash. */
  PUBLIC_URL: string;
  /** The Web OAuth client in Google Cloud project friendly-bazaar-507320-b7. */
  GOOGLE_CLIENT_ID: string;
  /** Secret: the Web client's secret. `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET: string;
  /** Secret: signs the browser session cookie. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  /** Secret: encrypts stored Drive refresh tokens. `wrangler secret put DRIVE_KEY`. */
  DRIVE_KEY: string;
  /**
   * Secret: the transcription key the proxy spends when Groq is unavailable
   * or unset. `wrangler secret put OPENAI_API_KEY`.
   */
  OPENAI_API_KEY: string;
  /**
   * Secret, OPTIONAL: the cheaper transcription key the proxy prefers.
   * `wrangler secret put GROQ_API_KEY`. Unset means every transcription goes
   * to OpenAI, which is what this service did before Groq.
   */
  GROQ_API_KEY?: string;
  /** Secret: the summary key the proxy spends. `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY: string;
  /**
   * Which Stripe price is which tier. Vars, not secrets: a price id is public
   * and appears in a Checkout URL. They are configuration rather than a table
   * in src/tiers.ts because test mode and live mode have different ids, so a
   * hardcoded one could only ever serve one of them.
   *
   * Empty until the Products are created in the Stripe dashboard. An empty
   * one matches no price, so an unset id reads as "not this tier".
   */
  STRIPE_PRICE_STARTER: string;
  STRIPE_PRICE_STANDARD: string;
  STRIPE_PRICE_PRO: string;
  /**
   * One top-up: 5 more hours for this month, bought when a cap stops
   * somebody. A one-time Price in Stripe, not a recurring one. Empty until it
   * exists, and an empty one means the top-up button is not offered rather
   * than offered and broken.
   */
  STRIPE_PRICE_TOPUP: string;
  /**
   * Secret, OPTIONAL: what Stripe signs its webhooks with.
   * `wrangler secret put STRIPE_WEBHOOK_SECRET`.
   *
   * Optional because there is no Stripe account yet. Unset means
   * /stripe/webhook refuses every delivery with a 503 rather than trusting
   * one, so this deploys safely before Stripe exists and starts working the
   * moment the secret is set.
   */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Secret, OPTIONAL: the Stripe API key. `wrangler secret put STRIPE_SECRET_KEY`.
   *
   * The webhook does not spend it. Verifying a signature is local, and every
   * field this service stores comes out of the event body, so a delivery is
   * handled without calling Stripe back. It is here for the Checkout and
   * Billing Portal sessions in the next slice.
   */
  STRIPE_SECRET_KEY?: string;
};

export type Account = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  created_at: string;
  last_signin_at: string;
  /** Bumped to orphan every device token this account has handed out. */
  token_version: number;
};

export type Device = {
  id: string;
  account_id: string;
  name: string;
  profile: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

/**
 * What every handler can read once the session or bearer middleware ran.
 *
 * `authKind` is the one a route should test when it cares HOW the caller
 * proved who they are. Both a browser cookie and a panel's bearer token set
 * `account`, so `account` alone answers "whose" and never "what kind".
 */
export type Variables = {
  account: Account | null;
  device: Device | null;
  authKind: AuthKind;
};

/** "session" is a person in a browser; "device" is a panel holding a token. */
export type AuthKind = "session" | "device" | null;

export type AppEnv = { Bindings: Bindings; Variables: Variables };
