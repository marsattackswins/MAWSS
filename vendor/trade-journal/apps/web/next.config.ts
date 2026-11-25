import path from "node:path";
import type { NextConfig } from "next";

// Served under the MAWS origin through the host's /journal rewrite, so the
// journal behaves as an internal MAWS page (same-origin iframe, shared
// cookies) instead of a separate localhost port. Run standalone builds with
// JOURNAL_BASE_PATH="" to restore root-path serving.
const basePath = process.env.JOURNAL_BASE_PATH ?? "/journal";
// Next rewrites page routes, <Link> and static assets for us, but raw client
// fetch()/href strings never honor basePath — publish it as an env var so
// src/lib/base-path.ts can prefix those call sites.
const envPublic =
  basePath === "" ? undefined : { NEXT_PUBLIC_JOURNAL_BASE_PATH: basePath };

const nextConfig: NextConfig = {
  basePath,
  env: envPublic,
  // Pin the Turbopack project root to this app. When vendored inside another
  // Next.js workspace (e.g. MAWS), Turbopack otherwise infers the ANCESTOR's
  // package-lock directory as root and compiles the host project's
  // instrumentation.ts server hook, which then fails startup module resolution.
  turbopack: { root: path.join(__dirname) },
  output: "standalone",
  transpilePackages: ["@luxalgo/journal-core", "@luxalgo/journal-importers"],
  serverExternalPackages: ["better-sqlite3"],
  // Runtime journal files belong on the user's disk, never in a deployable bundle.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "../../outputs/**/*", "../../.runtime-backup*/**/*"],
  },
};

export default nextConfig;
