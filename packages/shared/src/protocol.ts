import { z } from "zod";

/** WebSocket protocol v1 — see docs/WS_PROTOCOL.md */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("hello"),
    token: z.string(),
  }),
  z.object({
    type: z.literal("request_join"),
    username: z.string().min(1).max(32),
    email: z.string().email().max(120).optional(),
  }),
  z.object({
    type: z.literal("host_decision"),
    playerId: z.string(),
    approve: z.boolean(),
  }),
  z.object({
    type: z.literal("take_seat"),
    seatIndex: z.number().int().min(0).max(8),
  }),
  z.object({ type: z.literal("leave_seat") }),
  z.object({
    type: z.literal("sit_out"),
    away: z.boolean(),
  }),
  z.object({
    type: z.literal("start_hand"),
  }),
  z.object({
    type: z.literal("poker_action"),
    action: z.enum(["fold", "check", "call", "raise"]),
    raiseTo: z.number().optional(),
  }),
  z.object({
    type: z.literal("chat"),
    text: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("host_game_settings"),
    smallBlind: z.number().int().min(1).max(50_000).optional(),
    bigBlind: z.number().int().min(1).max(50_000).optional(),
    turnTimerSeconds: z.number().int().min(0).max(120).optional(),
    autoStartHand: z.boolean().optional(),
    antesEnabled: z.boolean().optional(),
    anteAmount: z.number().int().min(0).max(50_000).optional(),
    useCentsDisplay: z.boolean().optional(),
    rabbitHunting: z.boolean().optional(),
    runItTwice: z.enum(["off", "always", "ask"]).optional(),
    utgStraddleAllowed: z.boolean().optional(),
    revealWithNoAction: z.boolean().optional(),
    spectatorsAllowed: z.boolean().optional(),
    /** Seconds to leave winners / boards on the felt before auto-start. */
    showdownPresentationSeconds: z.number().int().min(0).max(30).optional(),
    /** When true, seated "away" players still receive hole cards and post blinds. */
    dealToSittingOut: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("run_it_twice_vote"),
    yes: z.boolean(),
  }),
  z.object({
    type: z.literal("admin_observe"),
    adminSecret: z.string(),
    gameId: z.string(),
  }),
  z.object({
    type: z.literal("host_top_up"),
    playerId: z.string(),
    amount: z.number().int().min(1).max(1_000_000),
  }),
  /** Local/testing: only accepted when realtime has GANGA_DEV_BOTS=1 */
  z.object({
    type: z.literal("dev_add_test_bot"),
    count: z.number().int().min(1).max(6).optional(),
  }),
]);

export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export type WsServerMessage =
  | { type: "welcome"; playerId: string; role: string; gameId: string }
  | { type: "error"; message: string; code?: string }
  | { type: "game_state"; payload: unknown }
  | { type: "pong" }
  | { type: "audit"; event: string; detail?: unknown }
  | {
      type: "chat";
      playerId: string;
      username: string;
      text: string;
      at: number;
    };

export const MAX_SEATS = 9;

export type GamePhase = "lobby" | "between_hands" | "hand" | "showdown" | "ended";

export interface PublicPlayer {
  playerId: string;
  username: string;
  seatIndex: number | null;
  chips: number;
  isHost: boolean;
  approved: boolean;
  connected: boolean;
  pendingRequest: boolean;
  inHand: boolean;
  /** CPU players for local testing (GANGA_DEV_BOTS) */
  isBot?: boolean;
  /** Observer only: hole cards hidden */
  holeCards?: [string, string] | null;
  /** Viewer only: short made-hand label (e.g. HIGH CARD) once board is flop+ */
  madeHandLabel?: string;
  /** Player chose "I'm away"; keeps seat but is skipped on next deal. */
  sittingOut?: boolean;
}

export interface JoinRequestInfo {
  playerId: string;
  username: string;
}
