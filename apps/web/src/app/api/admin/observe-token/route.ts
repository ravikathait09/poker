import { signSession } from "@ganga/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminFromCookies } from "@/lib/admin-auth";
import { getJwtSecret } from "@/lib/server-env";

const Body = z.object({
  gameId: z.string(),
});

export async function POST(req: Request) {
  const admin = await getAdminFromCookies();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const secret = getJwtSecret();
  if (!secret || secret.length < 16) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const json: unknown = await req.json();
  const { gameId } = Body.parse(json);
  const token = await signSession(secret, {
    sub: admin.sub,
    gameId: null,
    role: "admin",
    observeGameId: gameId,
  });
  return NextResponse.json({ token });
}
