// Sync automatique des matchs de foot + cotes 1N2 depuis The Odds API
// (the-odds-api.com — free tier 500 crédits/mois, 1 crédit par ligue par appel).
// Au boot puis toutes les 6 h : upsert des matchs à venir des ligues suivies,
// cotes moyennées sur tous les bookmakers EU. Toutes les 30 min : si un match
// commencé attend son résultat, endpoint scores → règlement des paris
// (payout = mise × cote verrouillée au moment de la mise).
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishToUser } from "./realtime";
import { pushNotif } from "./notifications";

const API_KEY = process.env.ODDS_API_KEY ?? "";
const BASE = "https://api.the-odds-api.com/v4";
const LEAGUES = (process.env.FOOT_LEAGUES
	?? "soccer_france_ligue_one,soccer_epl,soccer_uefa_champs_league")
	.split(",").map((s) => s.trim()).filter(Boolean);
const ODDS_INTERVAL   = 6 * 60 * 60 * 1000; // 4 syncs/jour × 3 ligues ≈ 360 crédits/mois
const SETTLE_INTERVAL = 30 * 60 * 1000;     // n'appelle l'API que si un résultat est attendu

interface OddsOutcome { name: string; price: number }
interface OddsEvent
{
	id: string;
	sport_key: string;
	sport_title: string;
	commence_time: string;
	home_team: string;
	away_team: string;
	bookmakers: Array<{ markets: Array<{ key: string; outcomes: OddsOutcome[] }> }>;
}
interface ScoreEvent
{
	id: string;
	completed: boolean;
	home_team: string;
	away_team: string;
	scores: Array<{ name: string; score: string }> | null;
}

async function apiGet<T>(path: string): Promise<T | null>
{
	const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}apiKey=${API_KEY}`);
	if (!res.ok)
	{
		console.error(`[foot-sync] HTTP ${res.status} on ${path}`);
		return null;
	}
	const remaining = res.headers.get("x-requests-remaining");
	if (remaining && Number(remaining) < 50)
		console.warn(`[foot-sync] quota The Odds API bas : ${remaining} crédits restants`);
	return (await res.json()) as T;
}

// Moyenne des cotes 1N2 sur tous les bookmakers ; null si un des trois
// résultats n'est coté nulle part (match sans marché h2h complet).
function avgOdds(ev: OddsEvent): { home: number; draw: number; away: number } | null
{
	const sum = { home: 0, draw: 0, away: 0 };
	const n   = { home: 0, draw: 0, away: 0 };
	for (const bk of ev.bookmakers ?? [])
	{
		const h2h = (bk.markets ?? []).find((m) => m.key === "h2h");
		for (const o of h2h?.outcomes ?? [])
		{
			const k = o.name === ev.home_team ? "home"
				: o.name === ev.away_team ? "away"
				: o.name === "Draw" ? "draw" : null;
			if (k) { sum[k] += o.price; n[k]++; }
		}
	}
	if (!n.home || !n.draw || !n.away) return null;
	const r = (x: number) => Math.round(x * 100) / 100;
	return { home: r(sum.home / n.home), draw: r(sum.draw / n.draw), away: r(sum.away / n.away) };
}

async function syncOdds(): Promise<void>
{
	for (const league of LEAGUES)
	{
		const events = await apiGet<OddsEvent[]>(
			`/sports/${league}/odds?regions=eu&markets=h2h&oddsFormat=decimal`,
		);
		if (!events) continue;

		let upserted = 0;
		for (const ev of events)
		{
			const odds = avgOdds(ev);
			if (!odds) continue;
			// Cotes figées dès le coup d'envoi : on ne met à jour que les matchs
			// encore ouverts et pas commencés.
			await sql`
				INSERT INTO foot_matches (event_id, sport_key, league, home, away, commence_at,
				                          odds_home, odds_draw, odds_away)
				VALUES (${ev.id}, ${ev.sport_key}, ${ev.sport_title}, ${ev.home_team}, ${ev.away_team},
				        ${ev.commence_time}, ${odds.home}, ${odds.draw}, ${odds.away})
				ON CONFLICT (event_id) DO UPDATE SET
					commence_at = EXCLUDED.commence_at,
					odds_home   = EXCLUDED.odds_home,
					odds_draw   = EXCLUDED.odds_draw,
					odds_away   = EXCLUDED.odds_away,
					updated_at  = now()
				WHERE foot_matches.status = 'open' AND foot_matches.commence_at > now()
			`;
			upserted++;
		}
		if (upserted) console.log(`[foot-sync] ${upserted} match(s) ${league} synchronisés`);
	}
}

async function credit(userId: number, amount: number)
{
	if (amount <= 0) return;
	const rows = (await sql`
		UPDATE users SET points = points + ${amount} WHERE id = ${userId} RETURNING points
	`) as Array<{ points: number }>;
	if (rows[0]) publishBalance(userId, rows[0].points);
}

async function settleMatch(
	m: { id: number; home: string; away: string },
	homeScore: number,
	awayScore: number,
): Promise<void>
{
	const result = homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
	await sql`
		UPDATE foot_matches
		SET status='settled', home_score=${homeScore}, away_score=${awayScore}, settled_at=now()
		WHERE id=${m.id} AND status='open'
	`;
	const bets = (await sql`
		SELECT id, user_id, pick, odds, stake FROM foot_bets
		WHERE match_id=${m.id} AND status='pending'
	`) as Array<{ id: number; user_id: number; pick: string; odds: number; stake: number }>;

	for (const b of bets)
	{
		const win = b.pick === result;
		const payout = win ? Math.floor(b.stake * b.odds) : 0;
		await sql`
			UPDATE foot_bets SET status='settled', payout=${payout}, settled_at=now()
			WHERE id=${b.id} AND status='pending'
		`;
		if (payout > 0) await credit(b.user_id, payout);
		publishToUser(b.user_id, {
			type: "foot_settled",
			match: `${m.home} — ${m.away}`,
			score: `${homeScore}-${awayScore}`,
			pick: b.pick,
			odds: b.odds,
			stake: b.stake,
			payout,
		});
		await pushNotif(b.user_id, {
			kind: "foot",
			message: win
				? `⚽ ${m.home} ${homeScore}-${awayScore} ${m.away} — pari gagné +${payout} pts (${b.odds}×)`
				: `⚽ ${m.home} ${homeScore}-${awayScore} ${m.away} — pari perdu (-${b.stake})`,
			link: "/paris#foot",
		});
	}
	if (bets.length) void publishLeaderboard();
	console.log(`[foot-sync] réglé : ${m.home} ${homeScore}-${awayScore} ${m.away} (${bets.length} pari(s))`);
}

async function settleMatches(): Promise<void>
{
	// Matchs reportés/annulés jamais réglés par l'API : remboursement après 7 jours.
	const stale = (await sql`
		SELECT id, home, away FROM foot_matches
		WHERE status='open' AND commence_at < now() - interval '7 days'
	`) as Array<{ id: number; home: string; away: string }>;
	for (const m of stale)
	{
		await sql`UPDATE foot_matches SET status='void', settled_at=now() WHERE id=${m.id}`;
		const bets = (await sql`
			UPDATE foot_bets SET status='settled', payout=stake, settled_at=now()
			WHERE match_id=${m.id} AND status='pending'
			RETURNING user_id, stake
		`) as Array<{ user_id: number; stake: number }>;
		for (const b of bets)
		{
			await credit(b.user_id, b.stake);
			await pushNotif(b.user_id, {
				kind: "foot",
				message: `⚽ ${m.home} — ${m.away} annulé, mise remboursée (+${b.stake} pts)`,
				link: "/paris#foot",
			});
		}
	}

	// Un appel scores par ligue, seulement si un match commencé attend son résultat.
	const leagues = (await sql`
		SELECT DISTINCT sport_key FROM foot_matches
		WHERE status='open' AND commence_at < now()
	`) as Array<{ sport_key: string }>;

	for (const { sport_key } of leagues)
	{
		const scores = await apiGet<ScoreEvent[]>(`/sports/${sport_key}/scores?daysFrom=3`);
		if (!scores) continue;
		const byEvent = new Map(scores.map((s) => [s.id, s]));

		const open = (await sql`
			SELECT id, event_id, home, away FROM foot_matches
			WHERE status='open' AND sport_key=${sport_key} AND commence_at < now()
		`) as Array<{ id: number; event_id: string; home: string; away: string }>;

		for (const m of open)
		{
			const s = byEvent.get(m.event_id);
			if (!s?.completed || !s.scores) continue;
			const hs = Number(s.scores.find((x) => x.name === s.home_team)?.score);
			const as_ = Number(s.scores.find((x) => x.name === s.away_team)?.score);
			if (!Number.isFinite(hs) || !Number.isFinite(as_)) continue;
			await settleMatch(m, hs, as_);
		}
	}
}

export function initFootSync(): void
{
	if (!API_KEY)
	{
		console.warn("[foot-sync] ODDS_API_KEY absent — paris foot désactivés (clé gratuite sur the-odds-api.com)");
		return;
	}
	void syncOdds().catch((e) => console.error("[foot-sync]", e));
	setInterval(() => void syncOdds().catch((e) => console.error("[foot-sync]", e)), ODDS_INTERVAL);
	setInterval(() => void settleMatches().catch((e) => console.error("[foot-sync]", e)), SETTLE_INTERVAL);
}
