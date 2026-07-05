import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishToUser } from "./realtime";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

export interface Sender
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
}
interface NotifOpts
{
	kind: string;
	message: string;
	from?: Sender | null;
	link?: string | null;
}

// Maps a notification kind to the user-facing preference category that gates
// it. Kinds not listed here ("reward" = gains personnels one-shot : piscine,
// core, coalition, trésor, giveaway gagné) are always sent.
const CATEGORY_BY_KIND: Record<string, string> = {
	admin: "admin",
	giveaway: "giveaway",
	exam: "exam",
	duel: "social",
	bj_invite: "social",
	friend_request: "social",
	friend_accepted: "social",
	gift: "social",
};

/** Persist a notification for one user and push it live, unless they opted out of this category. */
export async function pushNotif(userId: number, o: NotifOpts)
{
	const category = CATEGORY_BY_KIND[o.kind];
	if (category)
	{
		const rows = (await sql`
			SELECT COALESCE((notif_prefs->>${category})::boolean, true) AS allowed
			FROM users WHERE id = ${userId}
		`) as Array<{ allowed: boolean }>;
		if (!rows[0]?.allowed) return;
	}

	const f = o.from ?? null;
	const rows = (await sql`
		INSERT INTO notifications (user_id, kind, message, from_id, from_login, from_name, from_image, link)
		VALUES (${userId}, ${o.kind}, ${o.message}, ${f?.id ?? null}, ${f?.login ?? null},
						${f?.display_name ?? null}, ${f?.image_url ?? null}, ${o.link ?? null})
		RETURNING id, kind, message, from_login, from_name, from_image, link, read, created_at
	`) as unknown[];
	publishToUser(userId, { type: "notification", notif: rows[0] });
}

/** Persist a notification for every opted-in user and push a live signal to each of them. */
export async function pushNotifAll(o: NotifOpts)
{
	const category = CATEGORY_BY_KIND[o.kind] ?? null;
	const f = o.from ?? null;
	const rows = (await sql`
		INSERT INTO notifications (user_id, kind, message, from_id, from_login, from_name, from_image, link)
		SELECT id, ${o.kind}, ${o.message}, ${f?.id ?? null}, ${f?.login ?? null},
					 ${f?.display_name ?? null}, ${f?.image_url ?? null}, ${o.link ?? null}
		FROM users
		WHERE CAST(${category} AS text) IS NULL OR COALESCE((notif_prefs->>${category})::boolean, true)
		RETURNING user_id
	`) as Array<{ user_id: number }>;

	const notif = {
		kind: o.kind,
		message: o.message,
		from_login: f?.login ?? null,
		from_name: f?.display_name ?? null,
		from_image: f?.image_url ?? null,
		link: o.link ?? null,
		read: false,
		created_at: new Date().toISOString(),
	};
	for (const r of rows) publishToUser(r.user_id, { type: "notification", notif });
}

export const notifications = new Elysia({ prefix: "/api/notifications" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})
	.onBeforeHandle(({ userId, set }) =>
	{
		if (!userId)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
	})

	.get("/", async ({ userId }) =>
	{
		const items = (await sql`
			SELECT id, kind, message, from_login, from_name, from_image, link, read, created_at
			FROM notifications WHERE user_id=${userId}
			ORDER BY created_at DESC LIMIT 30
		`) as unknown[];
		const cnt = (await sql`
			SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=${userId} AND read=false
		`) as Array<{ n: number }>;
		return { items, unread: cnt[0].n };
	})

	.post("/read", async ({ userId }) =>
	{
		await sql`UPDATE notifications SET read=true WHERE user_id=${userId} AND read=false`;
		return { ok: true };
	})

	.delete("/:id", async ({ userId, params }) =>
	{
		await sql`DELETE FROM notifications WHERE id=${Number(params.id)} AND user_id=${userId}`;
		return { ok: true };
	})

	.delete("/", async ({ userId }) =>
	{
		await sql`DELETE FROM notifications WHERE user_id=${userId}`;
		return { ok: true };
	});
