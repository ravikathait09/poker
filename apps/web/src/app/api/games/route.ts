import { randomUUID } from "node:crypto";
import { Game, LedgerEntry } from "@ganga/db";
import { signSession } from "@ganga/shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDb } from "@/lib/db";
import { getJwtSecret } from "@/lib/server-env";

const Body = z.object({
  username: z.string().min(1).max(32).optional(),
  email: z.string().email().max(120).optional(),
});

export async function POST(req: Request) {
  try {
    await ensureDb();
    const secret = getJwtSecret();
    if (!secret || secret.length < 16) {
      return NextResponse.json(
        { error: "JWT_SECRET missing or too short" },
        { status: 500 },
      );
    }
    const json: unknown = await req.json();
    const body = Body.parse(json);
    const gameId = randomUUID();
    const hostPlayerId = randomUUID();
    const username = (body.username ?? "Host").trim().slice(0, 32) || "Host";
    const email = body.email?.trim().toLowerCase().slice(0, 120) || null;
    const starting = 1000;

    await Game.create({
      gameId,
      hostPlayerId,
      hostUsername: username,
      hostEmail: email,
      smallBlind: 5,
      bigBlind: 10,
      turnTimerSeconds: 20,
      autoStartHand: true,
      antesEnabled: false,
      anteAmount: 0,
      useCentsDisplay: false,
      rabbitHunting: false,
      runItTwice: "off",
      utgStraddleAllowed: false,
      revealWithNoAction: true,
      spectatorsAllowed: true,
      showdownPresentationSeconds: 3,
      dealToSittingOut: false,
      status: "lobby",
      players: [
        {
          playerId: hostPlayerId,
          username,
          seatIndex: null,
          chips: starting,
          isHost: true,
          approved: true,
          email,
          buyIn: starting,
        },
      ],
    });

    await LedgerEntry.create({
      gameId,
      playerId: hostPlayerId,
      type: "buy_in",
      amount: starting,
      balanceAfter: starting,
      ref: "initial",
      meta: { note: "host_buy_in" },
    });

    const token = await signSession(secret, {
      sub: hostPlayerId,
      gameId,
      role: "host",
    });

    return NextResponse.json({ gameId, token });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "create_failed" },
      { status: 400 },
    );
  }
}
