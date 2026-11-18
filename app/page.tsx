import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isChartPageAuthorized } from "@/lib/server/auth/page-guard";
import { AppShell } from "@/components/shell/AppShell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const headersList = await headers();

  let authorized: boolean;
  try {
    authorized = isChartPageAuthorized(headersList);
  } catch {
    // Configuration load failure: fail closed, do not render the terminal.
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--app-bg)]">
        <div className="max-w-md text-center">
          <div className="mb-4 text-lg text-[var(--app-down)]">Service Unavailable</div>
          <div className="text-sm text-[var(--app-muted)]">
            The terminal is temporarily unavailable. Please contact support if this persists.
          </div>
        </div>
      </div>
    );
  }

  if (!authorized) redirect("/login");
  return <AppShell />;
}
