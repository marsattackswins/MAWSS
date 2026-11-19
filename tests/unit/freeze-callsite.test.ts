/**
 * FIX A (batch 1b) — every freeze call site must name its typed code.
 *
 * The freeze code used to default to UNCERTAIN_INTENT, the weakest clear rule,
 * so a call site that forgot it silently reintroduced the old "any terminal
 * order event clears any freeze" bug. `code` is now required; this source scan
 * fails if a call site still passes only a reason.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "lib", "server");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Returns the raw argument text of each `.freeze(...)` call in a file. */
function freezeArguments(source: string): string[] {
  const marker = ".freeze(";
  const calls: string[] = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 1;
    let quote: string | null = null;
    let args = "";
    let i = index + marker.length;
    for (; i < source.length && depth > 0; i += 1) {
      const char = source[i];
      if (quote) {
        args += char;
        if (char === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        args += char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      args += char;
    }
    calls.push(args);
    index = source.indexOf(marker, i);
  }
  return calls;
}

function hasTopLevelComma(args: string): boolean {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i];
    if (quote) {
      if (char === quote && args[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

describe("freeze call sites", () => {
  test("every freeze() call passes a typed code", () => {
    const offenders: string[] = [];
    let callCount = 0;
    for (const file of sourceFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const args of freezeArguments(source)) {
        callCount += 1;
        if (!hasTopLevelComma(args)) {
          offenders.push(`${relative(process.cwd(), file)}: freeze(${args.trim()})`);
        }
      }
    }
    expect(callCount).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("the legacy frozen flag pair is written only by the typed freeze registry", () => {
    const writers: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!/RUNTIME_KEYS\.frozen(?:Reason)?\b/.test(source)) continue;
      if (!/setRuntime\(/.test(source)) continue;
      writers.push(relative(process.cwd(), file).replace(/\\/g, "/"));
    }
    expect(writers).toEqual(["lib/server/binance/freeze.ts"]);
  });
});
