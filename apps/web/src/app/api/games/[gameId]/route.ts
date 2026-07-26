import { Game } from "@ganga/db";
import { NextResponse } from "next/server";
import { ensureDb } from "@/lib/db";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ gameId: string }> },
) {
  await ensureDb();
  const { gameId } = await ctx.params;
  const raw = await Game.findOne({ gameId }).lean();
  if (!raw || Array.isArray(raw)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const g = raw as unknown as {
    gameId: string;
    hostUsername: string;
    hostPlayerId: string;
    smallBlind: number;
    bigBlind: number;
    players: {
      playerId: string;
      username: string;
      seatIndex: number | null;
      chips: number;
      isHost: boolean;
      approved: boolean;
    }[];
  };
  return NextResponse.json({
    gameId: g.gameId,
    hostUsername: g.hostUsername,
    hostPlayerId: g.hostPlayerId,
    smallBlind: g.smallBlind,
    bigBlind: g.bigBlind,
    turnTimerSeconds:
      (raw as { turnTimerSeconds?: number }).turnTimerSeconds ?? 20,
    autoStartHand:
      (raw as { autoStartHand?: boolean }).autoStartHand !== false,
    gameRules: (() => {
      const r = raw as {
        antesEnabled?: boolean;
        anteAmount?: number;
        useCentsDisplay?: boolean;
        rabbitHunting?: boolean;
        runItTwice?: string;
        utgStraddleAllowed?: boolean;
        revealWithNoAction?: boolean;
        spectatorsAllowed?: boolean;
        showdownPresentationSeconds?: number;
        dealToSittingOut?: boolean;
      };
      let runItTwice: "off" | "always" | "ask" = "off";
      if (r.runItTwice === "always" || r.runItTwice === "ask") {
        runItTwice = r.runItTwice;
      }
      const pres = Math.floor(Number(r.showdownPresentationSeconds ?? 3));
      return {
        antesEnabled: r.antesEnabled === true,
        anteAmount: Math.max(0, Math.floor(Number(r.anteAmount ?? 0))),
        useCentsDisplay: r.useCentsDisplay === true,
        rabbitHunting: r.rabbitHunting === true,
        runItTwice,
        utgStraddleAllowed: r.utgStraddleAllowed === true,
        revealWithNoAction: r.revealWithNoAction !== false,
        spectatorsAllowed: r.spectatorsAllowed !== false,
        showdownPresentationSeconds: Math.max(0, Math.min(30, Number.isFinite(pres) ? pres : 3)),
        dealToSittingOut: r.dealToSittingOut === true,
      };
    })(),
    players: g.players.map((p) => ({
      playerId: p.playerId,
      username: p.username,
      seatIndex: p.seatIndex,
      chips: p.chips,
      isHost: p.isHost,
      approved: p.approved,
    })),
  });
}
