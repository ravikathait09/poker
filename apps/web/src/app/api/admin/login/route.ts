import { User } from "@ganga/db";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDb } from "@/lib/db";
import { getJwtSecret } from "@/lib/server-env";

const encoder = new TextEncoder();

const Body = z.object({
  username: z.string().min(1).max(64),
});

export async function POST(req: Request) {
  await ensureDb();
  const secret = getJwtSecret();
  if (!secret || secret.length < 16) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const json: unknown = await req.json();
  const { username } = Body.parse(json);
  const uRaw = await User.findOne({
    username: username.trim().toLowerCase(),
    role: "admin",
  }).lean();
  if (!uRaw || Array.isArray(uRaw)) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }
  const u = uRaw as unknown as { username: string };
  const token = await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.username)
    .setExpirationTime("12h")
    .sign(encoder.encode(secret));

  const res = NextResponse.json({ ok: true });
  res.cookies.set("ganga_admin", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
