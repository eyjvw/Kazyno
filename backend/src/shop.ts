import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard } from "./realtime";
import { pushNotif } from "./notifications";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// ── Cosmetic shop ─────────────────────────────────────────────────────────────
// Points sink: titles shown next to the name, and leaderboard name colors.

export interface ShopItem
{
	key: string;
	kind: "title" | "color";
	label: string;
	value: string; // title text or hex color
	price: number;
	exclusive?: boolean; // pas achetable — débloqué auto (collection complète)
}

export const ITEMS: ShopItem[] = [
	{ key: "title_lucky",     kind: "title", label: "Titre « Lucky »",        value: "Lucky",        price: 2_000 },
	{ key: "title_degen",     kind: "title", label: "Titre « Dégén »",        value: "Dégén",        price: 3_000 },
	{ key: "title_highroller",kind: "title", label: "Titre « High Roller »",  value: "High Roller",  price: 10_000 },
	{ key: "title_whale",     kind: "title", label: "Titre « Baleine »",      value: "Baleine 🐋",   price: 25_000 },
	{ key: "title_legend",    kind: "title", label: "Titre « Légende 42 »",   value: "Légende 42",   price: 50_000 },
	{ key: "title_pigeon",    kind: "title", label: "Titre « Pigeon »",       value: "Pigeon 🐦",    price: 1_500 },
	{ key: "title_norminet",  kind: "title", label: "Titre « Norminet »",     value: "Norminet 🐈",  price: 5_000 },
	{ key: "title_segfault",  kind: "title", label: "Titre « Segfault »",     value: "Segfault 💥",  price: 7_500 },
	{ key: "title_allin",     kind: "title", label: "Titre « All-in »",       value: "All-in ♠️",    price: 15_000 },
	{ key: "title_goat",      kind: "title", label: "Titre « GOAT »",         value: "GOAT 🐐",      price: 100_000 },
	{ key: "color_gold",      kind: "color", label: "Pseudo doré",            value: "#f59e0b",      price: 5_000 },
	{ key: "color_red",       kind: "color", label: "Pseudo rouge",           value: "#ef4444",      price: 3_000 },
	{ key: "color_green",     kind: "color", label: "Pseudo vert",            value: "#22c55e",      price: 3_000 },
	{ key: "color_purple",    kind: "color", label: "Pseudo violet",          value: "#a855f7",      price: 4_000 },
	{ key: "color_cyan",      kind: "color", label: "Pseudo cyan",            value: "#06b6d4",      price: 3_000 },
	{ key: "color_pink",      kind: "color", label: "Pseudo rose",            value: "#ec4899",      price: 4_000 },
	{ key: "color_rainbow",   kind: "color", label: "Pseudo arc-en-ciel",     value: "rainbow",      price: 20_000 },
	{ key: "color_fire",      kind: "color", label: "Pseudo enflammé",        value: "fire",         price: 20_000 },
	{ key: "color_ocean",     kind: "color", label: "Pseudo océan",           value: "ocean",        price: 20_000 },
	{ key: "color_galaxy",    kind: "color", label: "Pseudo galaxie",         value: "galaxy",       price: 20_000 },
	{ key: "color_toxic",     kind: "color", label: "Pseudo toxique",         value: "toxic",        price: 20_000 },
	// Récompense de collection : auto-débloqué quand on possède TOUT le catalogue.
	{ key: "title_collector", kind: "title", label: "Titre « Collectionneur »", value: "Collectionneur 👑", price: 0, exclusive: true },
];

const byKey = new Map(ITEMS.map((i) => [i.key, i]));
const BUYABLE_KEYS = ITEMS.filter((i) => !i.exclusive).map((i) => i.key);
const COLLECTOR_KEY = "title_collector";

/** Grants the collector title once the user owns the full catalog (idempotent). */
async function maybeGrantCollector(userId: number, ownedKeys: string[]): Promise<boolean>
{
	if (!BUYABLE_KEYS.every((k) => ownedKeys.includes(k))) return false;
	const granted = (await sql`
		INSERT INTO user_items (user_id, item_key) VALUES (${userId}, ${COLLECTOR_KEY})
		ON CONFLICT DO NOTHING
		RETURNING 1 AS ok
	`) as unknown[];
	if (granted.length)
	{
		await pushNotif(userId, {
			kind: "reward",
			message: "👑 Collection complète ! Titre exclusif « Collectionneur » débloqué",
			link: "/profile",
		});
	}
	return granted.length > 0;
}

export const shop = new Elysia({ prefix: "/api/shop" })
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

	// Catalog + what I own + what I have equipped.
	.get("/", async ({ userId }) =>
	{
		const owned = (await sql`
			SELECT item_key FROM user_items WHERE user_id = ${userId!}
		`) as Array<{ item_key: string }>;
		const ownedKeys = owned.map((o) => o.item_key);
		// Rattrapage : collection déjà complète mais titre pas encore accordé.
		if (!ownedKeys.includes(COLLECTOR_KEY) && await maybeGrantCollector(userId!, ownedKeys))
		{
			ownedKeys.push(COLLECTOR_KEY);
		}
		const [me] = (await sql`
			SELECT title, name_color, points FROM users WHERE id = ${userId!}
		`) as Array<{ title: string | null; name_color: string | null; points: number }>;
		return {
			items: ITEMS,
			owned: ownedKeys,
			equipped: { title: me.title, name_color: me.name_color },
			balance: me.points,
		};
	})

	.post(
		"/buy",
		async ({ body, userId, set }) =>
		{
			const item = byKey.get(body.key);
			if (!item)
			{
				set.status = 404;
				return { error: "objet inconnu" };
			}
			if (item.exclusive)
			{
				set.status = 403;
				return { error: "objet exclusif — se débloque, ne s'achète pas" };
			}
			const already = (await sql`
				SELECT 1 FROM user_items WHERE user_id = ${userId!} AND item_key = ${item.key}
			`) as unknown[];
			if (already[0])
			{
				set.status = 409;
				return { error: "déjà possédé" };
			}
			const rows = (await sql`
				UPDATE users SET points = points - ${item.price}
				WHERE id = ${userId!} AND points >= ${item.price}
				RETURNING points
			`) as Array<{ points: number }>;
			if (!rows[0])
			{
				set.status = 400;
				return { error: "solde insuffisant" };
			}
			await sql`
				INSERT INTO user_items (user_id, item_key) VALUES (${userId!}, ${item.key})
				ON CONFLICT DO NOTHING
			`;
			publishBalance(userId!, rows[0].points);
			void publishLeaderboard();

			// Collection complète après cet achat → titre Collectionneur.
			const ownedNow = (await sql`
				SELECT item_key FROM user_items WHERE user_id = ${userId!}
			`) as Array<{ item_key: string }>;
			void maybeGrantCollector(userId!, ownedNow.map((o) => o.item_key));

			return { ok: true, balance: rows[0].points };
		},
		{ body: t.Object({ key: t.String() }) },
	)

	// Equip an owned item, or pass kind + no key to unequip.
	.post(
		"/equip",
		async ({ body, userId, set }) =>
		{
			if (!body.key)
			{
				if (body.kind === "title") await sql`UPDATE users SET title = NULL WHERE id = ${userId!}`;
				else await sql`UPDATE users SET name_color = NULL WHERE id = ${userId!}`;
				void publishLeaderboard();
				return { ok: true };
			}
			const item = byKey.get(body.key);
			if (!item)
			{
				set.status = 404;
				return { error: "objet inconnu" };
			}
			const owned = (await sql`
				SELECT 1 FROM user_items WHERE user_id = ${userId!} AND item_key = ${item.key}
			`) as unknown[];
			if (!owned[0])
			{
				set.status = 403;
				return { error: "objet non possédé" };
			}
			if (item.kind === "title")
			{
				await sql`UPDATE users SET title = ${item.value} WHERE id = ${userId!}`;
			}
			else
			{
				await sql`UPDATE users SET name_color = ${item.value} WHERE id = ${userId!}`;
			}
			void publishLeaderboard();
			return { ok: true };
		},
		{
			body: t.Object({
				key: t.Optional(t.String()),
				kind: t.Optional(t.Union([t.Literal("title"), t.Literal("color")])),
			}),
		},
	);
