import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import type { Role } from "@ganga/shared";
import { getJwtSecret } from "@/lib/server-env";

const encoder = new TextEncoder();

export interface AdminCookiePayload {
  sub: string;
  role: Role;
}

export async function getAdminFromCookies(): Promise<AdminCookiePayload | null> {
  const secret = getJwtSecret();
  if (!secret) return null;
  const jar = await cookies();
  const tok = jar.get("ganga_admin")?.value;
  if (!tok) return null;
  try {
    const { payload } = await jwtVerify(tok, encoder.encode(secret));
    const role = payload.role as Role;
    if (role !== "admin") return null;
    return { sub: String(payload.sub ?? ""), role };
  } catch {
    return null;
  }
}
