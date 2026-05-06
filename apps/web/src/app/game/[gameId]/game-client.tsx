"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PokerTable } from "./poker-table";

type Role = "host" | "player" | "pending" | "admin";

interface PublicPlayer {
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

interface HandPayload {
  street?: string;
  board?: string[];
  pot?: number;
  toActPlayerId?: string | null;
  minRaise?: number;
  currentBet?: number;
  handComplete?: boolean;
  buttonSeat?: number;
  sbSeat?: number;
  bbSeat?: number;
  seatBets?: { seatIndex: number; amount: number }[];
  winners?: { playerId: string; amount: number; hand?: string }[] | null;
  turnExpiresAt?: number | null;
  lastAction?: { playerId: string; action: string; amount?: number };
}

interface GamePayload {
  gameId: string;
  players: PublicPlayer[];
  pendingRequests: { playerId: string; username: string }[];
  hand: HandPayload | null;
  smallBlind: number;
  bigBlind: number;
  hostPlayerId: string;
  turnTimerSeconds?: number;
  /** Effective seconds for the running action clock (server uses 20 if turnTimerSeconds is 0). */
  actionClockSeconds?: number;
  autoStartHand?: boolean;
  gameRules?: GameRulesPayload;
  /**
   * Server-side env flag (GANGA_HOST_GODMODE=1): when true, the realtime
   * server is sending the host every contesting player's hole cards. Shown to
   * every connected client so non-host players know the host can see all cards.
   */
  hostSeesAll?: boolean;
}

type PreAction = "off" | "check_fold" | "check_any" | "call_any";
type ActionLogEntry = { id: string; at: number; text: string };

interface ChatLineMsg {
  type: "chat";
  playerId: string;
  username: string;
  text: string;
  at: number;
}

interface GameRulesPayload {
  antesEnabled: boolean;
  anteAmount: number;
  useCentsDisplay: boolean;
  rabbitHunting: boolean;
  runItTwice: "off" | "always" | "ask";
  utgStraddleAllowed: boolean;
  revealWithNoAction: boolean;
  spectatorsAllowed: boolean;
}

function SegmentedYesNo({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-slate-800/80 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-slate-300">{label}</span>
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-600 p-0.5">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-semibold ${
              value ? "rounded-md bg-emerald-800 text-white" : "text-slate-500"
            }`}
            onClick={() => onChange(true)}
          >
            YES
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-semibold ${
              !value ? "rounded-md bg-slate-600 text-white" : "text-slate-500"
            }`}
            onClick={() => onChange(false)}
          >
            NO
          </button>
        </div>
      </div>
      {hint ? <p className="text-xs leading-snug text-slate-500">{hint}</p> : null}
    </div>
  );
}

function normalizeRunItTwiceUi(
  v: string | undefined,
): "off" | "always" | "ask" {
  return v === "always" || v === "ask" ? v : "off";
}

function realtimePort(): string {
  return process.env.NEXT_PUBLIC_REALTIME_PORT ?? "4001";
}

/**
 * Browser WebSocket URL. Opening the app via a LAN IP (e.g. http://192.168.1.2:3000)
 * while `NEXT_PUBLIC_WS_URL` is ws://127.0.0.1 would connect to the viewer's own
 * machine — override with the page hostname in that case.
 */
function resolveRealtimeWsUrl(): string {
  if (typeof window === "undefined") {
    return (
      process.env.NEXT_PUBLIC_WS_URL ??
      `ws://127.0.0.1:${realtimePort()}`
    );
  }

  const explicit = process.env.NEXT_PUBLIC_WS_URL?.trim();
  const host = window.location.hostname;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const port = realtimePort();
  const pageIsLan = host !== "localhost" && host !== "127.0.0.1";

  if (explicit) {
    try {
      const u = new URL(explicit);
      const loopback =
        u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (!(loopback && pageIsLan)) return explicit;
    } catch {
      return explicit;
    }
  }

  /**
   * Production behind Apache/nginx: WS is proxied at same host:443 on path /ws,
   * not on a public port like 4001 (browsers cannot mix wss with :4001 tunneled
   * the same way — Apache terminates TLS and upgrades /ws → backend).
   */
  if (window.location.protocol === "https:") {
    return `wss://${host}/ws`;
  }

  return `${proto}//${host}:${port}`;
}

function ActionButton({
  label,
  sublabel,
  variant,
  disabled,
  onClick,
}: {
  label: string;
  sublabel?: string;
  variant: "fold" | "check" | "call" | "raise" | "neutral";
  disabled?: boolean;
  onClick: () => void;
}) {
  const palette: Record<string, string> = {
    fold:
      "border-rose-700/70 bg-gradient-to-b from-rose-700 to-rose-800 hover:from-rose-600 text-white",
    check:
      "border-slate-500/70 bg-gradient-to-b from-slate-700 to-slate-800 hover:from-slate-600 text-white",
    call:
      "border-emerald-600/70 bg-gradient-to-b from-emerald-600 to-emerald-800 hover:from-emerald-500 text-white",
    raise:
      "border-amber-500/70 bg-gradient-to-b from-amber-500 to-amber-700 hover:from-amber-400 text-slate-950",
    neutral:
      "border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-[48px] min-w-[5rem] flex-none basis-auto flex-col items-center justify-center rounded-xl border px-2.5 py-2 text-sm font-bold uppercase tracking-wide shadow-md transition disabled:cursor-not-allowed disabled:opacity-40 disabled:saturate-50 sm:min-h-0 sm:min-w-[88px] sm:flex-none sm:basis-auto sm:px-4 sm:py-2 sm:text-sm ${palette[variant]}`}
    >
      <span>{label}</span>
      {sublabel ? (
        <span className="mt-0.5 max-w-[5.5rem] truncate text-[10px] font-semibold tabular-nums opacity-90 sm:max-w-none sm:text-[11px]">
          {sublabel}
        </span>
      ) : null}
    </button>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function playTurnPing(): void {
  try {
    type WebkitAudioWindow = Window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const w = window as WebkitAudioWindow;
    const Ctx = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      ctx.currentTime + 0.35,
    );
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch {
    /* audio is best-effort */
  }
}

async function copyPageUrlToClipboard(): Promise<void> {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    return;
  } catch {
    /* clipboard API requires secure context; http://192.168.x.x often fails */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    window.prompt("Copy this link:", url);
  }
}

export function GameClient({
  gameId,
  observe,
}: {
  gameId: string;
  observe?: boolean;
}) {
  const [status, setStatus] = useState<string>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<GamePayload | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [role, setRole] = useState<Role | "observer" | null>(null);
  const [joinName, setJoinName] = useState("");
  const [joinEmail, setJoinEmail] = useState("");
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [wsEndpoint, setWsEndpoint] = useState<string | null>(null);
  const [chatLines, setChatLines] = useState<
    Omit<ChatLineMsg, "type">[]
  >([]);
  const [chatDraft, setChatDraft] = useState("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const sockRef = useRef<WebSocket | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSb, setDraftSb] = useState("5");
  const [draftBb, setDraftBb] = useState("10");
  const [draftTimer, setDraftTimer] = useState("20");
  const [draftAutoStart, setDraftAutoStart] = useState(true);
  const [settingsTab, setSettingsTab] = useState<"game" | "preferences">(
    "game",
  );
  const [draftAntesEnabled, setDraftAntesEnabled] = useState(false);
  const [draftAnteAmount, setDraftAnteAmount] = useState("0");
  const [draftUseCents, setDraftUseCents] = useState(false);
  const [draftRabbit, setDraftRabbit] = useState(false);
  const [draftRunItTwice, setDraftRunItTwice] = useState<
    "off" | "always" | "ask"
  >("off");
  const [draftStraddle, setDraftStraddle] = useState(false);
  const [draftReveal, setDraftReveal] = useState(true);
  const [draftSpectators, setDraftSpectators] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const [confirmFold, setConfirmFold] = useState(false);
  const [preAction, setPreAction] = useState<PreAction>("off");
  const [pendingFoldConfirm, setPendingFoldConfirm] = useState(false);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [raiseSlider, setRaiseSlider] = useState<number>(0);
  const [topUpDrafts, setTopUpDrafts] = useState<Record<string, string>>({});
  const [topUpHint, setTopUpHint] = useState<string | null>(null);
  const lastTurnRef = useRef<string | null>(null);
  const preActionRef = useRef<PreAction>("off");
  const sentForRef = useRef<string | null>(null);
  const lastActionKeyRef = useRef<string | null>(null);
  const lastBoardLenRef = useRef<number>(0);
  const lastWinnersKeyRef = useRef<string | null>(null);

  useEffect(() => {
    preActionRef.current = preAction;
  }, [preAction]);

  useEffect(() => {
    setWsEndpoint(resolveRealtimeWsUrl());
    try {
      const s = window.localStorage.getItem("ganga_pref_sound");
      if (s !== null) setSoundOn(s === "1");
      const cf = window.localStorage.getItem("ganga_pref_confirm_fold");
      if (cf !== null) setConfirmFold(cf === "1");
    } catch {
      /* localStorage may be blocked */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("ganga_pref_sound", soundOn ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [soundOn]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "ganga_pref_confirm_fold",
        confirmFold ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [confirmFold]);

  useEffect(() => {
    if (!payload || !settingsOpen) return;
    const gr = payload.gameRules;
    setDraftSb(String(payload.smallBlind));
    setDraftBb(String(payload.bigBlind));
    setDraftTimer(String(payload.turnTimerSeconds ?? 20));
    setDraftAutoStart(payload.autoStartHand !== false);
    setDraftAntesEnabled(gr?.antesEnabled === true);
    setDraftAnteAmount(String(gr?.anteAmount ?? 0));
    setDraftUseCents(gr?.useCentsDisplay === true);
    setDraftRabbit(gr?.rabbitHunting === true);
    setDraftRunItTwice(normalizeRunItTwiceUi(gr?.runItTwice));
    setDraftStraddle(gr?.utgStraddleAllowed === true);
    setDraftReveal(gr?.revealWithNoAction !== false);
    setDraftSpectators(gr?.spectatorsAllowed !== false);
  }, [payload, settingsOpen]);

  useEffect(() => {
    const h = payload?.hand as {
      handComplete?: boolean;
      turnExpiresAt?: number;
    } | null;
    if (!h || h.handComplete || typeof h.turnExpiresAt !== "number") return;
    const id = window.setInterval(() => setClockTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [payload?.hand]);

  const send = useCallback((msg: object) => {
    const s = sockRef.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
  }, []);

  const connectWithToken = useCallback(
    async (token: string) => {
      setError(null);
      setStatus("connecting");
      const ws = new WebSocket(resolveRealtimeWsUrl());
      sockRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", token }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            payload?: GamePayload;
            playerId?: string;
            role?: string;
            gameId?: string;
            message?: string;
            username?: string;
            text?: string;
            at?: number;
          };
          if (msg.type === "welcome") {
            setSelfId(msg.playerId ?? null);
            setRole((msg.role as Role | "observer") ?? null);
            setStatus("live");
          }
          if (msg.type === "game_state" && msg.payload) {
            setPayload(msg.payload as GamePayload);
          }
          if (
            msg.type === "chat" &&
            msg.playerId &&
            msg.username != null &&
            msg.text != null &&
            typeof msg.at === "number"
          ) {
            setChatLines((prev) =>
              [
                ...prev,
                {
                  playerId: msg.playerId!,
                  username: msg.username!,
                  text: msg.text!,
                  at: msg.at!,
                },
              ].slice(-120),
            );
          }
          if (msg.type === "error") {
            setError(msg.message ?? "error");
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => setStatus("disconnected");
      ws.onerror = () => setError("socket error");
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (observe) {
        const res = await fetch("/api/admin/observe-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId }),
          credentials: "include",
        });
        if (!res.ok) {
          setError("Admin session required to observe");
          setStatus("idle");
          return;
        }
        const { token } = (await res.json()) as { token: string };
        if (!cancelled) await connectWithToken(token);
        return;
      }
      const hostTok = sessionStorage.getItem(`ganga_host_${gameId}`);
      const guestTok = sessionStorage.getItem(`ganga_guest_${gameId}`);
      if (hostTok) {
        await connectWithToken(hostTok);
        return;
      }
      if (guestTok) {
        await connectWithToken(guestTok);
        return;
      }
      setStatus("need_join");
    })();
    return () => {
      cancelled = true;
      sockRef.current?.close();
      setChatLines([]);
    };
  }, [gameId, observe, connectWithToken]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLines]);

  async function submitJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedEmail = joinEmail.trim();
    const body: { username: string; email?: string } = {
      username: joinName.trim(),
    };
    if (trimmedEmail) body.email = trimmedEmail;
    const res = await fetch(`/api/games/${gameId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { token?: string; error?: string };
    if (!res.ok) {
      setError(data.error ?? "join failed");
      return;
    }
    if (data.token) {
      sessionStorage.setItem(`ganga_guest_${gameId}`, data.token);
      await connectWithToken(data.token);
    }
  }

  const self = useMemo(
    () => payload?.players.find((p) => p.playerId === selfId),
    [payload, selfId],
  );

  const hand: HandPayload | null = payload?.hand ?? null;

  const actionClockSec = useMemo(() => {
    if (
      !hand ||
      hand.handComplete ||
      !hand.toActPlayerId ||
      typeof hand.turnExpiresAt !== "number"
    ) {
      return null;
    }
    return Math.max(0, Math.ceil((hand.turnExpiresAt - Date.now()) / 1000));
  }, [hand, clockTick]);

  const isHost = role === "host" && self?.isHost;
  const devBotsEnabled =
    process.env.NEXT_PUBLIC_GANGA_DEV_BOTS === "1";
  const canAct = Boolean(
    hand &&
      !hand.handComplete &&
      hand.toActPlayerId &&
      hand.toActPlayerId === selfId,
  );

  const handInProgress = Boolean(hand && !hand.handComplete);
  const hostUsername =
    payload?.players.find((p) => p.isHost)?.username ?? "Host";

  const myBet = useMemo(() => {
    if (!hand || self?.seatIndex == null) return 0;
    const sb = (hand.seatBets ?? []).find(
      (b) => b.seatIndex === self.seatIndex,
    );
    return sb?.amount ?? 0;
  }, [hand, self?.seatIndex]);
  const toCall = Math.max(0, (hand?.currentBet ?? 0) - myBet);
  const myChips = self?.chips ?? 0;
  const callAmount = Math.min(toCall, myChips);
  const allInTotal = myBet + myChips;
  const minRaiseTotal = Math.max(
    (hand?.currentBet ?? 0) + (hand?.minRaise ?? payload?.bigBlind ?? 0),
    payload?.bigBlind ?? 1,
  );
  const canRaise = myChips > 0 && allInTotal > (hand?.currentBet ?? 0);
  const effectiveMinRaise = Math.min(minRaiseTotal, allInTotal);
  const potNow = hand?.pot ?? 0;

  function chipsForFraction(frac: number): number {
    const target = Math.round(myBet + toCall + frac * (potNow + toCall));
    return clamp(target, effectiveMinRaise, allInTotal);
  }

  useEffect(() => {
    if (!canAct) return;
    setRaiseSlider((cur) => {
      if (cur >= effectiveMinRaise && cur <= allInTotal) return cur;
      return effectiveMinRaise;
    });
  }, [canAct, effectiveMinRaise, allInTotal]);

  useEffect(() => {
    if (!hand) {
      lastBoardLenRef.current = 0;
      return;
    }
    const bn = (hand.board ?? []).length;
    if (bn !== lastBoardLenRef.current) {
      lastBoardLenRef.current = bn;
      const street =
        bn === 3 ? "Flop" : bn === 4 ? "Turn" : bn === 5 ? "River" : null;
      if (street) {
        setActionLog((l) =>
          [
            ...l,
            {
              id: `street-${Date.now()}`,
              at: Date.now(),
              text: `— ${street}: ${(hand.board ?? []).join(" ")}`,
            },
          ].slice(-200),
        );
      }
    }
  }, [hand]);

  useEffect(() => {
    if (!hand?.lastAction) return;
    const la = hand.lastAction;
    const key = `${la.playerId}-${la.action}-${la.amount ?? 0}-${(hand.board ?? []).length}-${hand.pot ?? 0}`;
    if (lastActionKeyRef.current === key) return;
    lastActionKeyRef.current = key;
    const name =
      payload?.players.find((p) => p.playerId === la.playerId)?.username ??
      la.playerId.slice(0, 6);
    let txt = `${name} ${la.action}`;
    if (la.action === "raise") txt += ` to ${la.amount}`;
    else if (la.action === "call") txt += ` ${la.amount ?? 0}`;
    setActionLog((l) =>
      [
        ...l,
        { id: `act-${Date.now()}-${Math.random()}`, at: Date.now(), text: txt },
      ].slice(-200),
    );
  }, [hand?.lastAction, hand?.pot, hand?.board, payload?.players]);

  useEffect(() => {
    if (!hand?.handComplete || !hand.winners?.length) return;
    const key = `${(hand.board ?? []).join(",")}-${hand.winners
      .map((w) => `${w.playerId}:${w.amount}`)
      .join(",")}`;
    if (lastWinnersKeyRef.current === key) return;
    lastWinnersKeyRef.current = key;
    for (const w of hand.winners) {
      const name =
        payload?.players.find((p) => p.playerId === w.playerId)?.username ??
        w.playerId.slice(0, 6);
      const handLab = w.hand ? ` (${w.hand})` : "";
      setActionLog((l) =>
        [
          ...l,
          {
            id: `win-${Date.now()}-${Math.random()}`,
            at: Date.now(),
            text: `${name} wins ${Math.round(w.amount)}${handLab}`,
          },
        ].slice(-200),
      );
    }
  }, [hand?.handComplete, hand?.winners, hand?.board, payload?.players]);

  useEffect(() => {
    if (!handInProgress) {
      setPreAction("off");
      preActionRef.current = "off";
    }
  }, [handInProgress]);

  useEffect(() => {
    if (!canAct) {
      lastTurnRef.current = null;
      sentForRef.current = null;
      return;
    }
    const turnKey = `${(hand?.board ?? []).length}-${hand?.toActPlayerId}-${hand?.pot ?? 0}-${hand?.currentBet ?? 0}`;
    if (lastTurnRef.current === turnKey) return;
    lastTurnRef.current = turnKey;
    if (soundOn) playTurnPing();

    const pa = preActionRef.current;
    if (pa !== "off" && sentForRef.current !== turnKey) {
      sentForRef.current = turnKey;
      const tc = Math.max(0, (hand?.currentBet ?? 0) - myBet);
      if (pa === "check_fold") {
        send({ type: "poker_action", action: tc === 0 ? "check" : "fold" });
        setPreAction("off");
      } else if (pa === "check_any" && tc === 0) {
        send({ type: "poker_action", action: "check" });
        setPreAction("off");
      } else if (pa === "call_any") {
        send({ type: "poker_action", action: tc === 0 ? "check" : "call" });
        setPreAction("off");
      }
    }
  }, [
    canAct,
    soundOn,
    hand?.toActPlayerId,
    hand?.board,
    hand?.pot,
    hand?.currentBet,
    myBet,
    send,
  ]);

  function doFold() {
    if (confirmFold && !pendingFoldConfirm) {
      setPendingFoldConfirm(true);
      window.setTimeout(() => setPendingFoldConfirm(false), 2200);
      return;
    }
    setPendingFoldConfirm(false);
    send({ type: "poker_action", action: "fold" });
  }
  function doCheckOrCall() {
    send({ type: "poker_action", action: toCall === 0 ? "check" : "call" });
  }
  function doRaiseTo(total: number) {
    const t = clamp(Math.floor(total), effectiveMinRaise, allInTotal);
    send({ type: "poker_action", action: "raise", raiseTo: t });
  }
  function doAllIn() {
    if (allInTotal <= (hand?.currentBet ?? 0)) {
      doCheckOrCall();
      return;
    }
    doRaiseTo(allInTotal);
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 px-3 pb-[min(42svh,15.5rem)] pt-3 sm:gap-6 sm:px-4 sm:pb-44 sm:pt-8">
      <header className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-widest text-emerald-400/90 sm:text-xs">
            {observe ? "Observer" : "Table"}
          </p>
          <h1 className="text-base font-semibold text-white sm:text-2xl">
            Game <span className="text-slate-400">{gameId.slice(0, 8)}…</span>
          </h1>
          <p className="hidden text-sm text-slate-500 sm:block">
            Socket: {status}
            {wsEndpoint ? (
              <span className="text-slate-600"> ({wsEndpoint})</span>
            ) : null}
            {error ? ` · ${error}` : ""}
          </p>
          <p className="text-[11px] text-slate-500 sm:hidden">
            {status}
            {error ? ` · ${error}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:gap-2">
          {isHost && !observe ? (
            <button
              type="button"
              className="flex min-h-11 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-lg border border-slate-600 px-3 py-2.5 text-sm font-semibold leading-none text-slate-100 sm:min-h-0 sm:min-w-0 sm:px-3 sm:py-2 sm:text-sm sm:font-normal"
              onClick={() => setSettingsOpen(true)}
              title="Game settings"
            >
              <span className="text-lg leading-none sm:hidden" aria-hidden>
                ⚙︎
              </span>
              <span className="sm:hidden">Settings</span>
              <span className="hidden sm:inline">Game settings</span>
            </button>
          ) : null}
          <button
            type="button"
            className="flex min-h-11 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2.5 text-sm font-semibold leading-none text-slate-100 sm:min-h-0 sm:min-w-0 sm:px-3 sm:py-2 sm:text-sm sm:font-normal"
            onClick={(e) => {
              void (async () => {
                await copyPageUrlToClipboard();
                setCopyHint("Link copied");
                window.setTimeout(() => setCopyHint(null), 2000);
                e.currentTarget.blur();
              })();
            }}
            title="Copy table link"
          >
            <span className="text-lg leading-none sm:hidden" aria-hidden>
              ⎘
            </span>
            <span className="sm:hidden">Copy</span>
            <span className="hidden sm:inline">Copy link</span>
          </button>
          {copyHint ? (
            <span className="w-full text-xs font-medium text-emerald-400 sm:w-auto sm:text-xs">
              {copyHint}
            </span>
          ) : null}
        </div>
      </header>

      {status === "need_join" && !observe ? (
        <form
          onSubmit={(e) => void submitJoin(e)}
          className="max-w-md space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-6"
        >
          <h2 className="text-lg font-medium text-white">Join this table</h2>
          <input
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            placeholder="Your username"
            value={joinName}
            onChange={(e) => setJoinName(e.target.value)}
            maxLength={32}
            required
          />
          <div>
            <input
              type="email"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              placeholder="Email (optional)"
              value={joinEmail}
              onChange={(e) => setJoinEmail(e.target.value)}
              maxLength={120}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Sharing your email lets you (and the host) review past games and
              chip history later.
            </p>
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button
            type="submit"
            className="w-full rounded-lg bg-emerald-500 py-2 font-medium text-slate-950"
          >
            Request access
          </button>
        </form>
      ) : null}

      {payload ? (
        <div className="flex flex-col gap-3 sm:gap-6">
         

          {!observe ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-[13px] text-slate-300 sm:px-4 sm:py-3 sm:text-sm">
              {handInProgress ? (
                <p className="leading-snug">
                  <span className="font-medium text-emerald-300">
                    Hand live
                  </span>
                  {" · "}
                  <span className="hidden sm:inline">Street </span>
                  <strong className="text-white">{hand?.street}</strong>
                  <span className="hidden sm:inline">, pot </span>
                  <span className="sm:hidden"> · pot </span>
                  <strong className="text-white">{hand?.pot ?? 0}</strong>
                  {hand?.toActPlayerId === selfId ? (
                    <span className="text-amber-300"> — your action</span>
                  ) : hand?.toActPlayerId ? (
                    <span className="text-slate-500">
                      {" "}
                      — waiting for{" "}
                      {payload.players.find(
                        (p) => p.playerId === hand.toActPlayerId,
                      )?.username ?? "…"}
                    </span>
                  ) : null}
                  {actionClockSec != null ? (
                    <span className="text-amber-200/90 tabular-nums">
                      {" "}
                      · {actionClockSec}s
                    </span>
                  ) : null}
                </p>
              ) : (
                <>
                  <p className="hidden sm:block">
                    <span className="text-slate-500">Lobby.</span> Open{" "}
                    <strong className="text-slate-200">Game settings</strong>{" "}
                    for blinds, antes, timers, and house rules. Auto-start deals
                    when the host and at least one other approved player are
                    seated with chips (if enabled).
                  </p>
                  <p className="leading-snug sm:hidden">
                    <span className="text-slate-500">Lobby.</span>{" "}
                    {payload.autoStartHand !== false
                      ? "Auto-start deals when host + 1 are seated."
                      : "Host taps Deal to start a hand."}
                  </p>
                </>
              )}
            </div>
          ) : null}

          {!observe && self?.approved ? (
            <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-xl border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs sm:gap-2 sm:px-3 sm:py-2">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                {self.seatIndex !== null ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        send({ type: "sit_out", away: !self.sittingOut })
                      }
                      className={`rounded-lg border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide sm:px-3 sm:py-1.5 sm:text-xs ${
                        self.sittingOut
                          ? "border-emerald-500/60 bg-emerald-700/30 text-emerald-200 hover:bg-emerald-700/50"
                          : "border-amber-500/40 bg-amber-900/20 text-amber-200 hover:bg-amber-900/40"
                      }`}
                      title={
                        self.sittingOut
                          ? "Re-enter on the next hand"
                          : "Skip the next hand and stay in your seat"
                      }
                    >
                      {self.sittingOut ? "I'm back" : "Sit out"}
                    </button>
                    <button
                      type="button"
                      onClick={() => send({ type: "leave_seat" })}
                      className="rounded-lg border border-slate-600 bg-slate-800/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-200 hover:bg-slate-700/70 sm:px-3 sm:py-1.5 sm:text-xs"
                      title="Stand up but stay in the room"
                    >
                      <span className="hidden sm:inline">Leave seat</span>
                      <span className="sm:hidden">Leave</span>
                    </button>
                  </>
                ) : (
                  <span className="text-slate-400">
                    Pick a seat to play.
                  </span>
                )}
                {self.chips === 0 ? (
                  <span className="rounded bg-rose-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-200 sm:px-2 sm:py-1 sm:text-[11px]">
                    {isHost
                      ? "Out — top yourself up"
                      : "Out — ask host"}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={() => setSoundOn((v) => !v)}
                  className="rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 sm:px-3 sm:py-1.5 sm:text-xs"
                  title="Plays a tone when it's your turn"
                  aria-label={soundOn ? "Sound on" : "Sound off"}
                >
                  <span className="hidden sm:inline">
                    {soundOn ? "Sound · on" : "Sound · off"}
                  </span>
                  <span aria-hidden className="sm:hidden">
                    {soundOn ? "🔊" : "🔇"}
                  </span>
                </button>
                <label className="hidden items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 sm:flex">
                  <input
                    type="checkbox"
                    className="accent-amber-400"
                    checked={confirmFold}
                    onChange={(e) => setConfirmFold(e.target.checked)}
                  />
                  Confirm fold
                </label>
                <button
                  type="button"
                  onClick={() => setConfirmFold((v) => !v)}
                  className={`rounded-lg border px-2 py-1 text-[11px] sm:hidden ${
                    confirmFold
                      ? "border-amber-500/60 bg-amber-900/30 text-amber-100"
                      : "border-slate-700 bg-slate-800/60 text-slate-300"
                  }`}
                  title="Tap fold twice to confirm"
                  aria-label="Confirm fold"
                  aria-pressed={confirmFold}
                >
                  Fold ✓
                </button>
                <button
                  type="button"
                  onClick={() => setLogOpen((v) => !v)}
                  className="rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 sm:px-3 sm:py-1.5 sm:text-xs"
                >
                  {logOpen ? "Hide log" : `Log (${actionLog.length})`}
                </button>
              </div>
            </div>
          ) : null}

          <PokerTable
            players={payload.players}
            hand={hand}
            selfId={selfId}
            observe={!!observe}
            canSit={!observe && !!self?.approved}
            smallBlind={payload.smallBlind}
            bigBlind={payload.bigBlind}
            hostUsername={hostUsername}
            onTakeSeat={(seatIndex) =>
              send({ type: "take_seat", seatIndex })
            }
          />

          {logOpen ? (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3 text-xs sm:p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-medium text-slate-200">
                  Hand log
                </h2>
                <button
                  type="button"
                  onClick={() => setActionLog([])}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-950/40 px-3 py-2 font-mono text-[11px] text-slate-300">
                {actionLog.length === 0 ? (
                  <p className="text-slate-600">No actions yet.</p>
                ) : (
                  actionLog.map((e) => <div key={e.id}>{e.text}</div>)
                )}
              </div>
            </section>
          ) : null}

          <div className="grid gap-3 sm:gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3 sm:p-5">
              <h2 className="text-sm font-medium text-slate-200">
                Table roster
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Face-down backs at each seat during a hand hide other
                players&apos; cards (like Poker Now). Your cards are face-up on
                your seat.
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {payload.players.map((p) => (
                  <li
                    key={p.playerId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 px-3 py-2"
                  >
                    <span>
                      <strong className="text-white">{p.username}</strong>
                      {p.isHost ? (
                        <span className="ml-2 text-xs text-amber-300">
                          host
                        </span>
                      ) : null}
                      {p.isBot ? (
                        <span className="ml-2 text-xs text-cyan-300">cpu</span>
                      ) : null}
                      {p.pendingRequest ? (
                        <span className="ml-2 text-xs text-orange-300">
                          pending
                        </span>
                      ) : null}
                      {p.seatIndex !== null ? (
                        <span className="ml-2 text-xs text-slate-500">
                          seat {p.seatIndex}
                        </span>
                      ) : null}
                      {p.connected ? null : (
                        <span className="ml-2 text-xs text-red-400">
                          offline
                        </span>
                      )}
                    </span>
                    <span className="text-emerald-300">{p.chips} chips</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-3 sm:space-y-4 sm:p-6">
              <h2 className="text-sm font-medium text-slate-200">
                Host & seats
              </h2>

              {isHost && payload.pendingRequests.length > 0 ? (
                <div>
                  <p className="text-xs uppercase text-slate-500">Requests</p>
                  <ul className="mt-2 space-y-2">
                    {payload.pendingRequests.map((r) => (
                      <li
                        key={r.playerId}
                        className="flex items-center justify-between gap-2"
                      >
                        <span>{r.username}</span>
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="rounded bg-emerald-600 px-2 py-1 text-xs text-white"
                            onClick={() =>
                              send({
                                type: "host_decision",
                                playerId: r.playerId,
                                approve: true,
                              })
                            }
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                            onClick={() =>
                              send({
                                type: "host_decision",
                                playerId: r.playerId,
                                approve: false,
                              })
                            }
                          >
                            Reject
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

            {isHost ? (
              <div>
                <div className="flex items-baseline justify-between">
                  <p className="text-xs uppercase text-slate-500">
                    Top up players
                  </p>
                  <span className="text-[10px] text-slate-600">
                    Adds chips between hands
                  </span>
                </div>
                {topUpHint ? (
                  <p className="mt-1 text-[11px] text-emerald-400">
                    {topUpHint}
                  </p>
                ) : null}
                <ul className="mt-2 space-y-1.5 text-sm">
                  {payload.players
                    .filter((p) => p.approved && !p.isBot)
                    .map((p) => {
                      const draftKey = p.playerId;
                      const draftStr = topUpDrafts[draftKey] ?? "";
                      const inHandNow = handInProgress && p.inHand;
                      const isMe = p.playerId === selfId;
                      function topUp(amount: number) {
                        if (amount < 1) return;
                        send({
                          type: "host_top_up",
                          playerId: p.playerId,
                          amount,
                        });
                        setTopUpDrafts((d) => ({
                          ...d,
                          [draftKey]: "",
                        }));
                        setTopUpHint(
                          `Added ${amount} to ${p.username}.`,
                        );
                        window.setTimeout(
                          () => setTopUpHint(null),
                          2200,
                        );
                      }
                      return (
                        <li
                          key={p.playerId}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-950/30 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            <strong className="text-white">
                              {p.username}
                            </strong>
                            {isMe ? (
                              <span className="ml-2 text-[10px] text-amber-300">
                                you
                              </span>
                            ) : null}
                            <span className="ml-2 text-[11px] text-emerald-300 tabular-nums">
                              {p.chips}
                            </span>
                            {p.chips === 0 ? (
                              <span className="ml-2 rounded bg-rose-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-200">
                                broke
                              </span>
                            ) : null}
                            {inHandNow ? (
                              <span className="ml-2 text-[10px] text-slate-500">
                                in hand
                              </span>
                            ) : null}
                          </span>
                          <input
                            type="number"
                            min={1}
                            placeholder="amount"
                            className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-xs text-white tabular-nums disabled:opacity-50"
                            value={draftStr}
                            disabled={inHandNow}
                            onChange={(e) =>
                              setTopUpDrafts((d) => ({
                                ...d,
                                [draftKey]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                topUp(Math.floor(Number(draftStr)));
                              }
                            }}
                          />
                          <div className="flex flex-wrap gap-1">
                            {[
                              payload.bigBlind * 50,
                              payload.bigBlind * 100,
                            ].map((q) => (
                              <button
                                key={q}
                                type="button"
                                className="rounded border border-slate-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-200 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={inHandNow || q < 1}
                                onClick={() => topUp(q)}
                                title={`Add ${q} (${q / payload.bigBlind} BB)`}
                              >
                                +{q}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={
                                inHandNow ||
                                !draftStr ||
                                Math.floor(Number(draftStr)) < 1
                              }
                              onClick={() =>
                                topUp(Math.floor(Number(draftStr)))
                              }
                            >
                              Add
                            </button>
                          </div>
                        </li>
                      );
                    })}
                </ul>
                <p className="mt-2 text-[11px] text-slate-500">
                  Players who are mid-hand can&apos;t be topped up — wait for
                  the hand to finish. Top-ups are recorded in the ledger as
                  rebuys.
                </p>
              </div>
            ) : null}

            {!observe && self?.approved && self.seatIndex === null ? (
              <div>
                <p className="text-xs uppercase text-slate-500">
                  Pick a seat
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      className="h-9 w-9 rounded border border-slate-700 text-xs text-slate-200 hover:border-emerald-500"
                      onClick={() =>
                        send({ type: "take_seat", seatIndex: i })
                      }
                    >
                      {i}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  After sitting, use the toolbar above to sit out, leave, or
                  toggle preferences.
                </p>
              </div>
            ) : null}

            {isHost && devBotsEnabled ? (
              <div className="rounded-xl border border-dashed border-amber-600/40 bg-amber-950/25 p-3 text-xs">
                <p className="font-medium text-amber-200">
                  Local testing — test bots
                </p>
                <p className="mt-1 text-slate-400">
                  Adds CPU players in the next free seats (check/call only). Set
                  both{" "}
                  <code className="text-slate-300">
                    GANGA_DEV_BOTS=1
                  </code>{" "}
                  on the realtime server and{" "}
                  <code className="text-slate-300">
                    NEXT_PUBLIC_GANGA_DEV_BOTS=1
                  </code>{" "}
                  for this UI, then restart{" "}
                  <code className="text-slate-300">npm run dev</code>.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-amber-700/60 px-2 py-1 text-amber-100"
                    onClick={() =>
                      send({ type: "dev_add_test_bot", count: 1 })
                    }
                  >
                    +1 bot
                  </button>
                  <button
                    type="button"
                    className="rounded border border-amber-700/60 px-2 py-1 text-amber-100"
                    onClick={() =>
                      send({ type: "dev_add_test_bot", count: 2 })
                    }
                  >
                    +2 bots
                  </button>
                </div>
              </div>
            ) : null}

            {isHost ? (
              <button
                type="button"
                className="w-full rounded-lg bg-amber-500 py-2 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => send({ type: "start_hand" })}
                disabled={handInProgress}
                title={
                  handInProgress
                    ? "A hand is already running"
                    : "Deal the next hand"
                }
              >
                {handInProgress
                  ? "Hand in progress…"
                  : `Start hand${payload.autoStartHand !== false ? " (manual)" : ""}`}
              </button>
            ) : null}

            <p className="text-[11px] text-slate-500">
              Action buttons live in the bar at the bottom of the screen when
              it&apos;s your turn.
            </p>
          </section>
        </div>

          {(observe || status === "live") && (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3 sm:p-5">
              <h2 className="text-sm font-medium text-slate-200">Table chat</h2>
              <p className="mt-1 text-xs text-slate-500">
                Shown to everyone connected to this game. Observers can read
                only.
              </p>
              <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-950/40 px-3 py-2 text-sm">
                {chatLines.length === 0 ? (
                  <p className="text-xs text-slate-600">No messages yet.</p>
                ) : (
                  chatLines.map((line, i) => (
                    <div key={`${line.at}-${i}-${line.playerId}`}>
                      <span className="font-medium text-emerald-300/90">
                        {line.username}
                      </span>
                      <span className="text-slate-500">: </span>
                      <span className="text-slate-200">{line.text}</span>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
              {!observe ? (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = chatDraft.trim().slice(0, 500);
                    if (!t) return;
                    send({ type: "chat", text: t });
                    setChatDraft("");
                  }}
                >
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                    placeholder="Message the table…"
                    maxLength={500}
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    disabled={status !== "live"}
                  />
                  <button
                    type="submit"
                    className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white disabled:opacity-40"
                    disabled={status !== "live" || !chatDraft.trim()}
                  >
                    Send
                  </button>
                </form>
              ) : null}
            </section>
          )}
        </div>
      ) : null}

      {settingsOpen && isHost && !observe ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="game-settings-title"
        >
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 px-5 py-3 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  className="text-sm text-slate-400 hover:text-white"
                  onClick={() => setSettingsOpen(false)}
                >
                  « Back to table
                </button>
                <h2
                  id="game-settings-title"
                  className="text-base font-semibold text-white"
                >
                  Game settings
                </h2>
                <button
                  type="button"
                  className="text-sm text-slate-400 hover:text-white"
                  onClick={() => setSettingsOpen(false)}
                >
                  Close
                </button>
              </div>
              <div className="mt-3 flex gap-1">
                <button
                  type="button"
                  className={`rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-wide ${
                    settingsTab === "game"
                      ? "bg-emerald-900/70 text-emerald-100"
                      : "text-slate-500 hover:bg-slate-800"
                  }`}
                  onClick={() => setSettingsTab("game")}
                >
                  Game
                </button>
                <button
                  type="button"
                  className={`rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-wide ${
                    settingsTab === "preferences"
                      ? "bg-emerald-900/70 text-emerald-100"
                      : "text-slate-500 hover:bg-slate-800"
                  }`}
                  onClick={() => setSettingsTab("preferences")}
                >
                  Preferences
                </button>
              </div>
            </div>

            <div className="px-5 py-4">
              <p className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100/90">
                Only the room owner can change these settings. Updates are
                blocked while a hand is live.
              </p>

              {settingsTab === "preferences" ? (
                <div className="mt-6 space-y-3 text-sm text-slate-400">
                  <p>
                    Personal display and sound options (like Poker
                    Now&apos;s Preferences tab) are not wired yet. Everything
                    under <strong className="text-slate-200">Game</strong>{" "}
                    applies to the whole table.
                  </p>
                </div>
              ) : (
                <>
                  <section className="mt-6">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
                      Blind levels
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Cash-style table: one level. Tournament-style blind jumps
                      are not scheduled yet.
                    </p>
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <SegmentedYesNo
                        label="Antes?"
                        value={draftAntesEnabled}
                        onChange={setDraftAntesEnabled}
                        hint="When YES, each player posts the ante every hand before blinds (server-enforced)."
                      />
                      {draftAntesEnabled ? (
                        <label className="mt-2 block text-sm">
                          <span className="text-slate-400">Ante amount</span>
                          <input
                            type="number"
                            min={0}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                            value={draftAnteAmount}
                            onChange={(e) => setDraftAnteAmount(e.target.value)}
                          />
                          <span className="mt-1 block text-xs text-slate-500">
                            Max 50× big blind when saved (server check).
                          </span>
                        </label>
                      ) : null}
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <label className="block text-sm">
                          <span className="text-slate-400">SB</span>
                          <input
                            type="number"
                            min={1}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                            value={draftSb}
                            onChange={(e) => setDraftSb(e.target.value)}
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="text-slate-400">BB</span>
                          <input
                            type="number"
                            min={1}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                            value={draftBb}
                            onChange={(e) => setDraftBb(e.target.value)}
                          />
                        </label>
                        <label className="block text-sm sm:col-span-1">
                          <span className="text-slate-400">Duration</span>
                          <div className="mt-1 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-400">
                            ∞ cash
                          </div>
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="mt-8">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
                      Poker variant
                    </h3>
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <label className="block text-sm">
                        <span className="text-slate-400">Game type</span>
                        <select
                          disabled
                          className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300"
                          value="nlhe"
                        >
                          <option value="nlhe">
                            No-Limit Texas Hold&apos;em
                          </option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="mt-8">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
                      Gameplay rules
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Stored on the server. Items without live engine support are
                      kept for your room config and future releases.
                    </p>
                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 px-2">
                      <SegmentedYesNo
                        label="Use cents values?"
                        value={draftUseCents}
                        onChange={setDraftUseCents}
                        hint="UI chip display hint only for now."
                      />
                      <SegmentedYesNo
                        label="Rabbit hunting (show undealt cards)?"
                        value={draftRabbit}
                        onChange={setDraftRabbit}
                        hint="Not enforced in-client yet."
                      />
                      <div className="flex flex-col gap-1 border-b border-slate-800/80 py-3">
                        <span className="text-sm text-slate-300">
                          Run it twice?
                        </span>
                        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-600 p-0.5">
                          {(
                            [
                              ["off", "OFF"],
                              ["ask", "ASK"],
                              ["always", "ALWAYS"],
                            ] as const
                          ).map(([val, lab]) => (
                            <button
                              key={val}
                              type="button"
                              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${
                                draftRunItTwice === val
                                  ? "bg-emerald-800 text-white"
                                  : "text-slate-500"
                              }`}
                              onClick={() => setDraftRunItTwice(val)}
                            >
                              {lab}
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-slate-500">
                          Not enforced in the engine yet.
                        </p>
                      </div>
                      <SegmentedYesNo
                        label="Allow UTG straddle (2 BB)?"
                        value={draftStraddle}
                        onChange={setDraftStraddle}
                        hint="Not enforced in the engine yet."
                      />
                      <SegmentedYesNo
                        label="Reveal all when no more action?"
                        value={draftReveal}
                        onChange={setDraftReveal}
                        hint="House rule flag; showdown flow may evolve."
                      />
                      <SegmentedYesNo
                        label="Spectators allowed?"
                        value={draftSpectators}
                        onChange={setDraftSpectators}
                        hint="Guest links still need approve; admin observe unchanged."
                      />
                    </div>
                  </section>

                  <section className="mt-8">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
                      Table flow
                    </h3>
                    <div className="mt-3 space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <label className="block text-sm">
                        <span className="text-slate-400">
                          Action time (seconds, 0 = default 20s)
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={120}
                          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                          value={draftTimer}
                          onChange={(e) => setDraftTimer(e.target.value)}
                        />
                        <span className="mt-1 block text-xs text-slate-500">
                          The server always runs a clock: saved 0 means a 20s
                          default. When time runs out, players check (if free) or
                          fold so action passes to the next seat.
                        </span>
                      </label>
                      <SegmentedYesNo
                        label="Auto-start when host + 1 other are seated?"
                        value={draftAutoStart}
                        onChange={setDraftAutoStart}
                      />
                    </div>
                  </section>

                  <div className="mt-8 flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-5">
                    <button
                      type="button"
                      className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
                      onClick={() => setSettingsOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/20"
                      onClick={() => {
                        const sb = Math.floor(Number(draftSb));
                        const bb = Math.floor(Number(draftBb));
                        const tm = Math.floor(Number(draftTimer));
                        const ante = Math.floor(Number(draftAnteAmount));
                        if (!Number.isFinite(sb) || sb < 1) {
                          setError("invalid small blind");
                          return;
                        }
                        if (!Number.isFinite(bb) || bb < 1) {
                          setError("invalid big blind");
                          return;
                        }
                        if (!Number.isFinite(tm) || tm < 0 || tm > 120) {
                          setError("timer must be 0–120");
                          return;
                        }
                        if (!Number.isFinite(ante) || ante < 0) {
                          setError("invalid ante");
                          return;
                        }
                        if (draftAntesEnabled && ante > bb * 50) {
                          setError("ante too large (max 50× big blind)");
                          return;
                        }
                        send({
                          type: "host_game_settings",
                          smallBlind: sb,
                          bigBlind: bb,
                          turnTimerSeconds: tm,
                          autoStartHand: draftAutoStart,
                          antesEnabled: draftAntesEnabled,
                          anteAmount: draftAntesEnabled ? ante : 0,
                          useCentsDisplay: draftUseCents,
                          rabbitHunting: draftRabbit,
                          runItTwice: draftRunItTwice,
                          utgStraddleAllowed: draftStraddle,
                          revealWithNoAction: draftReveal,
                          spectatorsAllowed: draftSpectators,
                        });
                        setSettingsOpen(false);
                      }}
                    >
                      Update game
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {payload && !observe && self?.approved && self.seatIndex !== null ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-2 pb-safe-3 sm:px-3">
          <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-950/95 p-2 shadow-2xl backdrop-blur sm:min-h-0 sm:p-3">
            {handInProgress && self.inHand ? (
              <div className="flex flex-col gap-2 sm:gap-3">
                {/* Mobile: primary actions at top (stable thumb zone); desktop: stats first */}
                <div className="order-1 flex touch-pan-x flex-nowrap items-stretch justify-start gap-2 overflow-x-auto overscroll-x-contain [-ms-scrollbar-style:none] [scrollbar-width:none] sm:order-3 sm:flex-wrap sm:justify-center sm:overflow-visible [&::-webkit-scrollbar]:hidden">
                  <ActionButton
                    label={pendingFoldConfirm ? "Tap again" : "Fold"}
                    variant="fold"
                    disabled={!canAct}
                    onClick={doFold}
                  />
                  {toCall === 0 ? (
                    <ActionButton
                      label="Check"
                      variant="check"
                      disabled={!canAct}
                      onClick={doCheckOrCall}
                    />
                  ) : (
                    <ActionButton
                      label="Call"
                      sublabel={String(callAmount)}
                      variant="call"
                      disabled={!canAct}
                      onClick={doCheckOrCall}
                    />
                  )}
                  {canRaise ? (
                    <ActionButton
                      label="Raise"
                      sublabel={`to ${clamp(
                        raiseSlider || effectiveMinRaise,
                        effectiveMinRaise,
                        allInTotal,
                      )}`}
                      variant="raise"
                      disabled={!canAct}
                      onClick={() =>
                        doRaiseTo(raiseSlider || effectiveMinRaise)
                      }
                    />
                  ) : null}
                  <ActionButton
                    label="All-in"
                    sublabel={String(allInTotal)}
                    variant="raise"
                    disabled={!canAct || myChips === 0}
                    onClick={doAllIn}
                  />
                </div>

                <div className="order-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] uppercase tracking-wide text-slate-400 sm:order-1 sm:mb-0 sm:text-[11px]">
                  <span className="min-w-0 leading-snug">
                    Pot{" "}
                    <span className="text-slate-100 tabular-nums">
                      {potNow}
                    </span>
                    {" · "}
                    <span className="hidden sm:inline">To call</span>
                    <span className="sm:hidden">Call</span>{" "}
                    <span className="text-slate-100 tabular-nums">
                      {toCall}
                    </span>
                    {" · "}
                    <span className="hidden sm:inline">My stack</span>
                    <span className="sm:hidden">Stack</span>{" "}
                    <span className="text-slate-100 tabular-nums">
                      {myChips}
                    </span>
                  </span>
                  <span
                    className={`max-w-[55%] shrink-0 text-right text-[11px] normal-case leading-snug tabular-nums sm:max-w-none ${
                      canAct ? "text-amber-300" : "text-slate-500"
                    }`}
                  >
                    {canAct
                      ? `Your turn${
                          actionClockSec != null ? ` · ${actionClockSec}s` : ""
                        }`
                      : `Waiting for ${
                          payload.players.find(
                            (p) => p.playerId === hand?.toActPlayerId,
                          )?.username ?? "…"
                        }${
                          actionClockSec != null ? ` · ${actionClockSec}s` : ""
                        }`}
                  </span>
                </div>

                {canAct && canRaise ? (
                  <div className="order-3 flex min-h-0 flex-col gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 p-2 sm:order-2 sm:mb-0 sm:gap-2 sm:p-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={effectiveMinRaise}
                        max={allInTotal}
                        step={Math.max(1, payload.smallBlind)}
                        value={clamp(
                          raiseSlider || effectiveMinRaise,
                          effectiveMinRaise,
                          allInTotal,
                        )}
                        onChange={(e) =>
                          setRaiseSlider(Number(e.target.value))
                        }
                        className="h-3 min-w-0 flex-1 touch-manipulation accent-amber-400 sm:h-2"
                      />
                      <input
                        type="number"
                        inputMode="numeric"
                        min={effectiveMinRaise}
                        max={allInTotal}
                        value={clamp(
                          raiseSlider || effectiveMinRaise,
                          effectiveMinRaise,
                          allInTotal,
                        )}
                        onChange={(e) =>
                          setRaiseSlider(Number(e.target.value))
                        }
                        className="min-h-10 w-[4.5rem] rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-right text-sm text-white tabular-nums sm:min-h-0 sm:w-24 sm:px-2 sm:text-sm"
                      />
                    </div>
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-scrollbar-style:none] [scrollbar-width:none] sm:flex-wrap sm:gap-1.5 sm:overflow-visible [&::-webkit-scrollbar]:hidden">
                      <button
                        type="button"
                        className="min-h-9 shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200 hover:bg-slate-800 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[11px]"
                        onClick={() => setRaiseSlider(effectiveMinRaise)}
                      >
                        Min
                      </button>
                      <button
                        type="button"
                        className="min-h-9 shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200 hover:bg-slate-800 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[11px]"
                        onClick={() => setRaiseSlider(chipsForFraction(0.5))}
                      >
                        ½ Pot
                      </button>
                      <button
                        type="button"
                        className="min-h-9 shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200 hover:bg-slate-800 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[11px]"
                        onClick={() =>
                          setRaiseSlider(chipsForFraction(2 / 3))
                        }
                      >
                        ⅔ Pot
                      </button>
                      <button
                        type="button"
                        className="min-h-9 shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200 hover:bg-slate-800 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[11px]"
                        onClick={() => setRaiseSlider(chipsForFraction(1))}
                      >
                        Pot
                      </button>
                      <button
                        type="button"
                        className="min-h-9 shrink-0 rounded-md border border-amber-500/60 bg-amber-700/30 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-amber-100 hover:bg-amber-700/50 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[11px]"
                        onClick={() => setRaiseSlider(allInTotal)}
                      >
                        <span className="hidden sm:inline">
                          All-in {allInTotal}
                        </span>
                        <span className="sm:hidden">All {allInTotal}</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {!canAct ? (
                  <div className="order-4 flex flex-wrap items-center justify-center gap-1.5 border-t border-slate-800 pt-2 text-[11px] sm:order-4 sm:gap-2 sm:pt-2 sm:text-[11px]">
                    <span className="hidden w-full text-center text-slate-500 sm:inline sm:w-auto">
                      Pre-action:
                    </span>
                    {(
                      [
                        ["off", "None", "None"],
                        ["check_fold", "Check / Fold", "Ck/Fd"],
                        ["check_any", "Check (if free)", "Check"],
                        ["call_any", "Call any", "Call"],
                      ] as const
                    ).map(([val, lab, short]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setPreAction(val)}
                        className={`min-h-9 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide sm:min-h-0 sm:px-2 sm:py-1 ${
                          preAction === val
                            ? "border-amber-400 bg-amber-700/30 text-amber-100"
                            : "border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800"
                        }`}
                      >
                        <span className="hidden sm:inline">{lab}</span>
                        <span className="sm:hidden">{short}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-3 text-sm text-slate-300 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2 sm:text-xs">
                <span className="text-center leading-snug sm:text-left">
                  {self.sittingOut
                    ? "Sitting out — tap I'm back to rejoin."
                    : handInProgress
                      ? "Not in this hand — dealt in next."
                      : payload.autoStartHand !== false
                        ? "Waiting for next hand…"
                        : "Waiting for host to deal."}
                </span>
                {isHost && !handInProgress ? (
                  <button
                    type="button"
                    className="min-h-12 w-full shrink-0 rounded-xl bg-amber-500 px-4 py-3 text-base font-bold text-slate-950 shadow-lg shadow-amber-900/30 hover:bg-amber-400 active:bg-amber-500 sm:min-h-0 sm:w-auto sm:rounded-lg sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold sm:shadow-none"
                    onClick={() => send({ type: "start_hand" })}
                  >
                    Deal next hand
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
