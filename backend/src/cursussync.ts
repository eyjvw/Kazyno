import { sql } from "./db";
import { publishBalance } from "./realtime";
import { pushNotif } from "./notifications";

const FT_TOKEN = "https://api.intra.42.fr/oauth/token";
const FT_UID = process.env.FT_UID ?? "";
const FT_SECRET = process.env.FT_SECRET ?? "";

const CHECK_COOLDOWN_MIN = 10; // au plus un appel API 42 par utilisateur / 10 min
const CORE_REWARD = 2000;

interface FtUserLike
{
	cursus_users?: Array<{ cursus_id: number; grade: string | null }>;
	projects_users?: Array<{
		project: { name: string };
		status: string;
		"validated?": boolean | null;
	}>;
}

/** Derive common-core / exam-rank signals from a 42 user payload. */
export function parseCursus(me: FtUserLike): { coreDone: boolean; examRank: number | null }
{
	const cursus21 = me.cursus_users?.find((c) => c.cursus_id === 21);
	const coreDone = cursus21?.grade?.toLowerCase() === "member";

	let examRank: number | null = null;
	let highestValidated = 1;
	for (const pu of me.projects_users ?? [])
	{
		const m = pu.project?.name?.match(/^Exam Rank (\d{2})$/);
		if (!m) continue;
		const rank = Number(m[1]);
		if (pu.status === "in_progress" || pu.status === "searching_a_group") examRank = rank;
		if (pu["validated?"]) highestValidated = Math.max(highestValidated, rank);
	}
	if (examRank === null && !coreDone) examRank = Math.min(6, highestValidated + 1);
	return { coreDone, examRank };
}

/** Persist cursus signals for a user; awards the one-time +2000 pts. */
export async function applyCursus(userId: number, me: FtUserLike): Promise<void>
{
	const { coreDone, examRank } = parseCursus(me);

	await sql`UPDATE users SET exam_rank = ${examRank} WHERE id = ${userId}`;

	if (!coreDone) return;
	// One-time reward, guarded by the WHERE so concurrent syncs can't double-pay.
	const updated = (await sql`
		UPDATE users SET common_core_done = true, points = points + ${CORE_REWARD}
		WHERE id = ${userId} AND common_core_done = false
		RETURNING points
	`) as Array<{ points: number }>;
	if (updated[0])
	{
		publishBalance(userId, updated[0].points);
		await pushNotif(userId, {
			kind: "admin",
			message: `🎓 Tronc commun terminé — félicitations ! +${CORE_REWARD} pts`,
		});
	}
}

// ── Background sync (app token, no user session needed) ─────────────────────

let appToken: { token: string; expires: number } | null = null;

async function getAppToken(): Promise<string | null>
{
	if (appToken && Date.now() < appToken.expires - 60_000) return appToken.token;
	try
	{
		const res = await fetch(FT_TOKEN, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "client_credentials",
				client_id: FT_UID,
				client_secret: FT_SECRET,
			}),
		});
		if (!res.ok) return null;
		const d = (await res.json()) as { access_token: string; expires_in: number };
		appToken = { token: d.access_token, expires: Date.now() + d.expires_in * 1000 };
		return appToken.token;
	} catch { return null; }
}

/** Called on each authenticated site load (/api/auth/me). Fire-and-forget:
 * the UPDATE claims the check atomically, so at most one API 42 call per user
 * per cooldown window even under concurrent page loads. */
export async function maybeSyncUser(userId: number): Promise<void>
{
	if (!FT_UID || !FT_SECRET) return;
	try
	{
		const claimed = (await sql`
			UPDATE users SET cursus_checked_at = now()
			WHERE id = ${userId}
				AND common_core_done = false
				AND ft_id IS NOT NULL
				AND (cursus_checked_at IS NULL
						 OR cursus_checked_at < now() - make_interval(mins => ${CHECK_COOLDOWN_MIN}))
			RETURNING ft_id
		`) as Array<{ ft_id: number }>;
		if (!claimed[0]) return;

		const token = await getAppToken();
		if (!token) return;
		const res = await fetch(`https://api.intra.42.fr/v2/users/${claimed[0].ft_id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.ok) await applyCursus(userId, (await res.json()) as FtUserLike);
	}
	catch (e)
	{
		console.error("[cursus-sync]", e);
	}
}
