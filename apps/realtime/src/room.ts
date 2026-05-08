import {
  AuditLog,
  Game,
  HandHistory,
  LedgerEntry,
  type GamePlayerDoc,
  connectDb,
  seedAdminUsers,
} from "@ganga/db";
import { randomUUID } from "node:crypto";
import {
  MAX_SEATS,
  type JoinRequestInfo,
  type PublicPlayer,
  type Card,
  signSession,
  verifySession,
  parseCard,
  bestHandFromHoleBoard,
  formatHandShortLabel,
} from "@ganga/shared";
import type { WebSocket } from "ws";
import { PokerHand, type HandPublic } from "./poker-engine.js";

const STARTING_CHIPS = 1000;

/**
 * GANGA_HOST_GODMODE=1 lets every host see every contesting player's hole cards
 * during a live hand. Intended for tutorials/demos/debugging — when on, every
 * client also receives a `hostSeesAll: true` flag so the UI can display a
 * transparent banner ("Host can see all hole cards") to every player.
 *
 * Read lazily because the realtime entrypoint calls dotenv.config() AFTER
 * importing room.ts (ES module imports are hoisted), so a top-level
 * `process.env.GANGA_HOST_GODMODE` read here would always see `undefined`.
 */
function hostSeesAllEnabled(): boolean {
  return process.env.GANGA_HOST_GODMODE === "1";
}

interface RoomMember {
  playerId: string;
  username: string;
  seatIndex: number | null;
  chips: number;
  isHost: boolean;
  approved: boolean;
  pendingRequest: boolean;
  /** Ephemeral test players (not persisted to Mongo). */
  isBot?: boolean;
  /** Sit-out: keeps seat, is skipped when next hand is dealt. Ephemeral (per session). */
  sittingOut?: boolean;
  /** Optional contact captured at join for cross-game history. */
  email?: string | null;
  /** Cumulative chips bought in this game (initial + host top-ups). */
  buyIn?: number;
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function normalizeRunItTwice(v: unknown): "off" | "always" | "ask" {
  return v === "always" || v === "ask" ? v : "off";
}

export class Room {
  readonly gameId: string;
  readonly hostPlayerId: string;
  hostEmail: string | null = null;
  smallBlind: number;
  bigBlind: number;
  /** 0 = no forced action. */
  turnTimerSeconds: number;
  autoStartHand: boolean;
  handsPlayed: number = 0;
  antesEnabled = false;
  anteAmount = 0;
  useCentsDisplay = false;
  rabbitHunting = false;
  runItTwice: "off" | "always" | "ask" = "off";
  utgStraddleAllowed = false;
  revealWithNoAction = true;
  spectatorsAllowed = true;
  private members = new Map<string, RoomMember>();
  private sockets = new Map<string, WebSocket>();
  private observerSockets = new Set<WebSocket>();
  activeHand: PokerHand | null = null;
  private lastButtonSeat: number | null = null;
  private jwtSecret: string;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private turnActTimer: ReturnType<typeof setTimeout> | null = null;
  /** Server timestamp (ms) when the current to-act must auto-act, or null. */
  turnDeadlineMs: number | null = null;

  constructor(
    gameId: string,
    hostPlayerId: string,
    hostUsername: string,
    smallBlind: number,
    bigBlind: number,
    turnTimerSeconds: number,
    autoStartHand: boolean,
    jwtSecret: string,
  ) {
    this.gameId = gameId;
    this.hostPlayerId = hostPlayerId;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.turnTimerSeconds = turnTimerSeconds;
    this.autoStartHand = autoStartHand;
    this.jwtSecret = jwtSecret;
    this.members.set(hostPlayerId, {
      playerId: hostPlayerId,
      username: hostUsername,
      seatIndex: null,
      chips: STARTING_CHIPS,
      isHost: true,
      approved: true,
      pendingRequest: false,
      isBot: false,
      buyIn: STARTING_CHIPS,
    });
  }

  static fromDoc(
    doc: {
      gameId: string;
      hostPlayerId: string;
      hostUsername: string;
      hostEmail?: string | null;
      smallBlind: number;
      bigBlind: number;
      turnTimerSeconds?: number;
      autoStartHand?: boolean;
      antesEnabled?: boolean;
      anteAmount?: number;
      useCentsDisplay?: boolean;
      rabbitHunting?: boolean;
      runItTwice?: string;
      utgStraddleAllowed?: boolean;
      revealWithNoAction?: boolean;
      spectatorsAllowed?: boolean;
      handsPlayed?: number;
      players: GamePlayerDoc[];
    },
    jwtSecret: string,
  ): Room {
    const r = new Room(
      doc.gameId,
      doc.hostPlayerId,
      doc.hostUsername,
      doc.smallBlind,
      doc.bigBlind,
      doc.turnTimerSeconds ?? 20,
      doc.autoStartHand !== false,
      jwtSecret,
    );
    r.hostEmail = doc.hostEmail ?? null;
    r.handsPlayed = Math.max(0, Math.floor(Number(doc.handsPlayed ?? 0)));
    r.members.clear();
    for (const p of doc.players) {
      r.members.set(p.playerId, {
        playerId: p.playerId,
        username: p.username,
        seatIndex: p.seatIndex,
        chips: p.chips,
        isHost: p.isHost,
        approved: p.approved || p.isHost,
        pendingRequest: !(p.approved || p.isHost),
        isBot: false,
        email: p.email ?? null,
        buyIn: Math.max(0, Math.floor(Number(p.buyIn ?? p.chips ?? 0))),
      });
    }
    r.antesEnabled = doc.antesEnabled === true;
    r.anteAmount = Math.max(0, Math.floor(Number(doc.anteAmount ?? 0)));
    r.useCentsDisplay = doc.useCentsDisplay === true;
    r.rabbitHunting = doc.rabbitHunting === true;
    r.runItTwice = normalizeRunItTwice(doc.runItTwice);
    r.utgStraddleAllowed = doc.utgStraddleAllowed === true;
    r.revealWithNoAction = doc.revealWithNoAction !== false;
    r.spectatorsAllowed = doc.spectatorsAllowed !== false;
    return r;
  }

  async persist(): Promise<void> {
    const players = [...this.members.values()]
      .filter((m) => !m.isBot)
      .map(
        (m): GamePlayerDoc => ({
          playerId: m.playerId,
          username: m.username,
          seatIndex: m.seatIndex,
          chips: m.chips,
          isHost: m.isHost,
          approved: m.approved || m.isHost,
          email: m.email ?? null,
          buyIn: m.buyIn ?? 0,
        }),
      );
    await Game.updateOne(
      { gameId: this.gameId },
      {
        $set: {
          players,
          hostEmail: this.hostEmail,
          handsPlayed: this.handsPlayed,
          smallBlind: this.smallBlind,
          bigBlind: this.bigBlind,
          turnTimerSeconds: this.turnTimerSeconds,
          autoStartHand: this.autoStartHand,
          antesEnabled: this.antesEnabled,
          anteAmount: this.anteAmount,
          useCentsDisplay: this.useCentsDisplay,
          rabbitHunting: this.rabbitHunting,
          runItTwice: this.runItTwice,
          utgStraddleAllowed: this.utgStraddleAllowed,
          revealWithNoAction: this.revealWithNoAction,
          spectatorsAllowed: this.spectatorsAllowed,
          status:
            this.activeHand && !this.activeHand.handComplete
              ? "playing"
              : "lobby",
        },
      },
    );
  }

  /**
   * Merge Mongo `players` into memory so API joins (and other processes) are
   * visible to an already-cached room. During a live hand, chips and seats are
   * not overwritten from DB (engine + persist own those).
   */
  async refreshMembersFromDatabase(): Promise<void> {
    const doc = await Game.findOne({ gameId: this.gameId }).lean();
    if (!doc || Array.isArray(doc)) return;
    const g = doc as unknown as {
      players: GamePlayerDoc[];
      smallBlind?: number;
      bigBlind?: number;
      turnTimerSeconds?: number;
      autoStartHand?: boolean;
      antesEnabled?: boolean;
      anteAmount?: number;
      useCentsDisplay?: boolean;
      rabbitHunting?: boolean;
      runItTwice?: string;
      utgStraddleAllowed?: boolean;
      revealWithNoAction?: boolean;
      spectatorsAllowed?: boolean;
    };
    const inHand = !!(this.activeHand && !this.activeHand.handComplete);
    const idsFromDb = new Set(g.players.map((p) => p.playerId));
    const gx = g as { hostEmail?: string | null; handsPlayed?: number };
    if (typeof gx.hostEmail === "string" || gx.hostEmail === null) {
      this.hostEmail = gx.hostEmail ?? null;
    }
    if (typeof gx.handsPlayed === "number") {
      this.handsPlayed = Math.max(this.handsPlayed, gx.handsPlayed);
    }

    if (!inHand) {
      if (typeof g.smallBlind === "number" && g.smallBlind >= 1) {
        this.smallBlind = g.smallBlind;
      }
      if (typeof g.bigBlind === "number" && g.bigBlind >= 1) {
        this.bigBlind = g.bigBlind;
      }
      if (this.bigBlind < this.smallBlind) {
        this.bigBlind = this.smallBlind;
      }
      if (typeof g.turnTimerSeconds === "number") {
        this.turnTimerSeconds = Math.max(0, Math.min(120, g.turnTimerSeconds));
      }
      if (typeof g.autoStartHand === "boolean") {
        this.autoStartHand = g.autoStartHand;
      }
      if (typeof g.antesEnabled === "boolean") {
        this.antesEnabled = g.antesEnabled;
      }
      if (typeof g.anteAmount === "number") {
        this.anteAmount = Math.max(0, Math.floor(g.anteAmount));
      }
      if (typeof g.useCentsDisplay === "boolean") {
        this.useCentsDisplay = g.useCentsDisplay;
      }
      if (typeof g.rabbitHunting === "boolean") {
        this.rabbitHunting = g.rabbitHunting;
      }
      if (g.runItTwice !== undefined) {
        this.runItTwice = normalizeRunItTwice(g.runItTwice);
      }
      if (typeof g.utgStraddleAllowed === "boolean") {
        this.utgStraddleAllowed = g.utgStraddleAllowed;
      }
      if (typeof g.revealWithNoAction === "boolean") {
        this.revealWithNoAction = g.revealWithNoAction;
      }
      if (typeof g.spectatorsAllowed === "boolean") {
        this.spectatorsAllowed = g.spectatorsAllowed;
      }
      for (const id of [...this.members.keys()]) {
        const m = this.members.get(id)!;
        if (m.isBot) continue;
        if (!idsFromDb.has(id)) this.members.delete(id);
      }
    }

    for (const p of g.players) {
      const existing = this.members.get(p.playerId);
      if (existing?.isBot) continue;
      const approved = p.approved || p.isHost;
      const pendingRequest = !(p.approved || p.isHost);
      const email = (p as GamePlayerDoc).email ?? null;
      const buyIn = Math.max(
        0,
        Math.floor(Number((p as GamePlayerDoc).buyIn ?? 0)),
      );
      if (existing) {
        existing.username = p.username;
        existing.isHost = p.isHost;
        existing.approved = approved;
        existing.pendingRequest = pendingRequest;
        if (email !== null) existing.email = email;
        if (existing.buyIn === undefined || existing.buyIn < buyIn) {
          existing.buyIn = buyIn;
        }
        if (!inHand) {
          existing.seatIndex = p.seatIndex;
          existing.chips = p.chips;
        }
      } else {
        this.members.set(p.playerId, {
          playerId: p.playerId,
          username: p.username,
          seatIndex: p.seatIndex,
          chips: p.chips,
          isHost: p.isHost,
          approved,
          pendingRequest,
          isBot: false,
          email,
          buyIn: buyIn || p.chips,
        });
      }
    }
  }

  /** Same payload to every connected player socket and observers (e.g. chat). */
  fanout(msg: object): void {
    for (const [, ws] of this.sockets) {
      send(ws, msg);
    }
    for (const ws of this.observerSockets) {
      send(ws, msg);
    }
  }

  async audit(
    actor: string | null,
    event: string,
    detail: object,
  ): Promise<void> {
    await AuditLog.create({
      gameId: this.gameId,
      actor,
      event,
      detail,
    });
  }

  async appendLedger(
    playerId: string | null,
    type: "buy_in" | "pot_award" | "adjustment" | "rebuy" | "cash_out",
    amount: number,
    balanceAfter: number | null,
    ref: string | null,
    meta?: object,
  ): Promise<void> {
    await LedgerEntry.create({
      gameId: this.gameId,
      playerId,
      type,
      amount,
      balanceAfter,
      ref,
      meta,
    });
  }

  bindSocket(playerId: string, ws: WebSocket): void {
    this.sockets.set(playerId, ws);
  }

  unbindSocket(ws: WebSocket): void {
    for (const [pid, s] of this.sockets) {
      if (s === ws) this.sockets.delete(pid);
    }
    this.observerSockets.delete(ws);
  }

  addObserver(ws: WebSocket): void {
    this.observerSockets.add(ws);
  }

  getPendingRequests(): JoinRequestInfo[] {
    return [...this.members.values()]
      .filter((m) => m.pendingRequest && !m.approved)
      .map((m) => ({ playerId: m.playerId, username: m.username }));
  }

  getMember(playerId: string): RoomMember | undefined {
    return this.members.get(playerId);
  }

  findMemberByUsername(username: string): RoomMember | undefined {
    const lower = username.trim().toLowerCase();
    return [...this.members.values()].find(
      (m) => m.username.toLowerCase() === lower,
    );
  }

  addPendingGuest(
    playerId: string,
    username: string,
    email?: string | null,
  ): void {
    if (this.findMemberByUsername(username)) {
      throw new Error("username_taken");
    }
    this.members.set(playerId, {
      playerId,
      username: username.trim().slice(0, 32),
      seatIndex: null,
      chips: STARTING_CHIPS,
      isHost: false,
      approved: false,
      pendingRequest: true,
      isBot: false,
      email: email ?? null,
      buyIn: STARTING_CHIPS,
    });
  }

  setApproved(playerId: string, approve: boolean, actorId: string): void {
    const m = this.members.get(playerId);
    if (!m || m.isHost) throw new Error("invalid_target");
    if (approve) {
      m.approved = true;
      m.pendingRequest = false;
      m.chips = STARTING_CHIPS;
      m.buyIn = (m.buyIn ?? 0) + STARTING_CHIPS;
      void this.appendLedger(
        m.playerId,
        "buy_in",
        STARTING_CHIPS,
        m.chips,
        "seat_open",
        { event: "approved" },
      );
    } else {
      this.members.delete(playerId);
    }
    void this.audit(actorId, approve ? "join_approved" : "join_rejected", {
      playerId,
    });
  }

  takeSeat(playerId: string, seatIndex: number): void {
    const m = this.members.get(playerId);
    if (!m || !m.approved) throw new Error("not_approved");
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) throw new Error("bad_seat");
    for (const o of this.members.values()) {
      if (o.seatIndex === seatIndex && o.playerId !== playerId) {
        throw new Error("seat_taken");
      }
    }
    m.seatIndex = seatIndex;
    void this.audit(playerId, "take_seat", { seatIndex });
  }

  leaveSeat(playerId: string): void {
    const m = this.members.get(playerId);
    if (!m) return;
    m.seatIndex = null;
    m.sittingOut = false;
    void this.audit(playerId, "leave_seat", {});
  }

  hostTopUp(actorId: string, playerId: string, amount: number): void {
    if (actorId !== this.hostPlayerId) throw new Error("not_host");
    const m = this.members.get(playerId);
    if (!m) throw new Error("unknown_player");
    if (!m.approved) throw new Error("not_approved");
    const add = Math.floor(amount);
    if (!Number.isFinite(add) || add < 1) throw new Error("bad_amount");
    if (add > 1_000_000) throw new Error("amount_too_large");
    if (this.activeHand && this.activeHand.isContesting(playerId)) {
      throw new Error("player_in_hand");
    }
    m.chips += add;
    m.buyIn = (m.buyIn ?? 0) + add;
    void this.appendLedger(
      m.playerId,
      "rebuy",
      add,
      m.chips,
      "host_top_up",
      { actorId, source: "host_top_up" },
    );
    void this.audit(actorId, "host_top_up", {
      playerId,
      amount: add,
      newBalance: m.chips,
    });
  }

  setSittingOut(playerId: string, away: boolean): void {
    const m = this.members.get(playerId);
    if (!m) return;
    if (m.seatIndex === null) return;
    m.sittingOut = !!away;
    void this.audit(playerId, away ? "sit_out" : "sit_in", {});
  }

  private nextFreeSeat(): number | null {
    const taken = new Set(
      [...this.members.values()]
        .map((m) => m.seatIndex)
        .filter((s): s is number => s !== null),
    );
    for (let i = 0; i < MAX_SEATS; i++) {
      if (!taken.has(i)) return i;
    }
    return null;
  }

  /** Ephemeral CPU players for local testing (not saved to Mongo). */
  addTestBots(count: number): void {
    for (let i = 0; i < count; i++) {
      const seat = this.nextFreeSeat();
      if (seat === null) {
        throw new Error("no_free_seat");
      }
      const botNum =
        [...this.members.values()].filter((m) => m.isBot).length + 1;
      const id = randomUUID();
      const username = `TestBot ${botNum}`;
      this.members.set(id, {
        playerId: id,
        username,
        seatIndex: seat,
        chips: STARTING_CHIPS,
        isHost: false,
        approved: true,
        pendingRequest: false,
        isBot: true,
      });
      void this.audit(null, "dev_test_bot_added", { playerId: id, seat, username });
    }
  }

  private clearBotTimer(): void {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  private clearTurnActTimer(): void {
    if (this.turnActTimer) {
      clearTimeout(this.turnActTimer);
      this.turnActTimer = null;
    }
    this.turnDeadlineMs = null;
  }

  private clearAllActionTimers(): void {
    this.clearBotTimer();
    this.clearTurnActTimer();
  }

  /** Auto check or fold when the action clock expires (human seats). */
  private scheduleTurnAct(): void {
    this.clearTurnActTimer();
    if (!this.activeHand || this.activeHand.handComplete) return;
    const id = this.activeHand.toActPlayerId;
    if (!id) return;
    const configured = this.turnTimerSeconds;
    /** 0 or negative = use default 20s so the table never waits forever. */
    const sec =
      configured > 0 ? Math.min(120, configured) : 20;
    const m = this.members.get(id);
    if (m?.isBot) return;
    this.turnDeadlineMs = Date.now() + sec * 1000;
    this.turnActTimer = setTimeout(() => {
      void (async () => {
        this.turnActTimer = null;
        try {
          if (!this.activeHand || this.activeHand.handComplete) return;
          if (this.activeHand.toActPlayerId !== id) return;
          try {
            this.activeHand.applyTurnTimeoutAction(id);
          } catch {
            if (
              this.activeHand &&
              !this.activeHand.handComplete &&
              this.activeHand.toActPlayerId === id
            ) {
              try {
                this.activeHand.fold(id);
              } catch {
                /* race: no longer to act */
              }
            }
          }
          void this.audit(id, "turn_timeout", {});
          if (this.activeHand.handComplete) await this.finalizeHand();
          await this.persist();
          this.broadcast();
        } catch (e) {
          console.error("[turn-timeout]", e);
        }
      })();
    }, sec * 1000);
  }

  /** Run check/call for CPU seats after a short delay; chains until a human acts. */
  scheduleBotTurns(): void {
    this.clearBotTimer();
    if (!this.activeHand || this.activeHand.handComplete) return;
    const id = this.activeHand.toActPlayerId;
    if (!id) return;
    const m = this.members.get(id);
    if (!m?.isBot) return;
    this.botTimer = setTimeout(() => {
      void (async () => {
        this.botTimer = null;
        try {
          if (!this.activeHand || this.activeHand.handComplete) return;
          this.activeHand.applySimpleBotAction(id);
          if (this.activeHand.handComplete) await this.finalizeHand();
          await this.persist();
          this.broadcast();
        } catch (e) {
          console.error("[bot]", e);
        }
      })();
    }, 400);
  }

  seatedPlayers(): RoomMember[] {
    return [...this.members.values()].filter(
      (m) =>
        m.seatIndex !== null &&
        m.approved &&
        m.chips > 0 &&
        !m.sittingOut,
    );
  }

  startHand(hostId: string): void {
    if (hostId !== this.hostPlayerId) throw new Error("not_host");
    const seated = this.seatedPlayers();
    if (seated.length < 2) throw new Error("need_2_players");
    if (this.activeHand && !this.activeHand.handComplete) {
      throw new Error("hand_active");
    }
    this.clearAllActionTimers();
    const seats = [...new Set(seated.map((s) => s.seatIndex!))].sort(
      (a, b) => a - b,
    );
    let btn = this.lastButtonSeat;
    if (btn === null || !seats.includes(btn)) {
      btn = seats[0]!;
    } else {
      const idx = seats.indexOf(btn);
      btn = seats[(idx + 1) % seats.length]!;
    }
    this.lastButtonSeat = btn;
    const hp = seated.map((s) => ({
      playerId: s.playerId,
      seatIndex: s.seatIndex!,
      chips: s.chips,
      hole: null,
      folded: false,
      betThisStreet: 0,
      totalCommittedHand: 0,
      allIn: false,
    }));
    const seatSet = new Set<number>();
    for (const row of hp) {
      const si = Number(row.seatIndex);
      if (seatSet.has(si)) {
        throw new Error("duplicate_seat");
      }
      seatSet.add(si);
    }
    this.activeHand = new PokerHand(
      hp,
      btn,
      this.smallBlind,
      this.bigBlind,
      this.antesEnabled ? this.anteAmount : 0,
    );
    void this.audit(hostId, "hand_start", { buttonSeat: btn });
  }

  async applyPokerAction(
    playerId: string,
    action: "fold" | "check" | "call" | "raise",
    raiseTo?: number,
  ): Promise<void> {
    if (!this.activeHand || this.activeHand.handComplete) {
      throw new Error("no_hand");
    }
    if (action === "fold") this.activeHand.fold(playerId);
    else if (action === "check") this.activeHand.check(playerId);
    else if (action === "call") this.activeHand.call(playerId);
    else {
      if (raiseTo === undefined) throw new Error("need_raise_to");
      this.activeHand.raise(playerId, raiseTo);
    }
    if (this.activeHand.handComplete) {
      await this.finalizeHand();
    }
  }

  private async finalizeHand(): Promise<void> {
    this.clearAllActionTimers();
    if (!this.activeHand?.winners) return;
    const handId = `hand_${Date.now()}`;
    const totals = this.activeHand.exportChipTotals();
    for (const t of totals) {
      const m = this.members.get(t.playerId);
      if (m) m.chips = t.chips;
    }
    const summary = this.activeHand.getSummary();
    if (summary) {
      this.handsPlayed += 1;
      const players = summary.players.map((p) => {
        const m = this.members.get(p.playerId);
        return {
          playerId: p.playerId,
          username: m?.username ?? p.playerId.slice(0, 6),
          email: m?.email ?? null,
          seatIndex: p.seatIndex,
          hole: p.hole,
          totalIn: p.totalIn,
          won: p.won,
          net: p.net,
          handLabel: p.handLabel,
          folded: p.folded,
        };
      });
      const winners = summary.winners.map((w) => ({
        playerId: w.playerId,
        username:
          this.members.get(w.playerId)?.username ?? w.playerId.slice(0, 6),
        amount: w.amount,
        hand: w.hand ?? null,
      }));
      try {
        await HandHistory.create({
          gameId: this.gameId,
          handIndex: this.handsPlayed,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          smallBlind: this.smallBlind,
          bigBlind: this.bigBlind,
          anteAmount: this.antesEnabled ? this.anteAmount : 0,
          board: summary.board,
          pot: summary.pot,
          players,
          winners,
          endedByFold: summary.endedByFold,
        });
      } catch (e) {
        console.error("[hand-history persist]", e);
      }
    }
    for (const w of this.activeHand.winners) {
      const bal = this.members.get(w.playerId)?.chips ?? null;
      await this.appendLedger(
        w.playerId,
        "pot_award",
        w.amount,
        bal,
        handId,
        { handId, category: w.hand, handIndex: this.handsPlayed },
      );
    }
    await this.audit(null, "hand_complete", {
      winners: this.activeHand.winners,
      handId,
      handIndex: this.handsPlayed,
    });
    this.activeHand = null;
    await this.persist();
  }

  updateHostGameSettings(
    actorId: string,
    patch: {
      smallBlind?: number;
      bigBlind?: number;
      turnTimerSeconds?: number;
      autoStartHand?: boolean;
      antesEnabled?: boolean;
      anteAmount?: number;
      useCentsDisplay?: boolean;
      rabbitHunting?: boolean;
      runItTwice?: "off" | "always" | "ask";
      utgStraddleAllowed?: boolean;
      revealWithNoAction?: boolean;
      spectatorsAllowed?: boolean;
    },
  ): void {
    if (actorId !== this.hostPlayerId) throw new Error("not_host");
    if (this.activeHand && !this.activeHand.handComplete) {
      throw new Error("hand_active");
    }
    if (patch.smallBlind !== undefined) {
      const v = Math.floor(patch.smallBlind);
      if (v < 1 || v > 50_000) throw new Error("bad_sb");
      this.smallBlind = v;
    }
    if (patch.bigBlind !== undefined) {
      const v = Math.floor(patch.bigBlind);
      if (v < 1 || v > 50_000) throw new Error("bad_bb");
      this.bigBlind = v;
    }
    if (this.bigBlind < this.smallBlind) {
      this.bigBlind = this.smallBlind;
    }
    if (patch.turnTimerSeconds !== undefined) {
      const t = Math.floor(patch.turnTimerSeconds);
      this.turnTimerSeconds = Math.max(0, Math.min(120, t));
    }
    if (patch.autoStartHand !== undefined) {
      this.autoStartHand = patch.autoStartHand;
    }
    if (patch.antesEnabled !== undefined) {
      this.antesEnabled = patch.antesEnabled;
    }
    if (patch.anteAmount !== undefined) {
      const a = Math.floor(patch.anteAmount);
      if (a < 0 || a > 50_000) throw new Error("bad_ante");
      this.anteAmount = a;
    }
    if (this.antesEnabled && this.anteAmount > this.bigBlind * 50) {
      throw new Error("ante_too_large");
    }
    if (patch.useCentsDisplay !== undefined) {
      this.useCentsDisplay = patch.useCentsDisplay;
    }
    if (patch.rabbitHunting !== undefined) {
      this.rabbitHunting = patch.rabbitHunting;
    }
    if (patch.runItTwice !== undefined) {
      this.runItTwice = normalizeRunItTwice(patch.runItTwice);
    }
    if (patch.utgStraddleAllowed !== undefined) {
      this.utgStraddleAllowed = patch.utgStraddleAllowed;
    }
    if (patch.revealWithNoAction !== undefined) {
      this.revealWithNoAction = patch.revealWithNoAction;
    }
    if (patch.spectatorsAllowed !== undefined) {
      this.spectatorsAllowed = patch.spectatorsAllowed;
    }
  }

  getHandPublic(): HandPublic | null {
    return this.activeHand ? this.activeHand.getPublic() : null;
  }

  buildGameState(
    viewerPlayerId: string | null,
    isObserver: boolean,
  ): Record<string, unknown> {
    const rawHand = this.getHandPublic();
    const boardForLabel = rawHand?.board ?? [];
    const players: PublicPlayer[] = [...this.members.values()].map((m) => {
      const ws = this.sockets.get(m.playerId);
      const inHand = this.activeHand
        ? this.activeHand.isContesting(m.playerId)
        : false;
      const base: PublicPlayer = {
        playerId: m.playerId,
        username: m.username,
        seatIndex: m.seatIndex,
        chips: m.chips,
        isHost: m.isHost,
        approved: m.approved,
        connected:
          !!m.isBot ||
          (ws !== undefined && ws.readyState === ws.OPEN),
        pendingRequest: m.pendingRequest,
        inHand,
        isBot: !!m.isBot,
        sittingOut: !!m.sittingOut,
      };
      if (
        !isObserver &&
        viewerPlayerId === m.playerId &&
        this.activeHand
      ) {
        const hc = this.activeHand.getHoleCards(m.playerId);
        if (hc) {
          base.holeCards = hc;
          if (boardForLabel.length >= 3) {
            try {
              const hole: [Card, Card] = [
                parseCard(hc[0]),
                parseCard(hc[1]),
              ];
              const boardCards = boardForLabel.map((c) => parseCard(c));
              const best = bestHandFromHoleBoard(hole, boardCards);
              if (best) base.madeHandLabel = formatHandShortLabel(best);
            } catch {
              /* ignore bad card payloads */
            }
          }
        }
      } else if (
        hostSeesAllEnabled() &&
        !isObserver &&
        viewerPlayerId === this.hostPlayerId &&
        this.activeHand &&
        inHand
      ) {
        // Godmode: send every contesting player's hole cards to the host.
        // No madeHandLabel — that'd leak board-aware analysis the host can do
        // mentally and avoids extra server work per broadcast.
        const hc = this.activeHand.getHoleCards(m.playerId);
        if (hc) base.holeCards = hc;
      }
      return base;
    });
    const hand =
      rawHand === null
        ? null
        : { ...rawHand, turnExpiresAt: this.turnDeadlineMs };
    return {
      gameId: this.gameId,
      players,
      pendingRequests: this.getPendingRequests(),
      hand,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      turnTimerSeconds: this.turnTimerSeconds,
      actionClockSeconds:
        this.turnTimerSeconds > 0
          ? Math.min(120, this.turnTimerSeconds)
          : 20,
      autoStartHand: this.autoStartHand,
      gameRules: {
        antesEnabled: this.antesEnabled,
        anteAmount: this.anteAmount,
        useCentsDisplay: this.useCentsDisplay,
        rabbitHunting: this.rabbitHunting,
        runItTwice: this.runItTwice,
        utgStraddleAllowed: this.utgStraddleAllowed,
        revealWithNoAction: this.revealWithNoAction,
        spectatorsAllowed: this.spectatorsAllowed,
      },
      hostPlayerId: this.hostPlayerId,
      hostSeesAll: hostSeesAllEnabled(),
    };
  }

  private pushGameState(): void {
    for (const [pid, ws] of this.sockets) {
      send(ws, {
        type: "game_state",
        payload: this.buildGameState(pid, false),
      });
    }
    for (const ws of this.observerSockets) {
      send(ws, {
        type: "game_state",
        payload: this.buildGameState(null, true),
      });
    }
    this.scheduleTurnAct();
    this.scheduleBotTurns();
  }

  /** When enabled, deals in once host and ≥1 other approved player are seated with chips. */
  private tryAutoStartHandAfterBroadcast(): void {
    if (this.activeHand) return;
    if (!this.autoStartHand) return;
    const seated = this.seatedPlayers();
    const hostSeated = seated.some((s) => s.playerId === this.hostPlayerId);
    if (!hostSeated || seated.length < 2) return;
    try {
      this.startHand(this.hostPlayerId);
      void this.persist();
      this.pushGameState();
    } catch {
      /* need_2_players, hand_active */
    }
  }

  broadcast(): void {
    this.pushGameState();
    this.tryAutoStartHandAfterBroadcast();
  }

  /** @internal — jwt secret stored for token refresh paths */
  get _secret(): string {
    return this.jwtSecret;
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private jwtSecret: string;

  constructor(secret: string) {
    this.jwtSecret = secret;
  }

  getSecret(): string {
    return this.jwtSecret;
  }

  async getOrLoad(gameId: string): Promise<Room | null> {
    const hit = this.rooms.get(gameId);
    if (hit) return hit;
    const r = await loadRoomFromDb(gameId, this.jwtSecret);
    if (r) this.rooms.set(gameId, r);
    return r;
  }

  setRoom(r: Room): void {
    this.rooms.set(r.gameId, r);
  }

  get(gameId: string): Room | undefined {
    return this.rooms.get(gameId);
  }
}

export async function loadRoomFromDb(
  gameId: string,
  jwtSecret: string,
): Promise<Room | null> {
  const doc = await Game.findOne({ gameId }).lean();
  if (!doc || Array.isArray(doc)) return null;
  const g = doc as unknown as {
    gameId: string;
    hostPlayerId: string;
    hostUsername: string;
    hostEmail?: string | null;
    smallBlind: number;
    bigBlind: number;
    turnTimerSeconds?: number;
    autoStartHand?: boolean;
    handsPlayed?: number;
    players: GamePlayerDoc[];
  };
  return Room.fromDoc(
    {
      gameId: g.gameId,
      hostPlayerId: g.hostPlayerId,
      hostUsername: g.hostUsername,
      hostEmail: g.hostEmail ?? null,
      smallBlind: g.smallBlind,
      bigBlind: g.bigBlind,
      turnTimerSeconds: g.turnTimerSeconds ?? 20,
      autoStartHand: g.autoStartHand !== false,
      handsPlayed: g.handsPlayed ?? 0,
      antesEnabled: (g as { antesEnabled?: boolean }).antesEnabled === true,
      anteAmount: Math.max(
        0,
        Math.floor(Number((g as { anteAmount?: number }).anteAmount ?? 0)),
      ),
      useCentsDisplay: (g as { useCentsDisplay?: boolean }).useCentsDisplay === true,
      rabbitHunting: (g as { rabbitHunting?: boolean }).rabbitHunting === true,
      runItTwice: (g as { runItTwice?: string }).runItTwice,
      utgStraddleAllowed:
        (g as { utgStraddleAllowed?: boolean }).utgStraddleAllowed === true,
      revealWithNoAction:
        (g as { revealWithNoAction?: boolean }).revealWithNoAction !== false,
      spectatorsAllowed:
        (g as { spectatorsAllowed?: boolean }).spectatorsAllowed !== false,
      players: g.players,
    },
    jwtSecret,
  );
}

export { connectDb, seedAdminUsers, signSession, verifySession };
