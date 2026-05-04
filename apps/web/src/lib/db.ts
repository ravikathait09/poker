import "@/lib/root-env";
import { connectDb, seedAdminUsers } from "@ganga/db";

const mongoKey = ["MONGODB", "URI"].join("_");
const uri =
  process.env[mongoKey] ?? "mongodb://127.0.0.1:27017/ganga-poker";

declare global {
  // eslint-disable-next-line no-var
  var _mongoInit: Promise<void> | undefined;
}

export async function ensureDb(): Promise<void> {
  if (!global._mongoInit) {
    global._mongoInit = (async () => {
      await connectDb(uri);
      await seedAdminUsers();
    })();
  }
  await global._mongoInit;
}
