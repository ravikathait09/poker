import mongoose, { Schema } from "mongoose";

export interface GamePlayerDoc {
  playerId: string;
  username: string;
  seatIndex: number | null;
  chips: number;
  isHost: boolean;
  approved: boolean;
  /** Optional contact captured at join time. Used for cross-game history rollups. */
  email?: string | null;
  /** Total chips bought-in (initial + host top-ups). */
  buyIn?: number;
}

export type RunItTwiceMode = "off" | "always" | "ask";

export interface GameDocument extends mongoose.Document {
  gameId: string;
  hostPlayerId: string;
  hostUsername: string;
  hostEmail?: string | null;
  smallBlind: number;
  bigBlind: number;
  /** Seconds for each action; 0 = no auto-timeout. Default 20. */
  turnTimerSeconds: number;
  /** When true, start a hand when host + ≥1 other are seated (no manual Start). */
  autoStartHand: boolean;
  antesEnabled: boolean;
  anteAmount: number;
  useCentsDisplay: boolean;
  rabbitHunting: boolean;
  runItTwice: RunItTwiceMode;
  utgStraddleAllowed: boolean;
  revealWithNoAction: boolean;
  spectatorsAllowed: boolean;
  /** Seconds winners/boards stay visible before auto-start (0–30). */
  showdownPresentationSeconds: number;
  /** When true, away/sitting-out seats still get dealt in. */
  dealToSittingOut: boolean;
  status: "lobby" | "playing" | "ended";
  players: GamePlayerDoc[];
  /** Cumulative count of hands dealt for this room. */
  handsPlayed?: number;
  createdAt: Date;
  updatedAt: Date;
}

const PlayerSchema = new Schema<GamePlayerDoc>(
  {
    playerId: { type: String, required: true },
    username: { type: String, required: true },
    seatIndex: { type: Number, default: null },
    chips: { type: Number, default: 1000 },
    isHost: { type: Boolean, default: false },
    approved: { type: Boolean, default: false },
    email: { type: String, default: null },
    buyIn: { type: Number, default: 0 },
  },
  { _id: false },
);

const GameSchema = new Schema<GameDocument>(
  {
    gameId: { type: String, required: true, unique: true, index: true },
    hostPlayerId: { type: String, required: true },
    hostUsername: { type: String, required: true },
    hostEmail: { type: String, default: null, index: true },
    smallBlind: { type: Number, default: 5 },
    bigBlind: { type: Number, default: 10 },
    turnTimerSeconds: { type: Number, default: 20 },
    autoStartHand: { type: Boolean, default: true },
    antesEnabled: { type: Boolean, default: false },
    anteAmount: { type: Number, default: 0 },
    useCentsDisplay: { type: Boolean, default: false },
    rabbitHunting: { type: Boolean, default: false },
    runItTwice: {
      type: String,
      enum: ["off", "always", "ask"],
      default: "off",
    },
    utgStraddleAllowed: { type: Boolean, default: false },
    revealWithNoAction: { type: Boolean, default: true },
    spectatorsAllowed: { type: Boolean, default: true },
    showdownPresentationSeconds: { type: Number, default: 3 },
    dealToSittingOut: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["lobby", "playing", "ended"],
      default: "lobby",
    },
    players: { type: [PlayerSchema], default: [] },
    handsPlayed: { type: Number, default: 0 },
  },
  { timestamps: true },
);

GameSchema.index({ "players.email": 1 });

export const Game =
  mongoose.models.Game ?? mongoose.model<GameDocument>("Game", GameSchema);

export interface HandHistoryPlayer {
  playerId: string;
  username: string;
  email?: string | null;
  seatIndex: number;
  /** Hole cards revealed at showdown; null if folded before showdown. */
  hole?: [string, string] | null;
  /** Chips committed during this hand. */
  totalIn: number;
  /** Chips won (0 if didn't win). */
  won: number;
  /** Net chip change for this hand (+won, -committed). */
  net: number;
  /** Hand category label at showdown (e.g. "two pair Aces and Kings"). */
  handLabel?: string | null;
  folded: boolean;
}

export interface HandHistoryDocument extends mongoose.Document {
  gameId: string;
  /** 1-based hand number for this room. */
  handIndex: number;
  startedAt: Date;
  endedAt: Date;
  smallBlind: number;
  bigBlind: number;
  anteAmount: number;
  /** Final community cards (run 1 / primary board). */
  board: string[];
  /** Second board when the hand was run twice. */
  secondBoard?: string[];
  pot: number;
  /** Per-player rollup with optional revealed hole cards. */
  players: HandHistoryPlayer[];
  /** Pot winners with amounts. */
  winners: { playerId: string; username: string; amount: number; hand?: string | null }[];
  /** True when finished by everyone folding except the winner (no showdown). */
  endedByFold: boolean;
  createdAt: Date;
}

const HandHistoryPlayerSchema = new Schema<HandHistoryPlayer>(
  {
    playerId: { type: String, required: true },
    username: { type: String, required: true },
    email: { type: String, default: null },
    seatIndex: { type: Number, required: true },
    hole: { type: [String], default: null },
    totalIn: { type: Number, default: 0 },
    won: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    handLabel: { type: String, default: null },
    folded: { type: Boolean, default: false },
  },
  { _id: false },
);

const HandHistoryWinnerSchema = new Schema(
  {
    playerId: { type: String, required: true },
    username: { type: String, required: true },
    amount: { type: Number, required: true },
    hand: { type: String, default: null },
  },
  { _id: false },
);

const HandHistorySchema = new Schema<HandHistoryDocument>(
  {
    gameId: { type: String, required: true, index: true },
    handIndex: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    smallBlind: { type: Number, default: 0 },
    bigBlind: { type: Number, default: 0 },
    anteAmount: { type: Number, default: 0 },
    board: { type: [String], default: [] },
    secondBoard: { type: [String], default: [] },
    pot: { type: Number, default: 0 },
    players: { type: [HandHistoryPlayerSchema], default: [] },
    winners: { type: [HandHistoryWinnerSchema], default: [] },
    endedByFold: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

HandHistorySchema.index({ gameId: 1, handIndex: -1 });
HandHistorySchema.index({ gameId: 1, createdAt: -1 });
HandHistorySchema.index({ "players.email": 1 });

export const HandHistory =
  mongoose.models.HandHistory ??
  mongoose.model<HandHistoryDocument>("HandHistory", HandHistorySchema);

export type LedgerType =
  | "buy_in"
  | "pot_award"
  | "adjustment"
  | "rebuy"
  | "cash_out";

export interface LedgerEntryDocument extends mongoose.Document {
  gameId: string;
  playerId: string | null;
  type: LedgerType;
  amount: number;
  balanceAfter: number | null;
  ref: string | null;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const LedgerEntrySchema = new Schema<LedgerEntryDocument>(
  {
    gameId: { type: String, required: true, index: true },
    playerId: { type: String, default: null },
    type: {
      type: String,
      enum: ["buy_in", "pot_award", "adjustment", "rebuy", "cash_out"],
      required: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, default: null },
    ref: { type: String, default: null },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

LedgerEntrySchema.index({ gameId: 1, createdAt: 1 });

export const LedgerEntry =
  mongoose.models.LedgerEntry ??
  mongoose.model<LedgerEntryDocument>("LedgerEntry", LedgerEntrySchema);

export interface AuditLogDocument extends mongoose.Document {
  gameId: string | null;
  actor: string | null;
  event: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<AuditLogDocument>(
  {
    gameId: { type: String, default: null, index: true },
    actor: { type: String, default: null },
    event: { type: String, required: true },
    detail: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ gameId: 1, createdAt: -1 });

export const AuditLog =
  mongoose.models.AuditLog ??
  mongoose.model<AuditLogDocument>("AuditLog", AuditLogSchema);

export interface UserDocument extends mongoose.Document {
  username: string;
  role: "user" | "admin";
  passwordHash: string | null;
  createdAt: Date;
}

const UserSchema = new Schema<UserDocument>(
  {
    username: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    passwordHash: { type: String, default: null },
  },
  { timestamps: true },
);

export const User =
  mongoose.models.User ?? mongoose.model<UserDocument>("User", UserSchema);

let connected = false;

export async function connectDb(uri: string): Promise<void> {
  if (connected) return;
  await mongoose.connect(uri);
  connected = true;
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
