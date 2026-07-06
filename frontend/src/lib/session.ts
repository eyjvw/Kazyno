const fmt = (n: number) => n.toLocaleString("fr-FR");

export class GameSession
{
	// Only the last 30 rounds are kept for the recent-chips strip, but the
	// session stats (parties / victoires / profit) count every game played —
	// sinon le compteur "Parties" gèle à 30.
	private results: { win: boolean; bet: number; payout: number }[] = [];
	private totalGames  = 0;
	private totalWins   = 0;
	private totalProfit = 0;
	private histEl: HTMLElement | null;
	private statsEl: HTMLElement | null;

	constructor(histEl: HTMLElement | null, statsEl: HTMLElement | null)
	{
		this.histEl  = histEl;
		this.statsEl = statsEl;
		this.render();
	}

	record(win: boolean, bet: number, payout: number)
	{
		this.results.unshift({ win, bet, payout });
		if (this.results.length > 30) this.results.pop();
		this.totalGames++;
		if (win) this.totalWins++;
		this.totalProfit += win ? payout - bet : -bet;
		this.render();
	}

	private render()
	{
		const { results, histEl, statsEl } = this;

		if (histEl)
		{
			const chips = results.slice(0, 16).map(r =>
			{
				const diff = r.win ? r.payout - r.bet : -r.bet;
				return `<span class="hchip ${r.win ? "hw" : "hl"}">${diff > 0 ? "+" : ""}${fmt(diff)}</span>`;
			}).join("");
			histEl.innerHTML = chips || `<span class="hempty">Aucune partie jouée.</span>`;
		}

		if (statsEl)
		{
			const n      = this.totalGames;
			const wins   = this.totalWins;
			const profit = this.totalProfit;
			const wr     = n ? Math.round(wins / n * 100) : 0;
			statsEl.innerHTML = `
				<div class="ss"><span>Parties</span><b>${n}</b></div>
				<div class="ss"><span>Victoires</span><b>${wr}%</b></div>
				<div class="ss"><span>Session</span><b class="${profit >= 0 ? "spos" : "sneg"}">${profit >= 0 ? "+" : ""}${fmt(profit)}</b></div>
			`;
		}
	}
}
