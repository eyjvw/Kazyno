import { Elysia } from "elysia";
import { initDb } from "./db";
import { auth } from "./auth";
import { games } from "./games";
import { stats } from "./stats";
import { social } from "./social";
import { blackjack } from "./blackjack";
import { exambets } from "./exambets";
import { admin } from "./admin";
import { notifications } from "./notifications";
import { realtimeWs } from "./ws";
import { setServer } from "./realtime";

await initDb();

const app = new Elysia()
  .get("/health", () => ({ ok: true, service: "backend" }))
  .use(auth)
  .use(games)
  .use(stats)
  .use(social)
  .use(blackjack)
  .use(exambets)
  .use(admin)
  .use(notifications)
  .use(realtimeWs)
  .listen({ port: 3000, hostname: "0.0.0.0" });

if (app.server) setServer(app.server);

console.log(`backend up on http://${app.server?.hostname}:${app.server?.port}`);
