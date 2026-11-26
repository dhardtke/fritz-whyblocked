import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads a secret from systemd credentials (LoadCredential) or from the environment. */
function secret(envName: string, credentialName: string): string {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (dir) {
    const file = join(dir, credentialName);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  return (process.env[envName] ?? "").trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

export interface Config {
  fritzHost: string;
  fritzUser: string;
  fritzPassword: string;
  boxDnsV4: string;
  boxDnsV6: string;
  referenceDns: string;
  port: number;
  uiPassword: string;
  dataDir: string;
  statsIntervalMs: number;
  listsRefreshMs: number;
}

export function loadConfig(): Config {
  return {
    fritzHost: process.env.FRITZ_HOST || "fritz.box",
    fritzUser: process.env.FRITZ_USER ?? "",
    fritzPassword: secret("FRITZ_PASSWORD", "fritz-password"),
    boxDnsV4: process.env.BOX_DNS_V4 ?? "",
    boxDnsV6: process.env.BOX_DNS_V6 ?? "",
    referenceDns: process.env.REFERENCE_DNS || "1.1.1.1",
    port: num("PORT", 8053),
    uiPassword: secret("UI_PASSWORD", "ui-password"),
    dataDir: process.env.STATE_DIRECTORY || process.env.DATA_DIR || "./data",
    statsIntervalMs: num("STATS_INTERVAL", 300) * 1000,
    listsRefreshMs: num("LISTS_REFRESH_HOURS", 24) * 3600 * 1000,
  };
}
