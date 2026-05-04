import { NextResponse } from "next/server";
import { ensureDb } from "@/lib/db";
import { getAdminFromCookies } from "@/lib/admin-auth";
import { AuditLog, Game, HandHistory, LedgerEntry } from "@ganga/db";

interface GameLean {
  gameId: string;
  hostUsername: string;
  hostEmail?: string | null;
  status: string;
  updatedAt: Date;
  createdAt: Date;
  smallBlind: number;
  bigBlind: number;
  handsPlayed?: number;
  players: {
    playerId: string;
    username: string;
    chips: number;
    email?: string | null;
    buyIn?: number;
    isHost: boolean;
    approved: boolean;
  }[];
}

export async function GET(req: Request) {
  const admin = await getAdminFromCookies();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await ensureDb();
  const url = new URL(req.url);
  const gameId = url.searchParams.get("gameId");
  const view = url.searchParams.get("view");
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  if (view === "players") {
    return await playersView(search);
  }

  if (!gameId) {
    const games = (await Game.find({})
      .sort({ updatedAt: -1 })
      .limit(150)
      .lean()) as unknown as GameLean[];
    const filtered = search
      ? games.filter(
          (g) =>
            g.gameId.toLowerCase().includes(search) ||
            g.hostUsername.toLowerCase().includes(search) ||
            (g.hostEmail ?? "").toLowerCase().includes(search) ||
            g.players.some(
              (p) =>
                p.username.toLowerCase().includes(search) ||
                (p.email ?? "").toLowerCase().includes(search),
            ),
        )
      : games;
    return NextResponse.json({
      games: filtered.map((g) => ({
        gameId: g.gameId,
        hostUsername: g.hostUsername,
        hostEmail: g.hostEmail ?? null,
        status: g.status,
        smallBlind: g.smallBlind,
        bigBlind: g.bigBlind,
        handsPlayed: g.handsPlayed ?? 0,
        playerCount: g.players.length,
        netStack: g.players.reduce((s, p) => s + (p.chips ?? 0), 0),
        totalBuyIn: g.players.reduce((s, p) => s + (p.buyIn ?? 0), 0),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })),
    });
  }

  const [logs, ledger, gameRaw, hands] = await Promise.all([
    AuditLog.find({ gameId }).sort({ createdAt: -1 }).limit(300).lean(),
    LedgerEntry.find({ gameId }).sort({ createdAt: -1 }).limit(500).lean(),
    Game.findOne({ gameId }).lean(),
    HandHistory.find({ gameId }).sort({ handIndex: -1 }).limit(80).lean(),
  ]);
  if (!gameRaw || Array.isArray(gameRaw)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const game = gameRaw as unknown as GameLean;

  /** Per-player rollup based on hand history and ledger. */
  const handsArr = hands as unknown as {
    handIndex: number;
    pot: number;
    endedByFold: boolean;
    endedAt: Date;
    board: string[];
    winners: { playerId: string; username: string; amount: number; hand?: string | null }[];
    players: {
      playerId: string;
      username: string;
      seatIndex: number;
      hole?: [string, string] | null;
      totalIn: number;
      won: number;
      net: number;
      handLabel?: string | null;
      folded: boolean;
    }[];
  }[];

  const handsPlayedByPlayer = new Map<string, number>();
  const winsByPlayer = new Map<string, number>();
  const netByPlayer = new Map<string, number>();
  for (const h of handsArr) {
    for (const p of h.players) {
      handsPlayedByPlayer.set(
        p.playerId,
        (handsPlayedByPlayer.get(p.playerId) ?? 0) + 1,
      );
      netByPlayer.set(
        p.playerId,
        (netByPlayer.get(p.playerId) ?? 0) + (p.net ?? 0),
      );
      if ((p.won ?? 0) > 0) {
        winsByPlayer.set(
          p.playerId,
          (winsByPlayer.get(p.playerId) ?? 0) + 1,
        );
      }
    }
  }

  const players = game.players.map((p) => ({
    playerId: p.playerId,
    username: p.username,
    email: p.email ?? null,
    isHost: p.isHost,
    chips: p.chips,
    buyIn: p.buyIn ?? 0,
    handsPlayed: handsPlayedByPlayer.get(p.playerId) ?? 0,
    handsWon: winsByPlayer.get(p.playerId) ?? 0,
    netChips: netByPlayer.get(p.playerId) ?? 0,
    /** Tabletop P&L = current chips - buy-in. */
    pnl: (p.chips ?? 0) - (p.buyIn ?? 0),
  }));

  return NextResponse.json({
    game: {
      gameId: game.gameId,
      hostUsername: game.hostUsername,
      hostEmail: game.hostEmail ?? null,
      status: game.status,
      smallBlind: game.smallBlind,
      bigBlind: game.bigBlind,
      handsPlayed: game.handsPlayed ?? 0,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    },
    players,
    hands: handsArr.map((h) => ({
      handIndex: h.handIndex,
      pot: h.pot,
      endedByFold: h.endedByFold,
      endedAt: h.endedAt,
      board: h.board,
      winners: h.winners,
      players: h.players,
    })),
    logs,
    ledger,
  });
}

async function playersView(search: string) {
  const games = (await Game.find({})
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean()) as unknown as GameLean[];
  /** Group by email (fallback: lowercased username when email missing). */
  type Group = {
    email: string | null;
    displayName: string;
    games: number;
    chips: number;
    buyIn: number;
    handsPlayed: number;
    knownAs: Set<string>;
  };
  const groups = new Map<string, Group>();
  for (const g of games) {
    for (const p of g.players) {
      const emailKey = (p.email ?? "").trim().toLowerCase();
      const fallback = `name:${(p.username ?? "").toLowerCase()}`;
      const key = emailKey || fallback;
      if (!groups.has(key)) {
        groups.set(key, {
          email: emailKey || null,
          displayName: p.username,
          games: 0,
          chips: 0,
          buyIn: 0,
          handsPlayed: 0,
          knownAs: new Set([p.username]),
        });
      }
      const grp = groups.get(key)!;
      grp.games += 1;
      grp.chips += p.chips ?? 0;
      grp.buyIn += p.buyIn ?? 0;
      grp.handsPlayed += g.handsPlayed ?? 0;
      grp.knownAs.add(p.username);
    }
  }
  let list = [...groups.values()].map((g) => ({
    email: g.email,
    displayName: g.displayName,
    games: g.games,
    chips: g.chips,
    buyIn: g.buyIn,
    handsPlayed: g.handsPlayed,
    pnl: g.chips - g.buyIn,
    aliases: [...g.knownAs],
  }));
  if (search) {
    list = list.filter(
      (p) =>
        (p.email ?? "").toLowerCase().includes(search) ||
        p.displayName.toLowerCase().includes(search) ||
        p.aliases.some((a) => a.toLowerCase().includes(search)),
    );
  }
  list.sort((a, b) => b.games - a.games);
  return NextResponse.json({ players: list.slice(0, 300) });
}
