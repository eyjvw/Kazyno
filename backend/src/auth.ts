import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql, type PublicUser } from "./db";
import { rl, BUCKETS } from "./ratelimit";
import { applyCursus, maybeSyncUser, type FtExamLike } from "./cursussync";
import { redeemPendingTreasure } from "./treasurehunt"; // TEMPORAIRE — chasse au trésor

const FT_AUTHORIZE = "https://api.intra.42.fr/oauth/authorize";
const FT_TOKEN = "https://api.intra.42.fr/oauth/token";
const FT_ME = "https://api.intra.42.fr/v2/me";

const FT_UID = process.env.FT_UID ?? "";
const FT_SECRET = process.env.FT_SECRET ?? "";
const FT_REDIRECT_URI =
	process.env.FT_REDIRECT_URI ?? "http://localhost:8080/api/auth/callback";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:8080";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Campus gating: 42 Le Havre only. IDs via env (comma-separated), name match
// as safety net in case the ID list is wrong or missing.
const ALLOWED_CAMPUS_IDS = (process.env.ALLOWED_CAMPUS_IDS ?? "62")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter((n) => Number.isFinite(n));
const ALLOWED_CAMPUS_NAME = "le havre";

const PUBLIC_COLUMNS = sql`id, login, email, display_name, image_url, points, locale, show_presence, notif_prefs, welcomed, core_reward_seen, piscine_reward_seen`;

interface SessionCookie
{
	set(options: {
		value: string;
		httpOnly?: boolean;
		path?: string;
		maxAge?: number;
		sameSite?: "lax" | "strict" | "none";
		secure?: boolean;
	}): void;
}

function issueSession(session: SessionCookie, value: string)
{
	session.set({
		value,
		httpOnly: true,
		path: "/",
		maxAge: SESSION_MAX_AGE,
		sameSite: "lax",
	});
}

export const auth = new Elysia({ prefix: "/api/auth" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))

	// ── 42 OAuth: step 1, redirect to intra ──────────────────────────────────
	.get("/42", ({ headers, set, redirect, cookie: { oauth_state } }) =>
	{
		const ip = headers["x-real-ip"] ?? "unknown";
		const limited = rl(`auth:${ip}`, BUCKETS.auth, set);
		if (limited) return limited;
		if (!FT_UID) return new Response("FT_UID not configured", { status: 500 });
		const state = crypto.randomUUID();
		oauth_state.set({
			value: state,
			httpOnly: true,
			path: "/",
			maxAge: 600,
			sameSite: "lax",
		});
		const params = new URLSearchParams({
			client_id: FT_UID,
			redirect_uri: FT_REDIRECT_URI,
			response_type: "code",
			scope: "public",
			state,
		});
		return redirect(`${FT_AUTHORIZE}?${params.toString()}`);
	})

	// Alias so /api/auth/login also kicks off the 42 flow.
	.get("/login", ({ redirect }) => redirect(`${FRONTEND_ORIGIN}/api/auth/42`))

	// ── 42 OAuth: step 2, callback ───────────────────────────────────────────
	.get(
		"/callback",
		async ({ headers, set, query, jwt, redirect, cookie: { session, oauth_state } }) =>
		{
			const ip = headers["x-real-ip"] ?? "unknown";
			const limited = rl(`auth:${ip}`, BUCKETS.auth, set);
			if (limited) return limited;
			const code = query.code as string | undefined;
			const state = query.state as string | undefined;
			if (!code) return redirect(`${FRONTEND_ORIGIN}/?error=missing_code`);
			if (!state || state !== oauth_state.value)
			{
				return redirect(`${FRONTEND_ORIGIN}/?error=bad_state`);
			}
			oauth_state.remove();

			const tokenRes = await fetch(FT_TOKEN, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					grant_type: "authorization_code",
					client_id: FT_UID,
					client_secret: FT_SECRET,
					code,
					redirect_uri: FT_REDIRECT_URI,
				}),
			});
			if (!tokenRes.ok) return redirect(`${FRONTEND_ORIGIN}/?error=token_exchange`);
			const token = (await tokenRes.json()) as { access_token?: string };
			if (!token.access_token) return redirect(`${FRONTEND_ORIGIN}/?error=no_token`);

			const meRes = await fetch(FT_ME, {
				headers: { Authorization: `Bearer ${token.access_token}` },
			});
			if (!meRes.ok) return redirect(`${FRONTEND_ORIGIN}/?error=profile_fetch`);
			const me = (await meRes.json()) as {
				id: number;
				login: string;
				email?: string;
				displayname?: string;
				image?: { link?: string };
				campus?: Array<{ id: number; name: string }>;
				campus_users?: Array<{ campus_id: number; is_primary: boolean }>;
				cursus_users?: Array<{ cursus_id: number; grade: string | null }>;
				projects_users?: Array<{
					project: { name: string };
					status: string;
					"validated?": boolean | null;
				}>;
			};

			// Reserved to 42 Le Havre: primary campus (fallback: first listed).
			const primaryId =
				me.campus_users?.find((c) => c.is_primary)?.campus_id
				?? me.campus?.[0]?.id;
			const primaryCampus = me.campus?.find((c) => c.id === primaryId) ?? me.campus?.[0];
			const eligible =
				(primaryId !== undefined && ALLOWED_CAMPUS_IDS.includes(primaryId))
				|| (primaryCampus?.name ?? "").toLowerCase().includes(ALLOWED_CAMPUS_NAME);
			if (!eligible)
			{
				const campusName = encodeURIComponent(primaryCampus?.name ?? "");
				return redirect(`${FRONTEND_ORIGIN}/ineligible?campus=${campusName}`);
			}

			const rows = (await sql`
				INSERT INTO users (ft_id, login, email, display_name, image_url)
				VALUES (${me.id}, ${me.login}, ${me.email ?? null}, ${me.displayname ?? null}, ${me.image?.link ?? null})
				ON CONFLICT (ft_id) DO UPDATE SET
					login        = EXCLUDED.login,
					email        = EXCLUDED.email,
					display_name = EXCLUDED.display_name,
					image_url    = EXCLUDED.image_url
				RETURNING id, welcomed
			`) as Array<{ id: number; welcomed: boolean }>;
			const userId = rows[0].id;

			// Cursus signals: common core from the /v2/me payload, exam rank from
			// the user's real exam registrations (piscine + student exams).
			let regExams: FtExamLike[] | null = null;
			try
			{
				const exRes = await fetch(
					`https://api.intra.42.fr/v2/users/${me.id}/exams?filter%5Bfuture%5D=true&page%5Bsize%5D=30`,
					{ headers: { Authorization: `Bearer ${token.access_token}` } },
				);
				if (exRes.ok) regExams = (await exRes.json()) as FtExamLike[];
			}
			catch { /* exam_rank stays as-is; next 10-min sync retries */ }
			await applyCursus(userId, me, regExams);

			// TEMPORAIRE — gains chasse au trésor stockés avant le 1er login.
			void redeemPendingTreasure(userId, me.login);

			issueSession(session, await jwt.sign({ sub: String(userId) }));
			// First visit: onboarding page instead of the lobby.
			return redirect(`${FRONTEND_ORIGIN}${rows[0].welcomed ? "/app" : "/welcome"}`);
		},
	)

	// ── Current user from session cookie ─────────────────────────────────────
	.get("/me", async ({ jwt, cookie: { session }, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { authenticated: false };
		}
		const rows = (await sql`
			SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ${Number(payload.sub)}
		`) as PublicUser[];
		if (!rows[0])
		{
			set.status = 401;
			return { authenticated: false };
		}
		// Refresh 42 cursus signals in the background (throttled per user).
		void maybeSyncUser(rows[0].id);
		return { authenticated: true, user: rows[0] };
	})

	// Mark the common-core +2000 popup as dismissed.
	.post("/core-seen", async ({ jwt, cookie: { session }, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
		await sql`UPDATE users SET core_reward_seen = true WHERE id = ${Number(payload.sub)}`;
		return { ok: true };
	})

	// Mark the piscine +1000 popup as dismissed.
	.post("/piscine-seen", async ({ jwt, cookie: { session }, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
		await sql`UPDATE users SET piscine_reward_seen = true WHERE id = ${Number(payload.sub)}`;
		return { ok: true };
	})

	// Mark the onboarding page as seen.
	.post("/welcome", async ({ jwt, cookie: { session }, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
		await sql`UPDATE users SET welcomed = true WHERE id = ${Number(payload.sub)}`;
		return { ok: true };
	})

	.post("/logout", ({ cookie: { session } }) =>
	{
		session.remove();
		return { ok: true };
	})

	// ── Update the current user's preferred locale ───────────────────────────
	.patch("/locale", async ({ jwt, cookie: { session }, body, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
		if (body.locale !== "fr" && body.locale !== "en")
		{
			set.status = 422;
			return { error: "locale invalide" };
		}
		await sql`UPDATE users SET locale = ${body.locale} WHERE id = ${Number(payload.sub)}`;
		return { ok: true };
	}, { body: t.Object({ locale: t.String() }) })

	// ── Update notification/presence preferences (merged with existing) ─────
	.patch(
		"/prefs",
		async ({ jwt, cookie: { session }, body, set }) =>
		{
			const payload = session.value ? await jwt.verify(session.value as string) : false;
			if (!payload || !payload.sub)
			{
				set.status = 401;
				return { error: "non authentifie" };
			}
			const userId = Number(payload.sub);
			if (body.show_presence !== undefined)
			{
				await sql`UPDATE users SET show_presence = ${body.show_presence} WHERE id = ${userId}`;
			}
			if (body.notif_prefs)
			{
				// ::text::jsonb obligatoire — Bun.sql envoie le param en scalar jsonb
				// avec un simple ::jsonb, et objet || scalar = concat en array.
				await sql`
					UPDATE users SET notif_prefs = notif_prefs || ${JSON.stringify(body.notif_prefs)}::text::jsonb
					WHERE id = ${userId}
				`;
			}
			const rows = (await sql`
				SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ${userId}
			`) as PublicUser[];
			return { ok: true, user: rows[0] };
		},
		{
			body: t.Object({
				show_presence: t.Optional(t.Boolean()),
				notif_prefs: t.Optional(
					t.Partial(
						t.Object({
							rain: t.Boolean(),
							giveaway: t.Boolean(),
							social: t.Boolean(),
							exam: t.Boolean(),
							admin: t.Boolean(),
						}),
					),
				),
			}),
		},
	)

	// ── RGPD: permanently delete the account and its data ────────────────────
	.delete("/account", async ({ jwt, cookie: { session }, set }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		if (!payload || !payload.sub)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
		await sql`DELETE FROM users WHERE id = ${Number(payload.sub)}`;
		session.remove();
		return { ok: true };
	});
