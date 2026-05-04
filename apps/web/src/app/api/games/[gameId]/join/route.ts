import { randomUUID } from "node:crypto";
import { Game, type GamePlayerDoc } from "@ganga/db";
import { signSession } from "@ganga/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDb } from "@/lib/db";
import { getJwtSecret } from "@/lib/server-env";

const Body = z.object({
  username: z.string().min(1).max(32),
  email: z.string().email().max(120).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ gameId: string }> },
) {
  try {
    await ensureDb();
    const secret = getJwtSecret();
    if (!secret || secret.length < 16) {
      return NextResponse.json(
        { error: "JWT_SECRET missing or too short" },
        { status: 500 },
      );
    }
    const { gameId } = await ctx.params;
    const json: unknown = await req.json();
    const body = Body.parse(json);
    const username = body.username.trim().slice(0, 32);
    const email = body.email?.trim().toLowerCase().slice(0, 120) || null;
    const g = await Game.findOne({ gameId });
    if (!g) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const dup = g.players.some(
      (p: GamePlayerDoc) =>
        p.username.toLowerCase() === username.toLowerCase(),
    );
    if (dup) {
      return NextResponse.json({ error: "username_taken" }, { status: 409 });
    }
    const playerId = randomUUID();
    g.players.push({
      playerId,
      username,
      seatIndex: null,
      chips: 0,
      isHost: false,
      approved: false,
      email,
      buyIn: 0,
    });
    await g.save();

    const token = await signSession(secret, {
      sub: playerId,
      gameId,
      role: "pending",
    });

    return NextResponse.json({ playerId, token });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "join_failed" },
      { status: 400 },
    );
  }
}
