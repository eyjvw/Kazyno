// Points de coalition pour le top 3 du classement hebdo, crédités sur l'intra
// au moment du reset du lundi (appelé par weeklyreset.ts AVANT la remise à 1000).
//
// Nécessite une app API 42 avec le rôle "Advanced staff" (score creation) :
// FT_COALITION_UID / FT_COALITION_SECRET — vides tant que la clé n'est pas là,
// dans ce cas tout est silencieusement sauté.
import { sql } from "./db";
import { pushNotif } from "./notifications";

const FT_TOKEN = "https://api.intra.42.fr/oauth/token";
const COALITION_UID = process.env.FT_COALITION_UID ?? "";
const COALITION_SECRET = process.env.FT_COALITION_SECRET ?? "";

// Points de coalition par rang (1er, 2e, 3e) — à ajuster librement.
const COALITION_REWARDS = [100, 60, 30];

async function getToken(): Promise<string | null>
{
	try
	{
		const res = await fetch(FT_TOKEN, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "client_credentials",
				client_id: COALITION_UID,
				client_secret: COALITION_SECRET,
			}),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { access_token: string }).access_token;
	}
	catch { return null; }
}

/** Crédite les points de coalition du podium hebdo. Ne throw jamais :
 * le reset des points ne doit pas dépendre de l'API 42. */
export async function awardWeeklyCoalitionPoints(week: string): Promise<void>
{
	if (!COALITION_UID || !COALITION_SECRET)
	{
		console.log("[coalition] clés absentes — top 3 hebdo non crédité sur l'intra");
		return;
	}

	try
	{
		const podium = (await sql`
			SELECT id, ft_id, login, points FROM users
			WHERE ft_id IS NOT NULL AND points > 1000
			ORDER BY points DESC, id ASC
			LIMIT 3
		`) as Array<{ id: number; ft_id: number; login: string; points: number }>;
		if (!podium.length) return;

		const token = await getToken();
		if (!token)
		{
			console.error("[coalition] token app 42 refusé — rien crédité");
			return;
		}
		const auth = { Authorization: `Bearer ${token}` };

		for (let rank = 0; rank < podium.length; rank++)
		{
			const winner = podium[rank];
			const value = COALITION_REWARDS[rank];
			try
			{
				// Coalition active du joueur (bloc du campus).
				const cuRes = await fetch(
					`https://api.intra.42.fr/v2/users/${winner.ft_id}/coalitions_users`,
					{ headers: auth },
				);
				if (!cuRes.ok) throw new Error(`coalitions_users HTTP ${cuRes.status}`);
				const cus = (await cuRes.json()) as Array<{ id: number; coalition_id: number }>;
				if (!cus.length)
				{
					console.log(`[coalition] @${winner.login} sans coalition — skip`);
					continue;
				}
				const cu = cus[0];

				const scoreRes = await fetch(
					`https://api.intra.42.fr/v2/coalitions/${cu.coalition_id}/scores`,
					{
						method: "POST",
						headers: { ...auth, "Content-Type": "application/json" },
						body: JSON.stringify({
							score: {
								reason: `Kazyno — top ${rank + 1} du classement hebdo (${week})`,
								value,
								coalitions_user_id: cu.id,
							},
						}),
					},
				);
				if (!scoreRes.ok) throw new Error(`scores HTTP ${scoreRes.status}`);

				console.log(`[coalition] ${week}: @${winner.login} top ${rank + 1} → +${value} pts coalition`);
				await pushNotif(winner.id, {
					kind: "reward",
					message: `🏆 Top ${rank + 1} du classement de la semaine (${winner.points.toLocaleString("fr-FR")} pts) — +${value} points de coalition sur l'intra !`,
				});
			}
			catch (e)
			{
				console.error(`[coalition] échec pour @${winner.login}:`, e);
			}
		}
	}
	catch (e)
	{
		console.error("[coalition]", e);
	}
}
