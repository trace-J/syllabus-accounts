import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against a real, throwaway D1: the migrations in
// ./migrations are applied before each test file (see test/apply-migrations.ts).
// Nothing reaches Google; the token endpoint is mocked where a test needs it.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUBLIC_URL: "https://accounts.test",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            SESSION_SECRET: "test-session-secret-long-enough-to-sign-with",
            DRIVE_KEY: "test-drive-key",
            OPENAI_API_KEY: "sk-test-openai",
            GROQ_API_KEY: "gsk-test-groq",
            ANTHROPIC_API_KEY: "sk-ant-test",
            STRIPE_PRICE_STARTER: "price_test_starter",
            STRIPE_PRICE_STANDARD: "price_test_standard",
            STRIPE_PRICE_PRO: "price_test_pro",
            STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
            STRIPE_SECRET_KEY: "sk_test_unused_by_the_webhook",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
