import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

/** Only same-origin absolute paths are worth returning to; anything else is "/". */
function returnPath(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  return <LoginForm next={returnPath(params.next)} />;
}
