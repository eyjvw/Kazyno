import { sql } from "./db";
import { pushFeed } from "./feed";

// A win worth showing in the live feed: at least 1000 pts and 3× the wager.
const FEED_MIN_PAYOUT = 1_000;
const FEED_MIN_MULT = 3;

export async function recordStat(userId: number, game: string, bet: number, payout: number): Promise<void>
{
	try
	{
		await sql`
			INSERT INTO game_stats (user_id, game, games_played, total_wagered, total_payout, biggest_win)
			VALUES (${userId}, ${game}, 1, ${bet}, ${payout}, ${payout})
			ON CONFLICT (user_id, game) DO UPDATE SET
				games_played  = game_stats.games_played + 1,
				total_wagered = game_stats.total_wagered + ${bet},
				total_payout  = game_stats.total_payout + ${payout},
				biggest_win   = GREATEST(game_stats.biggest_win, ${payout})
		`;
		await sql`
			INSERT INTO game_history (user_id, game, bet, payout)
			VALUES (${userId}, ${game}, ${bet}, ${payout})
		`;
		if (payout >= FEED_MIN_PAYOUT && payout >= bet * FEED_MIN_MULT)
		{
			const rows = (await sql`
				SELECT login, display_name FROM users WHERE id = ${userId}
			`) as Array<{ login: string; display_name: string | null }>;
			if (rows[0])
			{
				pushFeed({
					login: rows[0].login,
					display_name: rows[0].display_name,
					game, bet, payout,
					ts: Date.now(),
				});
			}
		}
	}
	catch { /* non-critical */ }
}
