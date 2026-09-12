export type Bindings = {
  DB: D1Database;
  /** Where this Worker is published, no trailing slash. */
  PUBLIC_URL: string;
  /** The Web OAuth client in the Syllabus Google Cloud project. */
  GOOGLE_CLIENT_ID: string;
  /** Secret: the Web client's secret. `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET: string;
  /** Secret: signs the browser session cookie. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
};

export type Account = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  created_at: string;
  last_signin_at: string;
};

export type Device = {
  id: string;
  account_id: string;
  name: string;
  profile: string;
  public_url: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

/** What every handler can read once the session or bearer middleware ran. */
export type Variables = {
  account: Account | null;
  device: Device | null;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
