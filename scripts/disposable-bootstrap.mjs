import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BINANCE_CREDENTIALS = [
  "MAWS_BINANCE_API_KEY", "MAWS_BINANCE_API_SECRET",
  "MAWS_BINANCE_TESTNET_API_KEY", "MAWS_BINANCE_TESTNET_API_SECRET",
  "MAWS_BINANCE_PRODUCTION_API_KEY", "MAWS_BINANCE_PRODUCTION_API_SECRET",
];

const OS_VARIABLES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "WINDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
  "TEMP", "TMP", "HOME", "SHELL", "LANG", "TERM", "CI",
]);
const present = (value) => Boolean(value?.trim());

/** No ambient reads: callers supply either the effective dev env or a test bag. */
export function assertThrowawayAllowed(source) {
  if (BINANCE_CREDENTIALS.slice(4).some((name) => present(source[name]))) {
    throw new Error("Throwaway refused: a Live credential component is configured.");
  }
  const mode = source.MAWS_ENV?.trim().toLowerCase();
  const profile = source.MAWS_DEFAULT_PROFILE?.trim().toLowerCase();
  if ((mode && mode !== "testnet") || (profile && profile !== "binance-testnet")) {
    throw new Error("Throwaway refused: Live or unsupported environment/profile selection.");
  }
  const [key, secret, testKey, testSecret] = BINANCE_CREDENTIALS.map((name) => source[name]?.trim());
  if ((key || secret) && (mode !== "testnet" || !key || !secret ||
      ((testKey || testSecret) && (key !== testKey || secret !== testSecret)))) {
    throw new Error("Throwaway refused: ambiguous legacy credential mapping.");
  }
  if (present(source.MAWS_OPERATOR_AUTH)) {
    throw new Error("Throwaway refused: existing MAWS_OPERATOR_AUTH will not be overwritten. Use normal dev.");
  }
}

export function requireOperatorAuth(source) {
  if (!present(source.MAWS_OPERATOR_AUTH)) {
    throw new Error("Configure MAWS_OPERATOR_AUTH before npm run dev, or explicitly use npm run dev -- --throwaway.");
  }
  if (!/^(?:[0-9a-f]{2}){8,}:(?:[0-9a-f]{2}){8,}$/i.test(source.MAWS_OPERATOR_AUTH.trim())) {
    throw new Error("MAWS_OPERATOR_AUTH must be a salt:scrypt-hash verifier.");
  }
}

/** Fresh verifier and password, never logged or written to a credential file. */
export function generateOperator() {
  const password = crypto.randomBytes(24).toString("base64url");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { password, verifier: `${salt.toString("hex")}:${hash.toString("hex")}` };
}

/** Only explicit disposable runs use this environment; integration runners are unchanged. */
export function createDisposableContext({ source = {}, purpose = "e2e" } = {}) {
  if (!["e2e", "throwaway", "build", "unit", "typecheck"].includes(purpose)) {
    throw new Error("Unsupported disposable launch purpose.");
  }
  if (purpose === "throwaway") assertThrowawayAllowed(source);
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (OS_VARIABLES.has(name.toUpperCase()) && value !== undefined) env[name] = value;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maws-disposable-"));
  const operator = generateOperator();
  Object.assign(env, {
    MAWS_ENV: "testnet",
    MAWS_DEFAULT_PROFILE: "binance-testnet",
    MAWS_OPERATOR_AUTH: operator.verifier,
    MAWS_DB_PATH: path.join(directory, "app.db"),
    MAWS_STATE_DIR: path.join(directory, "state"),
    MAWS_ALLOWED_ORIGIN: `http://localhost:${purpose === "e2e" ? 3001 : 3000}`,
    MAWS_TRUST_PROXY: "false",
    MAWS_ALLOW_REAL_NETWORK: "0",
    MAWS_NEXT_DIST_DIR: purpose === "e2e" ? ".next-e2e" : ".next-disposable",
    MAWS_DISPOSABLE_RUN: purpose,
    NEXT_TELEMETRY_DISABLED: "1",
  });
  // Empty strings also defend against precedence-based env loaders in children.
  for (const name of BINANCE_CREDENTIALS) env[name] = "";
  let cleaned = false;
  return {
    env,
    password: operator.password,
    directory,
    cleanup() {
      if (cleaned) return;
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      cleaned = true;
    },
  };
}

/** A single-use terminal-only sink, distinct from the silent E2E bootstrap. */
export function passwordAnnouncement(password, terminal) {
  let printed = false;
  return () => {
    if (printed) return;
    if (!terminal.isTTY) throw new Error("Throwaway requires a human terminal; password output cannot be redirected.");
    printed = true;
    terminal.write(`Throwaway operator password (shown once): ${password}\n`);
  };
}
