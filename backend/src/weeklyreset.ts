import { sql } from "./db";
import { publishBroadcast, publishLeaderboard } from "./realtime";
import { resetJackpot } from "./jackpot";
import { awardWeeklyCoalitionPoints } from "./coalition";

const RESET_POINTS   = 1000;
const CHECK_INTERVAL = 60 * 60 * 1000; // vérifie toutes les heures

// Identifiant de semaine ISO (ex: "2026-W27") — change chaque lundi 00:00 UTC.
function isoWeekId(d: Date = new Date()): string
{
	const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	// Jeudi de la semaine courante détermine l'année ISO
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function initWeeklyReset(): Promise<void>
{
	await sql`
		CREATE TABLE IF NOT EXISTS weekly_resets (
			week_id   TEXT PRIMARY KEY,
			reset_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;

	// Premier démarrage : marque la semaine courante comme déjà traitée pour
	// ne pas écraser les points existants. Les resets commencent semaine suivante.
	const [{ count }] = (await sql`
		SELECT count(*)::int AS count FROM weekly_resets
	`) as Array<{ count: number }>;
	if (count === 0)
	{
		await sql`
			INSERT INTO weekly_resets (week_id) VALUES (${isoWeekId()})
			ON CONFLICT (week_id) DO NOTHING
		`;
	}

	await runIfNewWeek();
	setInterval(() => void runIfNewWeek(), CHECK_INTERVAL);
}

async function runIfNewWeek(): Promise<void>
{
	const week = isoWeekId();

	// INSERT ... ON CONFLICT DO NOTHING = verrou : une seule instance/tick
	// gagne le droit de faire le reset pour cette semaine.
	const inserted = (await sql`
		INSERT INTO weekly_resets (week_id) VALUES (${week})
		ON CONFLICT (week_id) DO NOTHING
		RETURNING week_id
	`) as Array<{ week_id: string }>;

	if (inserted.length === 0) return; // déjà fait cette semaine

	// Podium de la semaine écoulée → points de coalition sur l'intra.
	// AVANT le reset (sinon plus de classement), et sans bloquer le reset.
	await awardWeeklyCoalitionPoints(week);

	await sql`UPDATE users SET points = ${RESET_POINTS}`;
	// Pot commun remis au seed : la course de la semaine repart de zéro pour tous.
	await resetJackpot();

	console.log(`[weekly-reset] ${week}: tous les joueurs remis à ${RESET_POINTS} pts`);

	publishBroadcast({
		type:    "weekly_reset",
		week,
		points:  RESET_POINTS,
		message: `Reset hebdomadaire ! Tout le monde repart à ${RESET_POINTS} points.`,
	});
	void publishLeaderboard();

	// Requête API fictive : notifier un service externe du reset (webhook,
	// archivage du classement de la semaine, etc.). À activer plus tard.
	//
	// const res = await fetch("https://api.example.com/kazyno/weekly-reset", {
	// 	method:  "POST",
	// 	headers: {
	// 		"Content-Type":  "application/json",
	// 		"Authorization": `Bearer ${process.env.WEEKLY_RESET_WEBHOOK_SECRET}`,
	// 	},
	// 	body: JSON.stringify({
	// 		week,
	// 		points:   RESET_POINTS,
	// 		reset_at: new Date().toISOString(),
	// 	}),
	// });
	// if (!res.ok) console.error(`[weekly-reset] webhook KO: ${res.status}`);
}
