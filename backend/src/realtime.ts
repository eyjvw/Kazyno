import type { Server } from "bun";
import { sql } from "./db";

// Holds the running Bun server so any module can publish to ws topics.
let server: Server | null = null;

export function setServer(s: Server) {
  server = s;
}

export function getServer(): Server | null {
  return server;
}

export interface OnlineUser {
  id: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
}

// userId -> { open connection count, cached profile }. Multi-tab safe.
const online = new Map<number, { count: number; user: OnlineUser }>();

/** Mark a new connection for a user; broadcasts when they come online. */
export async function addPresence(userId: number) {
  const existing = online.get(userId);
  if (existing) {
    existing.count++;
    return;
  }
  const rows = (await sql`
    SELECT id, login, display_name, image_url FROM users WHERE id = ${userId}
  `) as OnlineUser[];
  if (!rows[0]) return;
  online.set(userId, { count: 1, user: rows[0] });
  server?.publish(
    "presence",
    JSON.stringify({ type: "presence", user: rows[0], online: true }),
  );
}

/** Drop a connection; broadcasts when the user goes fully offline. */
export function removePresence(userId: number) {
  const e = online.get(userId);
  if (!e) return;
  e.count--;
  if (e.count > 0) return;
  online.delete(userId);
  server?.publish(
    "presence",
    JSON.stringify({ type: "presence", user: e.user, online: false }),
  );
}

export function onlineList(): OnlineUser[] {
  return [...online.values()].map((e) => e.user);
}

export function isOnline(id: number): boolean {
  return online.has(id);
}

/** Push a user's new balance to all their open sockets. */
export function publishBalance(userId: number, points: number) {
  server?.publish(`user:${userId}`, JSON.stringify({ type: "balance", points }));
}

/** Push an arbitrary event to one user's sockets (friend requests, etc). */
export function publishToUser(userId: number, payload: unknown) {
  server?.publish(`user:${userId}`, JSON.stringify(payload));
}

/** Push to every connected socket (admin broadcast). */
export function publishBroadcast(payload: unknown) {
  server?.publish("broadcast", JSON.stringify(payload));
}

/** Push the refreshed leaderboard to everyone watching. */
export async function publishLeaderboard() {
  if (!server) return;
  const leaderboard = await sql`
    SELECT login, display_name, image_url, points
    FROM users
    ORDER BY points DESC, created_at ASC
    LIMIT 50
  `;
  server.publish("leaderboard", JSON.stringify({ type: "leaderboard", leaderboard }));
}
