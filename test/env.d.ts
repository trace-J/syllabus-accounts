/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Secrets are not declared in wrangler.jsonc, so the generated Env lacks
// them; the tests set them as plain bindings (vitest.config.ts).
declare namespace Cloudflare {
  interface Env {
    GOOGLE_CLIENT_SECRET: string;
    SESSION_SECRET: string;
    DRIVE_KEY: string;
    OPENAI_API_KEY: string;
    GROQ_API_KEY: string;
    ANTHROPIC_API_KEY: string;
    // Optional in src/env.ts, because there is no Stripe account yet. Declared
    // as possibly undefined here so a test can take the secret away and check
    // that the webhook refuses everything without it.
    STRIPE_WEBHOOK_SECRET: string | undefined;
    STRIPE_SECRET_KEY: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
