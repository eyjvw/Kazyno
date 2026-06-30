import { sql } from "./db";

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
	}
	catch { /* non-critical */ }
}
