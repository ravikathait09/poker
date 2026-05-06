"use client";

const MAX_SEATS = 9;

export interface TablePlayer {
  playerId: string;
  username: string;
  seatIndex: number | null;
  chips: number;
  isHost: boolean;
  approved: boolean;
  connected: boolean;
  pendingRequest: boolean;
  inHand: boolean;
  isBot?: boolean;
  holeCards?: [string, string];
  madeHandLabel?: string;
  sittingOut?: boolean;
}

export interface TableHand {
  street?: string;
  board?: string[];
  pot?: number;
  toActPlayerId?: string | null;
  handComplete?: boolean;
  buttonSeat?: number;
  sbSeat?: number;
  bbSeat?: number;
  seatBets?: { seatIndex: number; amount: number }[];
  winners?: { playerId: string; amount: number; hand?: string }[] | null;
  turnExpiresAt?: number | null;
}

function parseCardCode(code: string): {
  rank: string;
  suit: string;
  red: boolean;
} {
  const c = code.trim();
  const r = c[0]?.toUpperCase() ?? "?";
  const s = c[1]?.toLowerCase() ?? "";
  const rank = r === "T" ? "10" : r;
  const suit =
    s === "h"
      ? "♥"
      : s === "d"
        ? "♦"
        : s === "c"
          ? "♣"
          : s === "s"
            ? "♠"
            : s;
  const red = s === "h" || s === "d";
  return { rank, suit, red };
}

function PlayingCardFace({ code }: { code: string }) {
  const { rank, suit, red } = parseCardCode(code);
  return (
    <div
      className={`flex h-11 w-8 shrink-0 flex-col items-center justify-center rounded-md border border-slate-200 bg-white shadow sm:h-14 sm:w-10 ${
        red ? "text-red-600" : "text-slate-900"
      }`}
    >
      <span className="text-[10px] font-bold leading-none sm:text-xs">{rank}</span>
      <span className="text-sm leading-none sm:text-lg">{suit}</span>
    </div>
  );
}

function CardBack({ variant = "blue" }: { variant?: "blue" | "red" }) {
  const h = "h-11 w-8 sm:h-14 sm:w-10";
  const stripStyle = {
    backgroundImage: `repeating-linear-gradient(
          -45deg,
          transparent,
          transparent 2px,
          rgba(255,255,255,0.06) 2px,
          rgba(255,255,255,0.06) 3px
        )`,
  } as const;
  if (variant === "red") {
    return (
      <div
        className={`${h} shrink-0 rounded-md border border-rose-900/90 bg-gradient-to-br from-rose-800 via-red-950 to-rose-950 shadow`}
        style={stripStyle}
        aria-hidden
      />
    );
  }
  return (
    <div
      className={`${h} shrink-0 rounded-md border border-indigo-900 bg-gradient-to-br from-blue-800 via-blue-900 to-indigo-950 shadow`}
      style={stripStyle}
      aria-hidden
    />
  );
}

function SeatAvatar({ username }: { username: string }) {
  const t = username.trim();
  const letter = (
    t.replace(/^@+/, "")[0] ?? "?"
  ).toUpperCase();
  const hue =
    t.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  return (
    <div
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/25 text-xs font-bold text-white shadow-inner sm:h-8 sm:w-8 sm:text-sm"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 58% 36%), hsl(${(hue + 48) % 360} 48% 22%))`,
      }}
      aria-hidden
    >
      {letter}
    </div>
  );
}

function seatPosition(seatIndex: number): { left: string; top: string } {
  const i = seatIndex % MAX_SEATS;
  const angle = -Math.PI / 2 + (i / MAX_SEATS) * 2 * Math.PI;
  const rx = 42;
  const ry = 36;
  const x = 50 + rx * Math.cos(angle);
  const y = 50 + ry * Math.sin(angle);
  return { left: `${x}%`, top: `${y}%` };
}

export function PokerTable({
  players,
  hand,
  selfId,
  observe,
  canSit,
  smallBlind,
  bigBlind,
  hostUsername,
  onTakeSeat,
}: {
  players: TablePlayer[];
  hand: TableHand | null;
  selfId: string | null;
  observe: boolean;
  canSit: boolean;
  smallBlind: number;
  bigBlind: number;
  hostUsername: string;
  onTakeSeat: (seatIndex: number) => void;
}) {
  const bySeat = new Map<number, TablePlayer>();
  for (const p of players) {
    if (p.seatIndex !== null) bySeat.set(p.seatIndex, p);
  }

  const handLive = Boolean(hand && !hand.handComplete);
  const board = hand?.board ?? [];
  const pot = hand?.pot ?? 0;
  const seatBetMap = new Map<number, number>();
  for (const b of hand?.seatBets ?? []) {
    seatBetMap.set(b.seatIndex, b.amount);
  }

  return (
    <div className="relative mx-auto w-full max-w-5xl">
      <div
        className="relative mx-auto aspect-[1.4/1] w-full overflow-hidden rounded-[50%] shadow-2xl sm:aspect-[1.75/1]"
        style={{
          maxHeight: "min(72vh, 560px)",
          background:
            "radial-gradient(ellipse 85% 75% at 50% 45%, #157a4a 0%, #0d4d2e 42%, #073220 100%)",
          boxShadow:
            "inset 0 0 100px rgba(0,0,0,0.35), 0 20px 50px rgba(0,0,0,0.5)",
        }}
      >
        <div className="pointer-events-none absolute inset-[3%] rounded-[50%] border border-white/10" />

        <div className="absolute left-1/2 top-[48%] flex w-[92%] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 sm:w-[88%] sm:gap-3">
          <div className="text-center text-[10px] font-medium uppercase tracking-wide text-emerald-100/90 sm:text-[11px]">
            <div className="text-emerald-50/80">Ganga Poker</div>
            <div className="mt-0.5 hidden text-white/70 sm:block">
              NLH · {smallBlind} / {bigBlind} · Host {hostUsername}
            </div>
            <div className="mt-0.5 text-white/70 sm:hidden">
              {smallBlind}/{bigBlind}
            </div>
          </div>

          {handLive ? (
            <div className="flex min-h-10 flex-wrap items-center justify-center gap-1 sm:min-h-12 sm:gap-1.5">
              {board.length === 0 ? (
                <span className="rounded-full bg-black/25 px-2.5 py-0.5 text-[10px] text-emerald-100/70 sm:px-3 sm:py-1 sm:text-xs">
                  Preflop — flop next
                </span>
              ) : (
                board.map((c, idx) => (
                  <PlayingCardFace key={`${c}-${idx}`} code={c} />
                ))
              )}
            </div>
          ) : (
            <p className="rounded-full bg-black/20 px-3 py-1 text-center text-[11px] text-emerald-100/75 sm:px-4 sm:py-2 sm:text-xs">
              Waiting for next hand
            </p>
          )}

          <div className="flex flex-col items-center gap-0.5 rounded-full bg-slate-900/80 px-5 py-1.5 shadow-lg ring-1 ring-white/15 sm:px-7 sm:py-2">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 sm:text-[10px]">
              Pot
            </span>
            <span className="text-lg font-semibold tabular-nums text-white sm:text-2xl">
              {pot}
            </span>
          </div>

          {hand?.winners?.length ? (
            <ul className="max-w-xs text-center text-[10px] text-amber-200 sm:text-[11px]">
              {hand.winners.map((w) => (
                <li key={`${w.playerId}-${w.amount}`}>
                  {players.find((p) => p.playerId === w.playerId)?.username ??
                    w.playerId}{" "}
                  +{Math.round(w.amount)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {Array.from({ length: MAX_SEATS }).map((_, seatIndex) => {
          const pos = seatPosition(seatIndex);
          const p = bySeat.get(seatIndex);
          const isSelf = p && selfId && p.playerId === selfId;
          const isAct = handLive && p && hand?.toActPlayerId === p.playerId;
          const bet = seatBetMap.get(seatIndex) ?? 0;
          const isBtn = handLive && hand?.buttonSeat === seatIndex;
          const isSb = handLive && hand?.sbSeat === seatIndex;
          const isBb = handLive && hand?.bbSeat === seatIndex;

          return (
            <div
              key={seatIndex}
              className="absolute z-10 w-0 -translate-x-1/2 -translate-y-1/2"
              style={{ left: pos.left, top: pos.top }}
            >
              <div className="relative flex w-[5.25rem] -translate-x-1/2 flex-col items-center sm:w-28">
                {p && handLive && !p.inHand ? (
                  <div className="mb-1 flex w-[5.25rem] justify-center sm:w-[7.5rem]">
                    <span className="flex items-center gap-1 rounded-md border border-white/10 bg-slate-900/95 px-1.5 py-0.5 text-center text-[7px] font-semibold uppercase leading-tight tracking-wide text-slate-200 shadow sm:px-2 sm:py-1 sm:text-[8px]">
                      <span aria-hidden className="text-slate-400">
                        ↳
                      </span>
                      {p.sittingOut ? "Away" : "In next hand"}
                    </span>
                  </div>
                ) : null}
                {p && !handLive && p.sittingOut ? (
                  <div className="mb-1 flex w-[5.25rem] justify-center sm:w-[7.5rem]">
                    <span className="rounded-md border border-amber-500/30 bg-amber-950/70 px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-wide text-amber-200 shadow sm:px-2 sm:py-1 sm:text-[8px]">
                      Away
                    </span>
                  </div>
                ) : null}

                {p && handLive && p.inHand ? (
                  <div className="mb-1 flex flex-col items-center gap-0.5">
                    {isSelf && !observe && p.madeHandLabel ? (
                      <span className="max-w-[7rem] truncate rounded-md bg-violet-950/95 px-1.5 py-0.5 text-center text-[8px] font-bold uppercase tracking-wide text-violet-100 ring-1 ring-violet-400/35 sm:max-w-[10rem]">
                        {p.madeHandLabel}
                      </span>
                    ) : null}
                    <div className="relative flex h-[3.75rem] w-[5rem] items-end justify-center sm:h-[4.75rem] sm:w-[6.25rem]">
                      {!observe && p.holeCards?.length === 2 ? (
                        <>
                          <div className="absolute bottom-0 left-1/2 z-20 -translate-x-[calc(50%+11px)] origin-bottom -rotate-[17deg] sm:-translate-x-[calc(50%+14px)]">
                            <PlayingCardFace code={p.holeCards[0]!} />
                          </div>
                          <div className="absolute bottom-0 left-1/2 z-10 -translate-x-[calc(50%-11px)] origin-bottom rotate-[17deg] sm:-translate-x-[calc(50%-14px)]">
                            <PlayingCardFace code={p.holeCards[1]!} />
                          </div>
                          {!isSelf ? (
                            <span
                              className="absolute -top-1 right-0 rounded-sm bg-amber-500/90 px-1 text-[7px] font-bold uppercase tracking-wide text-slate-950 shadow sm:-top-1.5 sm:text-[8px]"
                              title="Visible to host (godmode)"
                              aria-hidden
                            >
                              ⚠
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <div className="absolute bottom-0 left-1/2 z-20 -translate-x-[calc(50%+9px)] origin-bottom -rotate-[17deg] sm:-translate-x-[calc(50%+12px)]">
                            <CardBack variant="red" />
                          </div>
                          <div className="absolute bottom-0 left-1/2 z-10 -translate-x-[calc(50%-9px)] origin-bottom rotate-[17deg] sm:-translate-x-[calc(50%-12px)]">
                            <CardBack variant="red" />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}

                {!p ? (
                  <button
                    type="button"
                    disabled={observe || !canSit}
                    onClick={() => onTakeSeat(seatIndex)}
                    className="flex w-full flex-col items-center rounded-lg border-2 border-dashed border-white/35 bg-black/25 px-1.5 py-2 text-center transition hover:border-emerald-300/60 hover:bg-black/35 disabled:cursor-not-allowed disabled:opacity-40 sm:px-2 sm:py-3"
                    title={
                      canSit
                        ? `Sit seat ${seatIndex}`
                        : "Join and get approved to sit"
                    }
                  >
                    <span className="text-[9px] font-medium uppercase tracking-wider text-emerald-100/80 sm:text-[10px]">
                      Sit
                    </span>
                    <span className="mt-0.5 font-mono text-[10px] text-white/50 sm:mt-1 sm:text-xs">
                      {seatIndex}
                    </span>
                  </button>
                ) : (
                  <div
                    className={`w-full rounded-lg border px-1.5 py-1 shadow-lg sm:px-2 sm:py-2 ${
                      isSelf
                        ? "border-amber-400/80 bg-slate-900/95"
                        : "border-white/20 bg-slate-900/90"
                    } ${isAct ? "ring-2 ring-amber-400" : ""}`}
                  >
                    {!p.connected ? (
                      <div className="mb-0.5 text-center text-[8px] font-semibold uppercase tracking-wide text-red-300 sm:mb-1 sm:text-[9px]">
                        Offline
                      </div>
                    ) : null}
                    <div className="flex items-center justify-center gap-1 sm:gap-1.5">
                      <SeatAvatar username={p.username} />
                      <div className="min-w-0 max-w-full truncate text-left text-[10px] font-semibold text-white sm:text-xs">
                      {p.username}
                      {p.isHost ? (
                        <span className="ml-0.5 text-[9px] text-amber-300 sm:ml-1 sm:text-[10px]">
                          · H
                        </span>
                      ) : null}
                      {p.isBot ? (
                        <span className="ml-0.5 text-[9px] text-cyan-300 sm:ml-1 sm:text-[10px]">
                          CPU
                        </span>
                      ) : null}
                      </div>
                    </div>
                    <div className="mt-0.5 text-center text-[10px] tabular-nums text-emerald-300 sm:text-[11px]">
                      {p.chips}
                    </div>
                  </div>
                )}

                {p && handLive && bet > 0 ? (
                  <div className="absolute -bottom-5 left-1/2 flex -translate-x-1/2 items-center justify-center sm:-bottom-6">
                    <span className="rounded-full bg-white/95 px-1.5 py-0.5 text-[9px] font-bold text-slate-900 shadow sm:px-2 sm:text-[10px]">
                      {bet}
                    </span>
                  </div>
                ) : null}

                {p && handLive && isBtn ? (
                  <div className="absolute -right-4 top-6 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-sky-600 text-[9px] font-bold text-white shadow sm:-right-6 sm:top-8 sm:h-6 sm:w-6 sm:text-[10px]">
                    D
                  </div>
                ) : null}
                {p && handLive && isSb ? (
                  <div className="absolute -left-4 top-7 rounded bg-slate-800 px-1 text-[7px] font-bold text-amber-200 sm:-left-5 sm:top-10 sm:text-[8px]">
                    SB
                  </div>
                ) : null}
                {p && handLive && isBb ? (
                  <div className="absolute -left-4 top-11 rounded bg-slate-800 px-1 text-[7px] font-bold text-amber-200 sm:-left-5 sm:top-14 sm:text-[8px]">
                    BB
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
