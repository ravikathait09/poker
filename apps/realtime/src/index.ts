import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  WsClientMessageSchema,
  verifySession,
  type Role,
} from "@ganga/shared";
import dotenv from "dotenv";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import {
  RoomManager,
  connectDb,
  seedAdminUsers,
} from "./room.js";

dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

const PORT = Number(process.env.REALTIME_PORT ?? 4001);
const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/ganga-poker";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-insecure-secret-change-me!!!";
const DEV_BOTS = process.env.GANGA_DEV_BOTS === "1";

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

interface ClientCtx {
  gameId: string;
  playerId: string | null;
  role: Role;
  isObserver: boolean;
}

const manager = new RoomManager(JWT_SECRET);

await connectDb(MONGODB_URI);
await seedAdminUsers();

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ganga-poker realtime\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let ctx: ClientCtx | null = null;

  ws.on("message", async (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "error", message: "invalid_json" });
      return;
    }
    const parsedMsg = WsClientMessageSchema.safeParse(parsed);
    if (!parsedMsg.success) {
      send(ws, { type: "error", message: "invalid_message" });
      return;
    }
    const msg = parsedMsg.data;

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    if (msg.type === "hello") {
      try {
        const claims = await verifySession(JWT_SECRET, msg.token);
        if (claims.role === "admin") {
          const gid = claims.observeGameId ?? claims.gameId;
          if (!gid) {
            send(ws, {
              type: "error",
              message: "admin observation requires game id",
            });
            return;
          }
          const room = await manager.getOrLoad(gid);
          if (!room) {
            send(ws, { type: "error", message: "game_not_found" });
            return;
          }
          await room.refreshMembersFromDatabase();
          room.addObserver(ws);
          ctx = {
            gameId: gid,
            playerId: null,
            role: "admin",
            isObserver: true,
          };
          send(ws, {
            type: "welcome",
            playerId: claims.sub,
            role: "observer",
            gameId: gid,
          });
          send(ws, {
            type: "game_state",
            payload: room.buildGameState(null, true),
          });
          return;
        }

        const gid = claims.gameId;
        if (!gid) {
          send(ws, { type: "error", message: "missing_game" });
          return;
        }
        const room = await manager.getOrLoad(gid);
        if (!room) {
          send(ws, { type: "error", message: "game_not_found" });
          return;
        }
        await room.refreshMembersFromDatabase();
        const pid = claims.sub;
        room.bindSocket(pid, ws);
        ctx = {
          gameId: gid,
          playerId: pid,
          role: claims.role,
          isObserver: false,
        };
        send(ws, {
          type: "welcome",
          playerId: pid,
          role: claims.role,
          gameId: gid,
        });
        room.broadcast();
      } catch (e) {
        send(ws, {
          type: "error",
          message: e instanceof Error ? e.message : "auth_failed",
        });
      }
      return;
    }

    if (!ctx || ctx.isObserver) {
      send(ws, { type: "error", message: "unauthorized" });
      return;
    }

    const room = await manager.getOrLoad(ctx.gameId);
    if (!room) {
      send(ws, { type: "error", message: "room_missing" });
      return;
    }
    await room.refreshMembersFromDatabase();

    try {
      switch (msg.type) {
        case "request_join": {
          if (ctx.role !== "pending" || !ctx.playerId) {
            send(ws, { type: "error", message: "not_pending" });
            return;
          }
          const uname = msg.username.trim().slice(0, 32);
          const existingName = room.findMemberByUsername(uname);
          if (existingName && existingName.playerId !== ctx.playerId) {
            send(ws, { type: "error", message: "username_taken" });
            return;
          }
          const mem = room.getMember(ctx.playerId);
          const cleanEmail = msg.email?.trim().toLowerCase().slice(0, 120) ?? null;
          if (!mem) {
            room.addPendingGuest(ctx.playerId, uname, cleanEmail);
          } else {
            if (mem.pendingRequest && mem.username !== uname) {
              mem.username = uname;
            }
            if (cleanEmail) mem.email = cleanEmail;
          }
          await room.persist();
          room.broadcast();
          break;
        }
        case "host_decision": {
          if (ctx.role !== "host" || ctx.playerId !== room.hostPlayerId) {
            send(ws, { type: "error", message: "not_host" });
            return;
          }
          room.setApproved(msg.playerId, msg.approve, ctx.playerId);
          await room.persist();
          room.broadcast();
          break;
        }
        case "take_seat": {
          const m = room.getMember(ctx.playerId!);
          if (!m?.approved) {
            send(ws, { type: "error", message: "cannot_seat" });
            return;
          }
          room.takeSeat(ctx.playerId!, msg.seatIndex);
          await room.persist();
          room.broadcast();
          break;
        }
        case "leave_seat": {
          room.leaveSeat(ctx.playerId!);
          await room.persist();
          room.broadcast();
          break;
        }
        case "sit_out": {
          room.setSittingOut(ctx.playerId!, msg.away);
          room.broadcast();
          break;
        }
        case "host_top_up": {
          if (ctx.playerId !== room.hostPlayerId) {
            send(ws, { type: "error", message: "not_host" });
            return;
          }
          room.hostTopUp(ctx.playerId!, msg.playerId, msg.amount);
          await room.persist();
          room.broadcast();
          break;
        }
        case "start_hand": {
          if (ctx.playerId !== room.hostPlayerId) {
            send(ws, { type: "error", message: "not_host" });
            return;
          }
          room.startHand(ctx.playerId!);
          await room.persist();
          room.broadcast();
          break;
        }
        case "poker_action": {
          const m = room.getMember(ctx.playerId!);
          if (!m?.approved || m.seatIndex === null) {
            send(ws, { type: "error", message: "not_seated" });
            return;
          }
          room.applyPokerAction(
            ctx.playerId!,
            msg.action,
            msg.raiseTo,
          );
          await room.persist();
          room.broadcast();
          break;
        }
        case "dev_add_test_bot": {
          if (!DEV_BOTS) {
            send(ws, { type: "error", message: "dev_bots_disabled" });
            return;
          }
          if (ctx.playerId !== room.hostPlayerId) {
            send(ws, { type: "error", message: "not_host" });
            return;
          }
          room.addTestBots(msg.count ?? 1);
          await room.persist();
          room.broadcast();
          break;
        }
        case "chat": {
          const member = room.getMember(ctx.playerId!);
          if (!member) {
            send(ws, { type: "error", message: "unknown_player" });
            return;
          }
          const text = msg.text.trim().slice(0, 500);
          if (!text) return;
          room.fanout({
            type: "chat",
            playerId: ctx.playerId!,
            username: member.username,
            text,
            at: Date.now(),
          });
          break;
        }
        case "host_game_settings": {
          if (ctx.playerId !== room.hostPlayerId) {
            send(ws, { type: "error", message: "not_host" });
            return;
          }
          room.updateHostGameSettings(ctx.playerId!, {
            smallBlind: msg.smallBlind,
            bigBlind: msg.bigBlind,
            turnTimerSeconds: msg.turnTimerSeconds,
            autoStartHand: msg.autoStartHand,
            antesEnabled: msg.antesEnabled,
            anteAmount: msg.anteAmount,
            useCentsDisplay: msg.useCentsDisplay,
            rabbitHunting: msg.rabbitHunting,
            runItTwice: msg.runItTwice,
            utgStraddleAllowed: msg.utgStraddleAllowed,
            revealWithNoAction: msg.revealWithNoAction,
            spectatorsAllowed: msg.spectatorsAllowed,
          });
          await room.persist();
          room.broadcast();
          break;
        }
        case "admin_observe": {
          send(ws, { type: "error", message: "use_hello_admin_token" });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      send(ws, {
        type: "error",
        message: e instanceof Error ? e.message : "action_failed",
      });
    }
  });

  ws.on("close", () => {
    if (!ctx) return;
    const room = manager.get(ctx.gameId);
    if (room) {
      room.unbindSocket(ws);
      room.broadcast();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`realtime ws listening on 0.0.0.0:${PORT}`);
});

export { randomUUID };
