import { Elysia } from "elysia";
import { jwtVerify } from "jose";
import { sql } from "./db";
import { addPresence, removePresence } from "./realtime";
import { roomViewJSON } from "./blackjack";

const secret = new TextEncoder().encode(
	process.env.SESSION_SECRET ?? "dev-insecure-change-me",
);
const ADMINS = (process.env.ADMIN_LOGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

// Verify the session JWT carried in the cookie header, return the user id.
async function userIdFromCookie(cookieHeader?: string): Promise<number | null>
{
	if (!cookieHeader) return null;
	const m = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
	if (!m) return null;
	try
	{
		const { payload } = await jwtVerify(decodeURIComponent(m[1]), secret);
		return payload.sub ? Number(payload.sub) : null;
	} catch {
		return null;
	}
}

// Live channel: each socket subscribes to its own balance topic + leaderboard.
export const realtimeWs = new Elysia().ws("/api/ws", {
	async open(ws)
	{
		const cookie = (ws.data.headers as Record<string, string | undefined>)
			?.cookie;
		const id = await userIdFromCookie(cookie);
		if (!id)
		{
			ws.close();
			return;
		}
		(ws.data as { userId?: number }).userId = id;
		ws.subscribe(`user:${id}`);
		ws.subscribe("leaderboard");
		ws.subscribe("presence");
		ws.subscribe("broadcast");
		await addPresence(id);
		const rows = (await sql`SELECT points, login FROM users WHERE id = ${id}`) as Array<{
			points: number; login: string;
		}>;
		if (rows[0])
		{
			ws.send(JSON.stringify({ type: "balance", points: rows[0].points }));
			if (ADMINS.includes(rows[0].login.toLowerCase()))
			{
				ws.subscribe("admin-log");
			}
		}
	},
	message(ws, raw)
	{
		type WsMessage = { type?: string; id?: string };
		let msg: WsMessage;
		try
		{
			msg = (typeof raw === "string" ? JSON.parse(raw) : raw) as WsMessage;
		} catch {
			return;
		}
		// Subscribe/unsubscribe to a blackjack room channel.
		if (msg?.type === "room:sub" && msg.id)
		{
			ws.subscribe(`room:${msg.id}`);
			const view = roomViewJSON(String(msg.id));
			if (view) ws.send(view);
		}
		else if (msg?.type === "room:unsub" && msg.id)
		{
			ws.unsubscribe(`room:${msg.id}`);
		}
		else if (msg?.type === "crash:sub")
		{
			ws.subscribe("crash");
			import("./crash").then(({ getCrashStateJSON }) => ws.send(getCrashStateJSON())).catch(() => {});
		}
		else if (msg?.type === "crash:unsub")
		{
			ws.unsubscribe("crash");
		}
	},
	close(ws)
	{
		const id = (ws.data as { userId?: number }).userId;
		if (id) removePresence(id);
	},
});
