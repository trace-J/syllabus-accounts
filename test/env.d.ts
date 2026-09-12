/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Secrets are not declared in wrangler.jsonc, so the generated Env lacks
// them; the tests set them as plain bindings (vitest.config.ts).
declare namespace Cloudflare {
  interface Env {
    GOOGLE_CLIENT_SECRET: string;
    SESSION_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
