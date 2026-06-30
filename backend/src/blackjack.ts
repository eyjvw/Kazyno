import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import {
	publishBalance,
	publishLeaderboard,
	publishToUser,
	getServer,
} from "./realtime";
import { pushNotif } from "./notifications";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

const MAX_SEATS = 5;
const MIN_BET = 10;
const MAX_BET = 1_000_000;
const BOT_BET = 50;
const BET_MS = 25_000;
const TURN_MS = 25_000;
const PAYOUT_MS = 6_000;
const RESHUFFLE_AT = 20;

type Phase = "waiting" | "betting" | "playing" | "dealer" | "payout";
type SeatStatus = "idle" | "bet" | "playing" | "stand" | "bust" | "blackjack" | "done";

interface Card
{
	r: string;
	s: string;
}
interface Seat
{
	seatId: string;
	userId: number | null;
	login: string;
	display_name: string | null;
	image_url: string | null;
	isBot: boolean;
	inRound: boolean;
	bet: number;
	cards: Card[];
	status: SeatStatus;
	result: string | null;
	win: number;
	doubled: boolean;
}
interface Room
{
	id: string;
	code: string;
	name: string;
	hostId: number;
	isPublic: boolean;
	seats: (Seat | null)[];
	phase: Phase;
	shoe: Card[];
	dealer: Card[];
	turn: number; // seat index, or -1
	deadline: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	lastActivity: number;
}

const IDLE_MS = 10 * 60 * 1000; // close rooms idle for 10 min

const rooms = new Map<string, Room>();

// ── Cards ─────────────────────────────────────────────────────────────────
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];

function rnd(n: number): number
{
	const b = new Uint32Array(1);
	crypto.getRandomValues(b);
	return Math.floor((b[0] / 2 ** 32) * n);
}
function freshShoe(): Card[]
{
	const cards: Card[] = [];
	for (let d = 0; d < 4; d++)
		for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
	for (let i = cards.length - 1; i > 0; i--)
	{
		const j = rnd(i + 1);
		[cards[i], cards[j]] = [cards[j], cards[i]];
	}
	return cards;
}
function draw(room: Room): Card
{
	if (room.shoe.length < RESHUFFLE_AT) room.shoe = freshShoe();
	return room.shoe.pop()!;
}
function handValue(cards: Card[]): { total: number; soft: boolean }
{
	let total = 0;
	let aces = 0;
	for (const c of cards)
	{
		if (c.r === "A")
		{
			aces++;
			total += 11;
		} else if (c.r === "K" || c.r === "Q" || c.r === "J" || c.r === "10")
			total += 10;
		else total += Number(c.r);
	}
	while (total > 21 && aces > 0)
	{
		total -= 10;
		aces--;
	}
	return { total, soft: aces > 0 };
}
const isBlackjack = (cards: Card[]) =>
	cards.length === 2 && handValue(cards).total === 21;

// ── Balance ─────────────────────────────────────────────────────────────
async function debit(userId: number, amount: number): Promise<boolean>
{
	const rows = (await sql`
		UPDATE users SET points = points - ${amount}
		WHERE id = ${userId} AND points >= ${amount} RETURNING points
	`) as Array<{ points: number }>;
	if (!rows[0]) return false;
	publishBalance(userId, rows[0].points);
	return true;
}
async function credit(userId: number, amount: number)
{
	if (amount <= 0) return;
	const rows = (await sql`
		UPDATE users SET points = points + ${amount} WHERE id = ${userId} RETURNING points
	`) as Array<{ points: number }>;
	if (rows[0]) publishBalance(userId, rows[0].points);
}

// ── Room helpers ──────────────────────────────────────────────────────────
const genId = () => crypto.randomUUID().slice(0, 8);
const genCode = () =>
{
	let c = "";
	for (let i = 0; i < 5; i++) c += "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[rnd(31)];
	return c;
};
const occupied = (room: Room) => room.seats.filter((s): s is Seat => !!s);
const humans = (room: Room) => occupied(room).filter((s) => !s.isBot);
const seatOfUser = (room: Room, userId: number) =>
	room.seats.find((s) => s && s.userId === userId) ?? null;

function clearTimer(room: Room)
{
	if (room.timer) clearTimeout(room.timer);
	room.timer = null;
	room.deadline = null;
}

function publicView(room: Room, forReveal = false)
{
	const reveal = forReveal || room.phase === "dealer" || room.phase === "payout";
	const dealerCards = room.dealer.length
		? reveal
			? room.dealer
			: [room.dealer[0], { r: "?", s: "?" }]
		: [];
	return {
		type: "room",
		room: {
			id: room.id,
			code: room.code,
			name: room.name,
			hostId: room.hostId,
			isPublic: room.isPublic,
			phase: room.phase,
			turnSeatId:
				room.turn >= 0 && room.seats[room.turn] ? room.seats[room.turn]!.seatId : null,
			deadline: room.deadline,
			maxSeats: MAX_SEATS,
			dealer: {
				cards: dealerCards,
				value: reveal ? handValue(room.dealer).total : null,
			},
			seats: room.seats.map((s) =>
				s
					? {
							seatId: s.seatId,
							userId: s.userId,
							login: s.login,
							display_name: s.display_name,
							image_url: s.image_url,
							isBot: s.isBot,
							inRound: s.inRound,
							bet: s.bet,
							cards: s.cards,
							value: s.cards.length ? handValue(s.cards).total : 0,
							status: s.status,
							result: s.result,
							win: s.win,
							doubled: s.doubled,
						}
					: null,
			),
		},
	};
}

function broadcast(room: Room)
{
	room.lastActivity = Date.now();
	getServer()?.publish(`room:${room.id}`, JSON.stringify(publicView(room)));
}

// Periodically close rooms that have seen no activity.
setInterval(() =>
{
	const now = Date.now();
	for (const room of rooms.values())
	{
		if (now - room.lastActivity > IDLE_MS) closeRoom(room);
	}
}, 60_000);

export function roomViewJSON(id: string): string | null
{
	const room = rooms.get(id);
	return room ? JSON.stringify(publicView(room)) : null;
}

function closeRoom(room: Room)
{
	clearTimer(room);
	getServer()?.publish(
		`room:${room.id}`,
		JSON.stringify({ type: "room_closed", id: room.id }),
	);
	rooms.delete(room.id);
}

// ── Game flow ───────────────────────────────────────────────────────────
function startRound(room: Room)
{
	if (room.phase !== "waiting") return;
	if (occupied(room).length === 0) return;
	room.phase = "betting";
	room.dealer = [];
	for (const s of occupied(room))
	{
		s.inRound = false;
		s.bet = 0;
		s.cards = [];
		s.status = "idle";
		s.result = null;
		s.win = 0;
		s.doubled = false;
		if (s.isBot)
		{
			s.bet = BOT_BET;
			s.inRound = true;
			s.status = "bet";
		}
	}
	clearTimer(room);
	room.deadline = Date.now() + BET_MS;
	room.timer = setTimeout(() => deal(room), BET_MS);
	broadcast(room);
	maybeDeal(room);
}

function maybeDeal(room: Room)
{
	const occ = occupied(room);
	if (occ.length && occ.every((s) => s.bet > 0)) deal(room);
}

function deal(room: Room)
{
	if (room.phase !== "betting") return;
	clearTimer(room);
	const players = occupied(room).filter((s) => s.bet > 0);
	if (!players.length)
	{
		room.phase = "waiting";
		broadcast(room);
		return;
	}
	room.phase = "playing";
	room.dealer = [draw(room), draw(room)];
	for (const s of players)
	{
		s.inRound = true;
		s.cards = [draw(room), draw(room)];
		s.status = isBlackjack(s.cards) ? "blackjack" : "playing";
	}
	room.turn = -1;
	broadcast(room);
	nextTurn(room);
}

function nextTurn(room: Room)
{
	clearTimer(room);
	const start = room.turn + 1;
	for (let i = start; i < room.seats.length; i++)
	{
		const s = room.seats[i];
		if (s && s.inRound && s.status === "playing")
		{
			room.turn = i;
			room.deadline = Date.now() + TURN_MS;
			broadcast(room);
			if (s.isBot)
			{
				room.timer = setTimeout(() => botMove(room, s), 1000);
			}
			else
			{
				room.timer = setTimeout(() =>
				{
					s.status = "stand";
					nextTurn(room);
				}, TURN_MS);
			}
			return;
		}
	}
	room.turn = -1;
	dealerPlay(room);
}

function botMove(room: Room, s: Seat)
{
	if (room.seats[room.turn] !== s) return;
	const { total } = handValue(s.cards);
	if (total < 17)
	{
		s.cards.push(draw(room));
		if (handValue(s.cards).total > 21)
		{
			s.status = "bust";
			broadcast(room);
			nextTurn(room);
		}
		else
		{
			broadcast(room);
			room.timer = setTimeout(() => botMove(room, s), 1000);
		}
	}
	else
	{
		s.status = "stand";
		broadcast(room);
		nextTurn(room);
	}
}

async function dealerPlay(room: Room)
{
	clearTimer(room);
	room.phase = "dealer";
	broadcast(room);
	const anyLive = occupied(room).some(
		(s) => s.inRound && (s.status === "stand" || s.status === "blackjack"),
	);
	if (anyLive) while (handValue(room.dealer).total < 17) room.dealer.push(draw(room));
	setTimeout(() => settle(room), 1200);
}

async function settle(room: Room)
{
	const dv = handValue(room.dealer).total;
	const dealerBJ = isBlackjack(room.dealer);
	for (const s of occupied(room))
	{
		if (!s.inRound) continue;
		const pv = handValue(s.cards).total;
		const bj = s.status === "blackjack";
		let credited = 0;
		if (s.status === "bust")
		{
			s.result = "bust";
		}
		else if (bj && !dealerBJ)
		{
			s.result = "blackjack";
			credited = s.bet + Math.floor(s.bet * 1.5);
			s.win = Math.floor(s.bet * 1.5);
		}
		else if (dealerBJ && !bj)
		{
			s.result = "lose";
		}
		else if (dv > 21 || pv > dv)
		{
			s.result = "win";
			credited = s.bet * 2;
			s.win = s.bet;
		}
		else if (pv === dv)
		{
			s.result = "push";
			credited = s.bet;
		}
		else
		{
			s.result = "lose";
		}
		s.status = "done";
		if (!s.isBot && s.userId && credited > 0) await credit(s.userId, credited);
	}
	room.phase = "payout";
	broadcast(room);
	void publishLeaderboard();
	clearTimer(room);
	room.timer = setTimeout(() =>
	{
		if (humans(room).length === 0)
		{
			closeRoom(room);
			return;
		}
		room.phase = "waiting";
		room.dealer = [];
		for (const s of occupied(room))
		{
			s.inRound = false;
			s.bet = 0;
			s.cards = [];
			s.status = "idle";
			s.result = null;
			s.win = 0;
			s.doubled = false;
		}
		room.turn = -1;
		broadcast(room);
	}, PAYOUT_MS);
}

// ── Plugin ────────────────────────────────────────────────────────────────
export const blackjack = new Elysia({ prefix: "/api/bj" })
	.use(jwt({ name: "jwt", secret: SESSION_SECRET }))
	.derive(async ({ jwt, cookie: { session } }) =>
	{
		const payload = session.value ? await jwt.verify(session.value as string) : false;
		return { userId: payload && payload.sub ? Number(payload.sub) : null };
	})
	.onBeforeHandle(({ userId, set }) =>
	{
		if (!userId)
		{
			set.status = 401;
			return { error: "non authentifie" };
		}
	})

	.get("/rooms", () => ({
		rooms: [...rooms.values()]
			.filter((r) => r.isPublic && r.phase === "waiting")
			.map((r) => ({
				id: r.id,
				name: r.name,
				host: occupied(r).find((s) => s.userId === r.hostId)?.login ?? "?",
				players: occupied(r).length,
				maxSeats: MAX_SEATS,
			})),
	}))

	.post(
		"/rooms",
		async ({ userId, body }) =>
		{
			const me = await card(userId!);
			if (!me) return { error: "user introuvable" };
			const room: Room = {
				id: genId(),
				code: genCode(),
				name: (body.name?.trim() || `Table de ${me.login}`).slice(0, 40),
				hostId: userId!,
				isPublic: body.isPublic ?? true,
				seats: Array(MAX_SEATS).fill(null),
				phase: "waiting",
				shoe: freshShoe(),
				dealer: [],
				turn: -1,
				deadline: null,
				timer: null,
				lastActivity: Date.now(),
			};
			room.seats[0] = newSeat(me);
			rooms.set(room.id, room);
			return { id: room.id, code: room.code };
		},
		{ body: t.Object({ name: t.Optional(t.String()), isPublic: t.Optional(t.Boolean()) }) },
	)

	.post("/join", async ({ userId, body, set }) =>
	{
		const room = [...rooms.values()].find((r) => r.code === body.code.toUpperCase());
		if (!room)
		{
			set.status = 404;
			return { error: "room introuvable" };
		}
		return doJoin(room, userId!, set);
	}, { body: t.Object({ code: t.String() }) })

	.post("/rooms/:id/join", async ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room)
		{
			set.status = 404;
			return { error: "room introuvable" };
		}
		return doJoin(room, userId!, set);
	})

	.post("/rooms/:id/leave", ({ userId, params }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return { ok: true };
		const idx = room.seats.findIndex((s) => s && s.userId === userId);
		if (idx >= 0) room.seats[idx] = null;
		if (humans(room).length === 0)
		{
			closeRoom(room);
			return { ok: true };
		}
		if (room.hostId === userId) room.hostId = humans(room)[0].userId!;
		broadcast(room);
		return { ok: true };
	})

	.post("/rooms/:id/start", ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		if (room.hostId !== userId) return err(set, 403, "seul l'hote peut lancer");
		startRound(room);
		return { ok: true };
	})

	.post("/rooms/:id/bot", ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		if (room.hostId !== userId) return err(set, 403, "hote seulement");
		if (room.phase !== "waiting") return err(set, 400, "partie en cours");
		const idx = room.seats.findIndex((s) => !s);
		if (idx < 0) return err(set, 400, "table pleine");
		const n = occupied(room).filter((s) => s.isBot).length + 1;
		room.seats[idx] = {
			seatId: genId(),
			userId: null,
			login: `Bot ${n}`,
			display_name: `Bot ${n}`,
			image_url: null,
			isBot: true,
			inRound: false,
			bet: 0,
			cards: [],
			status: "idle",
			result: null,
			win: 0,
			doubled: false,
		};
		broadcast(room);
		return { ok: true };
	})

	.post(
		"/rooms/:id/bet",
		async ({ userId, params, body, set }) =>
		{
			const room = rooms.get(params.id);
			if (!room) return err(set, 404, "room introuvable");
			if (room.phase !== "betting") return err(set, 400, "pas en phase de mise");
			const s = seatOfUser(room, userId!);
			if (!s) return err(set, 403, "pas a cette table");
			if (s.bet > 0) return err(set, 400, "deja mise");
			const amount = Math.floor(body.amount);
			if (amount < MIN_BET || amount > MAX_BET)
				return err(set, 422, `mise entre ${MIN_BET} et ${MAX_BET}`);
			s.bet = -1; // optimistic lock avant l'await
			if (!(await debit(userId!, amount))) { s.bet = 0; return err(set, 400, "solde insuffisant"); }
			s.bet = amount;
			s.inRound = true;
			s.status = "bet";
			broadcast(room);
			maybeDeal(room);
			return { ok: true };
		},
		{ body: t.Object({ amount: t.Integer() }) },
	)

	.post("/rooms/:id/hit", ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		const s = currentSeat(room, userId!);
		if (!s) return err(set, 400, "pas ton tour");
		s.cards.push(draw(room));
		if (handValue(s.cards).total > 21)
		{
			s.status = "bust";
			broadcast(room);
			nextTurn(room);
		}
		else if (handValue(s.cards).total === 21)
		{
			s.status = "stand";
			broadcast(room);
			nextTurn(room);
		}
		else
		{
			room.deadline = Date.now() + TURN_MS;
			clearTimer(room);
			room.timer = setTimeout(() =>
			{
				s.status = "stand";
				nextTurn(room);
			}, TURN_MS);
			broadcast(room);
		}
		return { ok: true };
	})

	.post("/rooms/:id/stand", ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		const s = currentSeat(room, userId!);
		if (!s) return err(set, 400, "pas ton tour");
		s.status = "stand";
		broadcast(room);
		nextTurn(room);
		return { ok: true };
	})

	.post("/rooms/:id/double", async ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		const s = currentSeat(room, userId!);
		if (!s) return err(set, 400, "pas ton tour");
		if (s.cards.length !== 2 || s.doubled) return err(set, 400, "double impossible");
		s.doubled = true; // optimistic lock avant l'await
		if (!(await debit(userId!, s.bet))) { s.doubled = false; return err(set, 400, "solde insuffisant"); }
		s.bet *= 2;
		s.cards.push(draw(room));
		s.status = handValue(s.cards).total > 21 ? "bust" : "stand";
		broadcast(room);
		nextTurn(room);
		return { ok: true };
	})

	.post(
		"/rooms/:id/invite",
		async ({ userId, params, body, set }) =>
		{
			const room = rooms.get(params.id);
			if (!room) return err(set, 404, "room introuvable");
			// must be friends
			const fr = (await sql`
				SELECT 1 FROM friendships WHERE status='accepted'
					AND ((requester_id=${userId} AND addressee_id=${body.friendId})
						OR (requester_id=${body.friendId} AND addressee_id=${userId}))
			`) as unknown[];
			if (!fr.length) return err(set, 403, "pas ami");
			const me = await card(userId!);
			publishToUser(body.friendId, {
				type: "bj_invite",
				from: me,
				roomId: room.id,
				code: room.code,
				name: room.name,
			});
			if (me)
				await pushNotif(body.friendId, {
					kind: "bj_invite",
					message: `${me.login} t'invite au blackjack`,
					from: me,
					link: `/table?room=${room.id}`,
				});
			return { ok: true };
		},
		{ body: t.Object({ friendId: t.Integer() }) },
	);

// ── small helpers used above ───────────────────────────────────────────
function err(set: { status?: number | string }, code: number, msg: string)
{
	set.status = code;
	return { error: msg };
}
function currentSeat(room: Room, userId: number): Seat | null
{
	if (room.phase !== "playing" || room.turn < 0) return null;
	const s = room.seats[room.turn];
	return s && s.userId === userId && s.status === "playing" ? s : null;
}
function newSeat(u: {
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
}): Seat
{
	return {
		seatId: genId(),
		userId: u.id,
		login: u.login,
		display_name: u.display_name,
		image_url: u.image_url,
		isBot: false,
		inRound: false,
		bet: 0,
		cards: [],
		status: "idle",
		result: null,
		win: 0,
		doubled: false,
	};
}
async function card(userId: number)
{
	const rows = (await sql`
		SELECT id, login, display_name, image_url FROM users WHERE id = ${userId}
	`) as Array<{
		id: number;
		login: string;
		display_name: string | null;
		image_url: string | null;
	}>;
	return rows[0] ?? null;
}
async function doJoin(
	room: Room,
	userId: number,
	set: { status?: number | string },
)
{
	if (seatOfUser(room, userId)) return { id: room.id };
	if (room.phase !== "waiting") return err(set, 400, "partie en cours");
	const idx = room.seats.findIndex((s) => !s);
	if (idx < 0) return err(set, 400, "table pleine");
	const me = await card(userId);
	if (!me) return err(set, 400, "user introuvable");
	room.seats[idx] = newSeat(me);
	broadcast(room);
	return { id: room.id };
}
