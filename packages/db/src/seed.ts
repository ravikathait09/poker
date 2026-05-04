import { User } from "./models.js";

/** Create admin users from ADMIN_USERNAMES env (comma-separated). Idempotent. */
export async function seedAdminUsers(): Promise<void> {
  const raw = process.env.ADMIN_USERNAMES ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const username of names) {
    await User.updateOne(
      { username: username.toLowerCase() },
      { $setOnInsert: { username: username.toLowerCase(), role: "admin" } },
      { upsert: true },
    );
  }
}
