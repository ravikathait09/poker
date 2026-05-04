import fs from "node:fs";
import path from "node:path";

/** Minimal `.env` parse — avoids `@next/env`/dotenv vault path that pulls `crypto` into webpack. */
function parseDotenv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r");
    }
    result[key] = val;
  }
  return result;
}

function resolveEnvDir(): string {
  let dir = path.resolve(process.cwd());
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, ".env"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), "..", "..");
}

/** Same semantics as dotenv: do not override keys already set in `process.env`. */
export function loadMonorepoEnv(): void {
  const envPath = path.join(resolveEnvDir(), ".env");
  if (!fs.existsSync(envPath)) return;
  const parsed = parseDotenv(fs.readFileSync(envPath, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadMonorepoEnv();
