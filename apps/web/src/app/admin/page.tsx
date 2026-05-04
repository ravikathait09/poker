"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface GameSummary {
  gameId: string;
  hostUsername: string;
  hostEmail: string | null;
  status: string;
  smallBlind: number;
  bigBlind: number;
  handsPlayed: number;
  playerCount: number;
  netStack: number;
  totalBuyIn: number;
  createdAt: string;
  updatedAt: string;
}

interface PlayerRollup {
  playerId: string;
  username: string;
  email: string | null;
  isHost: boolean;
  chips: number;
  buyIn: number;
  handsPlayed: number;
  handsWon: number;
  netChips: number;
  pnl: number;
}

interface HandRow {
  handIndex: number;
  pot: number;
  endedByFold: boolean;
  endedAt: string;
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
}

interface LedgerRow {
  type: string;
  amount: number;
  balanceAfter: number | null;
  ref: string | null;
  playerId: string | null;
  createdAt: string;
  meta?: Record<string, unknown>;
}

interface AuditRow {
  event: string;
  actor: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface GameDetail {
  game: {
    gameId: string;
    hostUsername: string;
    hostEmail: string | null;
    status: string;
    smallBlind: number;
    bigBlind: number;
    handsPlayed: number;
    createdAt: string;
    updatedAt: string;
  };
  players: PlayerRollup[];
  hands: HandRow[];
  logs: AuditRow[];
  ledger: LedgerRow[];
}

interface GlobalPlayerRollup {
  email: string | null;
  displayName: string;
  games: number;
  chips: number;
  buyIn: number;
  handsPlayed: number;
  pnl: number;
  aliases: string[];
}

type Tab = "games" | "players";
type DetailTab = "summary" | "hands" | "ledger" | "audit";

function fmt(n: number): string {
  return Number(n).toLocaleString();
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function PnlCell({ pnl }: { pnl: number }) {
  if (pnl === 0) return <span className="text-slate-400">0</span>;
  return pnl > 0 ? (
    <span className="text-emerald-400">+{fmt(pnl)}</span>
  ) : (
    <span className="text-rose-400">{fmt(pnl)}</span>
  );
}

function CardChip({ code }: { code: string }) {
  const r = (code[0] ?? "?").toUpperCase();
  const s = (code[1] ?? "").toLowerCase();
  const rank = r === "T" ? "10" : r;
  const suit =
    s === "h" ? "♥" : s === "d" ? "♦" : s === "c" ? "♣" : s === "s" ? "♠" : "";
  const red = s === "h" || s === "d";
  return (
    <span
      className={`mr-0.5 inline-flex h-6 min-w-[1.6rem] items-center justify-center rounded border border-slate-300 bg-white px-1 font-mono text-[10px] font-bold ${
        red ? "text-red-600" : "text-slate-900"
      }`}
    >
      {rank}
      {suit}
    </span>
  );
}

export default function AdminPage() {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("games");
  const [search, setSearch] = useState("");
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [players, setPlayers] = useState<GlobalPlayerRollup[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [loadingGames, setLoadingGames] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadGames = useCallback(async (q?: string) => {
    setLoadingGames(true);
    try {
      const url = new URL("/api/admin/data", window.location.origin);
      if (q) url.searchParams.set("q", q);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (res.status === 401) {
        setAuthed(false);
        setGames(null);
        return;
      }
      if (!res.ok) {
        setGames(null);
        return;
      }
      setAuthed(true);
      const data = (await res.json()) as { games: GameSummary[] };
      setGames(data.games);
    } finally {
      setLoadingGames(false);
    }
  }, []);

  const loadPlayers = useCallback(async (q?: string) => {
    setLoadingPlayers(true);
    try {
      const url = new URL("/api/admin/data", window.location.origin);
      url.searchParams.set("view", "players");
      if (q) url.searchParams.set("q", q);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) {
        setPlayers(null);
        return;
      }
      const data = (await res.json()) as { players: GlobalPlayerRollup[] };
      setPlayers(data.players);
    } finally {
      setLoadingPlayers(false);
    }
  }, []);

  useEffect(() => {
    void loadGames();
  }, [loadGames]);

  useEffect(() => {
    if (tab === "players" && authed && players === null) {
      void loadPlayers();
    }
  }, [tab, authed, players, loadPlayers]);

  /** Debounce search to current tab. */
  useEffect(() => {
    if (!authed) return;
    const id = window.setTimeout(() => {
      if (tab === "games") void loadGames(search);
      else void loadPlayers(search);
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, tab]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      credentials: "include",
    });
    if (!res.ok) {
      setError("Login failed");
      return;
    }
    setAuthed(true);
    await loadGames();
  }

  async function openDetail(gid: string) {
    setSelected(gid);
    setDetailTab("summary");
    setLoadingDetail(true);
    setDetail(null);
    try {
      const res = await fetch(
        `/api/admin/data?gameId=${encodeURIComponent(gid)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      setDetail((await res.json()) as GameDetail);
    } finally {
      setLoadingDetail(false);
    }
  }

  function observe(gid: string) {
    window.open(`/game/${gid}?observe=1`, "_blank", "noopener,noreferrer");
  }

  async function logout() {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "include",
    });
    setAuthed(false);
    setGames(null);
    setPlayers(null);
    setDetail(null);
    setSelected(null);
  }

  const totals = useMemo(() => {
    if (!games)
      return { count: 0, hands: 0, players: 0, lobbies: 0, playing: 0 };
    return games.reduce(
      (acc, g) => {
        acc.count += 1;
        acc.hands += g.handsPlayed;
        acc.players += g.playerCount;
        if (g.status === "playing") acc.playing += 1;
        if (g.status === "lobby") acc.lobbies += 1;
        return acc;
      },
      { count: 0, hands: 0, players: 0, lobbies: 0, playing: 0 },
    );
  }, [games]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Admin console</h1>
          <p className="text-sm text-slate-500">
            Browse games, hand histories, ledgers, audit logs, and players by
            email.
          </p>
        </div>
        {authed ? (
          <button
            type="button"
            className="text-sm text-slate-400 underline"
            onClick={() => void logout()}
          >
            Log out
          </button>
        ) : null}
      </div>

      {!authed ? (
        <form
          onSubmit={(e) => void login(e)}
          className="max-w-sm space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-6"
        >
          <p className="text-sm text-slate-400">
            Use a username configured in{" "}
            <code className="text-emerald-300">ADMIN_USERNAMES</code>.
          </p>
          <input
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin username"
          />
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button
            type="submit"
            className="w-full rounded-lg bg-emerald-600 py-2 font-medium text-slate-950"
          >
            Sign in
          </button>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Games" value={fmt(totals.count)} />
            <StatCard label="Hands recorded" value={fmt(totals.hands)} />
            <StatCard label="Players (sum)" value={fmt(totals.players)} />
            <StatCard
              label="Lobbies"
              value={fmt(totals.lobbies)}
              tone="muted"
            />
            <StatCard
              label="Playing"
              value={fmt(totals.playing)}
              tone="positive"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-700 p-0.5">
              <button
                type="button"
                className={`rounded-md px-4 py-1.5 text-xs font-semibold uppercase tracking-wide ${
                  tab === "games"
                    ? "bg-emerald-700/40 text-white"
                    : "text-slate-400 hover:bg-slate-800"
                }`}
                onClick={() => setTab("games")}
              >
                Games
              </button>
              <button
                type="button"
                className={`rounded-md px-4 py-1.5 text-xs font-semibold uppercase tracking-wide ${
                  tab === "players"
                    ? "bg-emerald-700/40 text-white"
                    : "text-slate-400 hover:bg-slate-800"
                }`}
                onClick={() => setTab("players")}
              >
                Players
              </button>
            </div>
            <input
              type="search"
              placeholder={
                tab === "games"
                  ? "Search by game id, host or player username/email"
                  : "Search by email or username"
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-[280px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white"
            />
            <button
              type="button"
              onClick={() => {
                if (tab === "games") void loadGames(search);
                else void loadPlayers(search);
              }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              Refresh
            </button>
          </div>

          {tab === "games" ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
              <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
                <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                  <h2 className="text-sm font-medium text-slate-200">
                    Games {games ? `(${games.length})` : ""}
                  </h2>
                  {loadingGames ? (
                    <span className="text-[10px] uppercase text-slate-500">
                      loading…
                    </span>
                  ) : null}
                </header>
                <ul className="max-h-[68vh] divide-y divide-slate-800/60 overflow-y-auto">
                  {games?.length === 0 ? (
                    <li className="px-4 py-3 text-sm text-slate-500">
                      No games match.
                    </li>
                  ) : null}
                  {games?.map((g) => (
                    <li
                      key={g.gameId}
                      className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs hover:bg-slate-900 ${
                        selected === g.gameId ? "bg-slate-800/60" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void openDetail(g.gameId)}
                      >
                        <div className="font-mono text-[10px] text-slate-500">
                          {g.gameId}
                        </div>
                        <div className="mt-0.5 text-sm text-slate-200">
                          <strong>{g.hostUsername}</strong>
                          {g.hostEmail ? (
                            <span className="ml-1 text-[11px] text-slate-500">
                              ({g.hostEmail})
                            </span>
                          ) : null}
                          <span
                            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              g.status === "playing"
                                ? "bg-emerald-900/50 text-emerald-200"
                                : g.status === "lobby"
                                  ? "bg-slate-800 text-slate-300"
                                  : "bg-slate-800 text-slate-400"
                            }`}
                          >
                            {g.status}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {g.smallBlind}/{g.bigBlind} · {g.playerCount}{" "}
                          players · {g.handsPlayed} hands · {fmtTime(
                            g.updatedAt,
                          )}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="rounded border border-emerald-700 px-2 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-900/30"
                        onClick={() => observe(g.gameId)}
                      >
                        Observe
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
                  <h2 className="text-sm font-medium text-slate-200">
                    {detail ? (
                      <>
                        Detail · {detail.game.hostUsername}
                        <span className="ml-2 font-mono text-[11px] text-slate-500">
                          {detail.game.gameId.slice(0, 8)}…
                        </span>
                      </>
                    ) : (
                      "Detail"
                    )}
                  </h2>
                  {detail ? (
                    <div className="flex items-center gap-1">
                      {(
                        [
                          ["summary", "Summary"],
                          ["hands", `Hands (${detail.hands.length})`],
                          ["ledger", `Ledger (${detail.ledger.length})`],
                          ["audit", `Audit (${detail.logs.length})`],
                        ] as [DetailTab, string][]
                      ).map(([id, lab]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setDetailTab(id)}
                          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                            detailTab === id
                              ? "bg-emerald-700/30 text-emerald-100"
                              : "text-slate-400 hover:bg-slate-800"
                          }`}
                        >
                          {lab}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </header>
                <div className="px-4 py-4">
                  {!selected ? (
                    <p className="text-sm text-slate-500">
                      Select a game on the left.
                    </p>
                  ) : loadingDetail || !detail ? (
                    <p className="text-sm text-slate-500">Loading…</p>
                  ) : detailTab === "summary" ? (
                    <SummaryView detail={detail} />
                  ) : detailTab === "hands" ? (
                    <HandsView hands={detail.hands} />
                  ) : detailTab === "ledger" ? (
                    <LedgerView ledger={detail.ledger} players={detail.players} />
                  ) : (
                    <AuditView logs={detail.logs} />
                  )}
                </div>
              </section>
            </div>
          ) : (
            <PlayersTab players={players} loading={loadingPlayers} />
          )}
        </div>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "muted";
}) {
  const color =
    tone === "positive"
      ? "text-emerald-300"
      : tone === "muted"
        ? "text-slate-300"
        : "text-white";
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </div>
    </div>
  );
}

function SummaryView({ detail }: { detail: GameDetail }) {
  const g = detail.game;
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Hands played" value={fmt(g.handsPlayed)} />
        <StatCard label="Stakes" value={`${g.smallBlind} / ${g.bigBlind}`} />
        <StatCard label="Status" value={g.status} />
        <StatCard label="Created" value={fmtTime(g.createdAt)} />
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Players
        </h3>
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-xs">
            <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <Th>Player</Th>
                <Th>Email</Th>
                <Th right>Buy-in</Th>
                <Th right>Stack</Th>
                <Th right>P&amp;L</Th>
                <Th right>Hands</Th>
                <Th right>Wins</Th>
                <Th right>Net (hands)</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {detail.players.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-3 text-slate-500">
                    No players yet.
                  </td>
                </tr>
              ) : null}
              {detail.players.map((p) => (
                <tr key={p.playerId} className="hover:bg-slate-900/50">
                  <Td>
                    <strong className="text-white">{p.username}</strong>
                    {p.isHost ? (
                      <span className="ml-1 text-[10px] text-amber-300">
                        host
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {p.email ?? (
                      <span className="text-slate-600">—</span>
                    )}
                  </Td>
                  <Td right>{fmt(p.buyIn)}</Td>
                  <Td right>{fmt(p.chips)}</Td>
                  <Td right>
                    <PnlCell pnl={p.pnl} />
                  </Td>
                  <Td right>{fmt(p.handsPlayed)}</Td>
                  <Td right>{fmt(p.handsWon)}</Td>
                  <Td right>
                    <PnlCell pnl={p.netChips} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function HandsView({ hands }: { hands: HandRow[] }) {
  if (hands.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No hands have been played yet in this game.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {hands.map((h) => (
        <div
          key={h.handIndex}
          className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <div className="flex items-center gap-3">
              <strong className="text-white">Hand #{h.handIndex}</strong>
              <span>{fmtTime(h.endedAt)}</span>
              <span>
                Pot{" "}
                <span className="text-slate-200 tabular-nums">
                  {fmt(h.pot)}
                </span>
              </span>
              {h.endedByFold ? (
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
                  Won by fold
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-slate-500">Board:</span>
              {h.board.length === 0 ? (
                <span className="text-slate-600">—</span>
              ) : (
                h.board.map((c, i) => <CardChip key={`${c}-${i}`} code={c} />)
              )}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {h.winners.map((w, i) => (
              <span
                key={`${w.playerId}-${i}`}
                className="rounded-md bg-emerald-900/40 px-2 py-0.5 text-emerald-200"
              >
                {w.username} +{fmt(w.amount)}
                {w.hand ? (
                  <span className="ml-1 text-emerald-300/80">({w.hand})</span>
                ) : null}
              </span>
            ))}
          </div>

          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800">
            <table className="min-w-full divide-y divide-slate-800 text-[11px]">
              <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <Th>Seat</Th>
                  <Th>Player</Th>
                  <Th>Hole</Th>
                  <Th>Best made</Th>
                  <Th right>In</Th>
                  <Th right>Won</Th>
                  <Th right>Net</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {h.players.map((p) => (
                  <tr
                    key={`${h.handIndex}-${p.playerId}`}
                    className={p.folded ? "opacity-60" : ""}
                  >
                    <Td>{p.seatIndex}</Td>
                    <Td>{p.username}</Td>
                    <Td>
                      {p.hole ? (
                        <>
                          <CardChip code={p.hole[0]} />
                          <CardChip code={p.hole[1]} />
                        </>
                      ) : p.folded ? (
                        <span className="text-slate-600">folded</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </Td>
                    <Td>
                      {p.handLabel ?? (
                        <span className="text-slate-600">—</span>
                      )}
                    </Td>
                    <Td right>{fmt(p.totalIn)}</Td>
                    <Td right>{fmt(p.won)}</Td>
                    <Td right>
                      <PnlCell pnl={p.net} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function LedgerView({
  ledger,
  players,
}: {
  ledger: LedgerRow[];
  players: PlayerRollup[];
}) {
  const nameById = new Map(players.map((p) => [p.playerId, p.username]));
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800 text-xs">
        <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
          <tr>
            <Th>Time</Th>
            <Th>Type</Th>
            <Th>Player</Th>
            <Th right>Amount</Th>
            <Th right>Balance</Th>
            <Th>Ref</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {ledger.map((l, i) => (
            <tr key={`${l.createdAt}-${i}`} className="hover:bg-slate-900/50">
              <Td>{fmtTime(l.createdAt)}</Td>
              <Td>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    l.type === "pot_award"
                      ? "bg-emerald-900/40 text-emerald-200"
                      : l.type === "rebuy" || l.type === "buy_in"
                        ? "bg-sky-900/40 text-sky-200"
                        : "bg-slate-800 text-slate-300"
                  }`}
                >
                  {l.type}
                </span>
              </Td>
              <Td>
                {l.playerId
                  ? (nameById.get(l.playerId) ?? l.playerId.slice(0, 6))
                  : "—"}
              </Td>
              <Td right>
                <span
                  className={
                    l.amount > 0 ? "text-emerald-300" : "text-rose-300"
                  }
                >
                  {l.amount > 0 ? "+" : ""}
                  {fmt(l.amount)}
                </span>
              </Td>
              <Td right>{l.balanceAfter == null ? "—" : fmt(l.balanceAfter)}</Td>
              <Td>{l.ref ?? "—"}</Td>
            </tr>
          ))}
          {ledger.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-3 text-slate-500">
                No ledger entries.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function AuditView({ logs }: { logs: AuditRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800 text-xs">
        <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
          <tr>
            <Th>Time</Th>
            <Th>Event</Th>
            <Th>Actor</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {logs.map((l, i) => (
            <tr key={`${l.createdAt}-${i}`}>
              <Td>{fmtTime(l.createdAt)}</Td>
              <Td>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                  {l.event}
                </span>
              </Td>
              <Td>{l.actor ?? "—"}</Td>
              <Td>
                <code className="text-[10px] text-slate-400">
                  {Object.keys(l.detail ?? {}).length
                    ? JSON.stringify(l.detail)
                    : ""}
                </code>
              </Td>
            </tr>
          ))}
          {logs.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-3 text-slate-500">
                No audit entries yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function PlayersTab({
  players,
  loading,
}: {
  players: GlobalPlayerRollup[] | null;
  loading: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-medium text-slate-200">
          Players across games {players ? `(${players.length})` : ""}
        </h2>
        {loading ? (
          <span className="text-[10px] uppercase text-slate-500">
            loading…
          </span>
        ) : null}
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <Th>Email</Th>
              <Th>Display name / aliases</Th>
              <Th right>Games</Th>
              <Th right>Hands</Th>
              <Th right>Total buy-in</Th>
              <Th right>Total stack</Th>
              <Th right>P&amp;L</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {(players ?? []).map((p, i) => (
              <tr key={`${p.email ?? "anon"}-${i}`}>
                <Td>
                  {p.email ?? (
                    <span className="text-slate-600">no email captured</span>
                  )}
                </Td>
                <Td>
                  <span className="text-white">{p.displayName}</span>
                  {p.aliases.length > 1 ? (
                    <span className="ml-1 text-[10px] text-slate-500">
                      aka {p.aliases.filter((a) => a !== p.displayName).join(", ")}
                    </span>
                  ) : null}
                </Td>
                <Td right>{fmt(p.games)}</Td>
                <Td right>{fmt(p.handsPlayed)}</Td>
                <Td right>{fmt(p.buyIn)}</Td>
                <Td right>{fmt(p.chips)}</Td>
                <Td right>
                  <PnlCell pnl={p.pnl} />
                </Td>
              </tr>
            ))}
            {!players?.length ? (
              <tr>
                <td colSpan={7} className="px-3 py-3 text-slate-500">
                  No player records yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: boolean;
}) {
  return (
    <th
      className={`px-3 py-2 text-${right ? "right" : "left"} font-semibold`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 text-${right ? "right" : "left"} ${
        right ? "tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}
