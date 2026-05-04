import "./root-env";

/**
 * Read JWT secret at runtime. Uses a dynamic key so bundlers (e.g. Turbopack)
 * don't replace `process.env.JWT_SECRET` with `undefined` when it wasn't set
 * at compile time.
 */
export function getJwtSecret(): string | undefined {
  const k = ["JWT", "SECRET"].join("_");
  return process.env[k];
}
