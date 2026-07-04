import { Elysia } from "elysia";
import { initDb } from "./db";
import { auth } from "./auth";
import { games } from "./games";
import { stats } from "./stats";
import { social } from "./social";
import { blackjack } from "./blackjack";
import { exambets } from "./exambets";
import { exams } from "./exams";
import { tracker } from "./tracker";
import { admin } from "./admin";
import { notifications } from "./notifications";
import { realtimeWs } from "./ws";
import { setServer } from "./realtime";
import { daily } from "./daily";
import { minesGame } from "./mines";
import { crash } from "./crash";
import { hilo } from "./hilo";
import { tower } from "./tower";
import { achievementsRoutes } from "./achievements";
import { fair } from "./fair";
import { jackpotRoutes } from "./jackpot";
import { duels } from "./duels";
import { rain } from "./rain";
import { shop } from "./shop";
import { feedRoutes } from "./feed";
import { history } from "./history";
import { poker } from "./poker";
import { initWeeklyReset } from "./weeklyreset";

await initDb();

const app = new Elysia()
	.get("/health", () => ({ ok: true, service: "backend" }))
	.use(auth)
	.use(games)
	.use(stats)
	.use(social)
	.use(blackjack)
	.use(exambets)
	.use(exams)
	.use(tracker)
	.use(admin)
	.use(notifications)
	.use(daily)
	.use(minesGame)
	.use(crash)
	.use(hilo)
	.use(tower)
	.use(achievementsRoutes)
	.use(fair)
	.use(jackpotRoutes)
	.use(duels)
	.use(rain)
	.use(shop)
	.use(feedRoutes)
	.use(history)
	.use(poker)
	.use(realtimeWs)
	.listen({ port: 3000, hostname: "0.0.0.0" });

if (app.server) setServer(app.server);

await initWeeklyReset();

console.log(`backend up on http://${app.server?.hostname}:${app.server?.port}`);
