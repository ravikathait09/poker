import { SignJWT, jwtVerify } from "jose";

export type Role = "host" | "player" | "pending" | "admin";

export interface SessionClaims {
  sub: string;
  gameId: string | null;
  role: Role;
  observeGameId?: string | null;
}

const encoder = new TextEncoder();

export async function signSession(
  secret: string,
  claims: SessionClaims,
  expiresIn = "8h",
): Promise<string> {
  const key = encoder.encode(secret);
  return new SignJWT({
    gameId: claims.gameId,
    role: claims.role,
    observeGameId: claims.observeGameId ?? null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setExpirationTime(expiresIn)
    .sign(key);
}

export async function verifySession(
  secret: string,
  token: string,
): Promise<SessionClaims> {
  const key = encoder.encode(secret);
  const { payload } = await jwtVerify(token, key);
  const role = payload.role as Role;
  if (!["host", "player", "pending", "admin"].includes(role)) {
    throw new Error("invalid role");
  }
  return {
    sub: String(payload.sub ?? ""),
    gameId:
      payload.gameId !== undefined && payload.gameId !== null
        ? String(payload.gameId)
        : null,
    role,
    observeGameId:
      payload.observeGameId !== undefined && payload.observeGameId !== null
        ? String(payload.observeGameId)
        : null,
  };
}
