import { sql } from "./db";
import { publishBalance } from "./realtime";
import { pushNotif } from "./notifications";

const FT_TOKEN = "https://api.intra.42.fr/oauth/token";
const FT_UID = process.env.FT_UID ?? "";
const FT_SECRET = process.env.FT_SECRET ?? "";

const CHECK_COOLDOWN_MIN = 10; // au plus un appel API 42 par utilisateur / 10 min
const CORE_REWARD = 2000;
const PISCINE_REWARD = 1000;

interface FtUserLike
{
	cursus_users?: Array<{ cursus_id: number; grade: string | null; begin_at?: string | null }>;
}

/** Exam payload from GET /v2/users/:id/exams (filter[future]=true). */
export interface FtExamLike
{
	name?: string;
	begin_at?: string;
	projects?: Array<{ name?: string; slug?: string }>;
}

/** Common core done = cursus 21 (42cursus) grade "Transcender" (transcendance
 * period right after the core) or "Member" (post-transcendance).
 * Piscine passed = cursus 21 present: the intra only adds the 42cursus to a
 * profile once the piscine is validated (kickoff) — no dedicated flag in the
 * API (cursus_users only has grade/level/blackholed_at). Reward reserved to
 * NEW students: begin_at in the current year, so long-time students don't
 * farm +1000 retroactively. Rolls over automatically each year. */
export function parseCursus(me: FtUserLike): { coreDone: boolean; piscineDone: boolean }
{
	const cursus21 = me.cursus_users?.find((c) => c.cursus_id === 21);
	const grade = cursus21?.grade?.toLowerCase() ?? "";
	const beginYear = cursus21?.begin_at ? new Date(cursus21.begin_at).getUTCFullYear() : null;
	return {
		coreDone: grade === "member" || grade === "transcender",
		piscineDone: beginYear !== null && beginYear === new Date().getUTCFullYear(),
	};
}

/** Map a registered 42 exam to a Kazyno rank: 0 = piscine, 2-6 = Exam Rank 0N.
 * Matches on the exam's canonical project names first, then the exam name
 * (campuses rename exam sessions, projects keep "Exam Rank 0X" / "C Piscine ... Exam"). */
export function examToRank(exam: FtExamLike): number | null
{
	const names = [
		...(exam.projects ?? []).map((p) => p.name ?? ""),
		exam.name ?? "",
	];
	for (const n of names)
	{
		const m = n.match(/exam rank 0?([2-6])/i);
		if (m) return Number(m[1]);
	}
	if (names.some((n) => /piscine/i.test(n) && /exam/i.test(n))) return 0;
	return null;
}

/** Rank of the soonest upcoming exam the user is actually registered to. */
export function parseRegistration(exams: FtExamLike[]): number | null
{
	const sorted = [...exams].sort((a, b) => (a.begin_at ?? "").localeCompare(b.begin_at ?? ""));
	for (const e of sorted)
	{
		const r = examToRank(e);
		if (r !== null) return r;
	}
	return null;
}

/** Persist cursus signals for a user; awards the one-time +2000 pts.
 * `registeredExams` = payload of /v2/users/:id/exams?filter[future]=true;
 * null/undefined means the fetch failed — keep the stored exam_rank as-is. */
export async function applyCursus(
	userId: number,
	me: FtUserLike,
	registeredExams?: FtExamLike[] | null,
): Promise<void>
{
	const { coreDone, piscineDone } = parseCursus(me);

	if (registeredExams)
	{
		const examRank = coreDone ? null : parseRegistration(registeredExams);
		await sql`UPDATE users SET exam_rank = ${examRank} WHERE id = ${userId}`;
	}

	if (piscineDone)
	{
		// One-time reward, same atomic-claim pattern as the core one below.
		const paid = (await sql`
			UPDATE users SET piscine_done = true, points = points + ${PISCINE_REWARD},
											 piscine_reward_seen = false
			WHERE id = ${userId} AND piscine_done = false
			RETURNING points
		`) as Array<{ points: number }>;
		if (paid[0])
		{
			publishBalance(userId, paid[0].points);
			await pushNotif(userId, {
				kind: "reward",
				message: `🏊 Piscine réussie — bienvenue au 42cursus ! +${PISCINE_REWARD} pts`,
			});
		}
	}

	if (!coreDone) return;
	// One-time reward, guarded by the WHERE so concurrent syncs can't double-pay.
	const updated = (await sql`
		UPDATE users SET common_core_done = true, points = points + ${CORE_REWARD},
										 core_reward_seen = false
		WHERE id = ${userId} AND common_core_done = false
		RETURNING points
	`) as Array<{ points: number }>;
	if (updated[0])
	{
		publishBalance(userId, updated[0].points);
		await pushNotif(userId, {
			kind: "reward",
			message: `🎓 Tronc commun terminé — félicitations ! +${CORE_REWARD} pts`,
		});
	}
}

// ── Background sync (app token, no user session needed) ─────────────────────

let appToken: { token: string; expires: number } | null = null;

export async function getAppToken(): Promise<string | null>
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
		const auth = { headers: { Authorization: `Bearer ${token}` } };
		const ftId = claimed[0].ft_id;
		const [userRes, examsRes] = await Promise.all([
			fetch(`https://api.intra.42.fr/v2/users/${ftId}`, auth),
			fetch(`https://api.intra.42.fr/v2/users/${ftId}/exams?filter%5Bfuture%5D=true&page%5Bsize%5D=30`, auth),
		]);
		if (!userRes.ok) return;
		const regExams = examsRes.ok ? ((await examsRes.json()) as FtExamLike[]) : null;
		await applyCursus(userId, (await userRes.json()) as FtUserLike, regExams);
	}
	catch (e)
	{
		console.error("[cursus-sync]", e);
	}
}
