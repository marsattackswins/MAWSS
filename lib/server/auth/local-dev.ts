import "server-only";

/**
 * Server-domain entry point for the local-dev convenience mode. The predicates
 * live in lib/local-dev-binding.ts because next.config.ts must be able to call
 * the startup binding check before any React Server Component runtime exists.
 */
export * from "../../local-dev-binding";
