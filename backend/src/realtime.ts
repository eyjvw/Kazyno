import type { Server } from "bun";
import { sql } from "./db";

// Holds the running Bun server so any module can publish to ws topics.
let server: Server<unknown> | null = null;

export function setServer(s: Server<unknown>)
{
	server = s;
}

export function getServer(): Server<unknown> | null
{
	return server;
}

export interface OnlineUser
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
}

// userId -> { open connection count, cached profile }. Multi-tab safe.
const online = new Map<number, { count: number; user: OnlineUser }>();

/** Mark a new connection for a user; broadcasts when they come online. */
export async function addPresence(userId: number)
{
	const existing = online.get(userId);
	if (existing)
	{
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
export function removePresence(userId: number)
{
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

export function onlineList(): OnlineUser[]
{
	return [...online.values()].map((e) => e.user);
}

export function isOnline(id: number): boolean
{
	return online.has(id);
}

/** Push a user's new balance to all their open sockets. */
export function publishBalance(userId: number, points: number)
{
	server?.publish(`user:${userId}`, JSON.stringify({ type: "balance", points }));
}

/** Push an arbitrary event to one user's sockets (friend requests, etc). */
export function publishToUser(userId: number, payload: unknown)
{
	server?.publish(`user:${userId}`, JSON.stringify(payload));
}

/** Push to every connected socket (admin broadcast). */
export function publishBroadcast(payload: unknown)
{
	server?.publish("broadcast", JSON.stringify(payload));
}

/** Push a structured log event to all connected admins and persist to DB. */
export function publishAdminLog(event: Record<string, unknown>)
{
	const ts = Date.now();
	server?.publish(
		"admin-log",
		JSON.stringify({ type: "admin-log", ts, ...event }),
	);
	void sql`
		INSERT INTO admin_logs (ts, action, payload)
		VALUES (to_timestamp(${ts / 1000}), ${event.action as string}, ${event})
	`.catch(() => {});
}

/** Push the refreshed leaderboard to everyone watching.
 * Débouncé : chaque pari réglé l'appelle, sous charge ça ferait une requête
 * DB par mise. On coalesce en 1 push/seconde max. */
let lbTimer: ReturnType<typeof setTimeout> | null = null;
let lbLast = 0;
export async function publishLeaderboard()
{
	if (!server || lbTimer) return;
	const wait = Math.max(0, 1000 - (Date.now() - lbLast));
	lbTimer = setTimeout(() =>
	{
		lbTimer = null;
		lbLast = Date.now();
		void pushLeaderboardNow();
	}, wait);
}

async function pushLeaderboardNow()
{
	if (!server) return;
	const leaderboard = await sql`
		SELECT login, display_name, image_url, points, title, name_color
		FROM users
		ORDER BY points DESC, created_at ASC
		LIMIT 50
	`;
	server.publish("leaderboard", JSON.stringify({ type: "leaderboard", leaderboard }));
}
