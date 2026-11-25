import { eq } from "drizzle-orm";
import { dayKeyOf } from "@luxalgo/journal-core";
import { db, noteTemplates, accounts } from "@/db";
import { handler, ok, bad, requireValue } from "@/server/api";
import { newId, nowIso } from "@/server/ids";
import { getJournalDefaults, getTimeZone, setSetting } from "@/server/settings";
import { parseJournalDefaults } from "@/lib/journal-defaults";

type Context = { params: Promise<{ resource: string }> };
const today = () => dayKeyOf(nowIso(), getTimeZone());
const validDate = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !isNaN(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const text = (s: unknown, max = 100000): s is string => typeof s === "string" && s.length <= max;

export const GET = handler(async (_request: Request, { params }: Context) => {
  const { resource } = await params;
  if (resource === "templates") return ok({ templates: db.select().from(noteTemplates).all() });
  if (resource === "defaults") return ok(getJournalDefaults());
  return bad("Unknown resource", 404);
});

export const POST = handler(async (request: Request, { params }: Context) => {
  const { resource } = await params;
  const b = await request.json();
  if (resource === "templates") {
    requireValue(
      text(b.name, 100) && b.name.trim() && text(b.content),
      "A template needs a name and content (up to 100,000 characters).",
    );
    const id = newId();
    db.insert(noteTemplates).values({ id, name: b.name.trim(), content: b.content }).run();
    return ok({ id });
  }
  if (resource === "defaults") {
    const known = new Set(
      db
        .select({ id: accounts.id })
        .from(accounts)
        .all()
        .map((a) => a.id),
    );
    const parsed = parseJournalDefaults(b, (id) => known.has(id));
    if (parsed.error !== undefined) return bad(parsed.error);
    setSetting("journalDefaults", JSON.stringify(parsed.defaults));
    return ok({ saved: true });
  }
  return bad("Unknown resource", 404);
});

export const DELETE = handler(async (request: Request, { params }: Context) => {
  const { resource } = await params;
  const b = await request.json();
  requireValue(text(b.id, 200), "Invalid id.");
  if (resource === "templates") db.delete(noteTemplates).where(eq(noteTemplates.id, b.id)).run();
  else return bad("Unknown resource", 404);
  return ok({ saved: true });
});
