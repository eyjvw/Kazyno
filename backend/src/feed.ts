import { Elysia } from "elysia";
import { publishBroadcast } from "./realtime";

// ── Live win feed ─────────────────────────────────────────────────────────────
// Big wins are pushed to everyone and kept in a small ring buffer so a fresh
// page load can show recent activity.

export interface FeedItem
{
	login: string;
	display_name: string | null;
	game: string;
	bet: number;
	payout: number;
	ts: number;
}

const MAX = 30;
const items: FeedItem[] = [];

/** Called from recordStat for qualifying wins. */
export function pushFeed(item: FeedItem)
{
	items.unshift(item);
	if (items.length > MAX) items.pop();
	publishBroadcast({ type: "feed", item });
}

export const feedRoutes = new Elysia({ prefix: "/api/feed" })
	.get("/", () => ({ feed: items }));
