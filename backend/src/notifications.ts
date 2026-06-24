import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishToUser, publishBroadcast } from "./realtime";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

export interface Sender {
  id: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
}
interface NotifOpts {
  kind: string;
  message: string;
  from?: Sender | null;
  link?: string | null;
}

/** Persist a notification for one user and push it live. */
export async function pushNotif(userId: number, o: NotifOpts) {
  const f = o.from ?? null;
  const rows = (await sql`
    INSERT INTO notifications (user_id, kind, message, from_id, from_login, from_name, from_image, link)
    VALUES (${userId}, ${o.kind}, ${o.message}, ${f?.id ?? null}, ${f?.login ?? null},
            ${f?.display_name ?? null}, ${f?.image_url ?? null}, ${o.link ?? null})
    RETURNING id, kind, message, from_login, from_name, from_image, link, read, created_at
  `) as unknown[];
  publishToUser(userId, { type: "notification", notif: rows[0] });
}

/** Persist a notification for everyone and push a live signal. */
export async function pushNotifAll(o: NotifOpts) {
  const f = o.from ?? null;
  await sql`
    INSERT INTO notifications (user_id, kind, message, from_id, from_login, from_name, from_image, link)
    SELECT id, ${o.kind}, ${o.message}, ${f?.id ?? null}, ${f?.login ?? null},
           ${f?.display_name ?? null}, ${f?.image_url ?? null}, ${o.link ?? null}
    FROM users
  `;
  publishBroadcast({
    type: "notification",
    notif: {
      kind: o.kind,
      message: o.message,
      from_login: f?.login ?? null,
      from_name: f?.display_name ?? null,
      from_image: f?.image_url ?? null,
      link: o.link ?? null,
      read: false,
      created_at: new Date().toISOString(),
    },
  });
}

export const notifications = new Elysia({ prefix: "/api/notifications" })
  .use(jwt({ name: "jwt", secret: SESSION_SECRET }))
  .derive(async ({ jwt, cookie: { session } }) => {
    const payload = session.value ? await jwt.verify(session.value) : false;
    return { userId: payload && payload.sub ? Number(payload.sub) : null };
  })
  .onBeforeHandle(({ userId, set }) => {
    if (!userId) {
      set.status = 401;
      return { error: "non authentifie" };
    }
  })

  .get("/", async ({ userId }) => {
    const items = (await sql`
      SELECT id, kind, message, from_login, from_name, from_image, link, read, created_at
      FROM notifications WHERE user_id=${userId}
      ORDER BY created_at DESC LIMIT 30
    `) as unknown[];
    const cnt = (await sql`
      SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=${userId} AND read=false
    `) as Array<{ n: number }>;
    return { items, unread: cnt[0].n };
  })

  .post("/read", async ({ userId }) => {
    await sql`UPDATE notifications SET read=true WHERE user_id=${userId} AND read=false`;
    return { ok: true };
  })

  .delete("/:id", async ({ userId, params }) => {
    await sql`DELETE FROM notifications WHERE id=${Number(params.id)} AND user_id=${userId}`;
    return { ok: true };
  })

  .delete("/", async ({ userId }) => {
    await sql`DELETE FROM notifications WHERE user_id=${userId}`;
    return { ok: true };
  });
