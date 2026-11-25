/**
 * Prefix a client-side URL with the app's basePath. Next handles page routes,
 * <Link> and static assets automatically, but raw fetch()/href strings do not —
 * those call sites must route through here. The value comes from the vendored
 * next.config.ts (JOURNAL_BASE_PATH), which publishes it as a public env var.
 */
export const withBasePath = (url: string): string =>
  process.env.NEXT_PUBLIC_JOURNAL_BASE_PATH && url.startsWith("/")
    ? `${process.env.NEXT_PUBLIC_JOURNAL_BASE_PATH}${url}`
    : url;
