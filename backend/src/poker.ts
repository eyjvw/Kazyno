import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";
import { publishBalance, publishLeaderboard, publishToUser, getServer } from "./realtime";
import { recordStat } from "./gamestats";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-change-me";

// ── Texas Hold'em ─────────────────────────────────────────────────────────────
// Table stakes simplifiées : à chaque main, la mise max de la main est plafonnée
// au plus petit solde des joueurs actifs (pas de side pots). Les mises débitent
// les points immédiatement ; le pot est crédité au(x) gagnant(s).

const MAX_SEATS = 6;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_SIT_POINTS = 200;
const TURN_MS = 30_000;
const SHOWDOWN_MS = 8_000;
const IDLE_MS = 10 * 60 * 1000;

type Phase = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";

interface Card
{
	r: number; // 2..14
	s: string; // ♠ ♥ ♦ ♣
}

interface Seat
{
	seatId: string;
	userId: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
	// per-hand state
	cards: Card[];
	folded: boolean;
	allIn: boolean;
	roundBet: number;   // committed this betting round
	totalBet: number;   // committed this hand
	acted: boolean;
	handCap: number;    // stack cap at hand start
	result: string | null; // showdown hand name / "fold" / "win"
	won: number;
	left: boolean;
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
	deck: Card[];
	board: Card[];
	pot: number;
	button: number;      // seat index of dealer button
	turn: number;        // seat index to act, or -1
	currentBet: number;  // highest roundBet this round
	minRaise: number;
	deadline: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	lastActivity: number;
}

const rooms = new Map<string, Room>();

// ── Deck & eval ───────────────────────────────────────────────────────────────
const SUITS = ["♠", "♥", "♦", "♣"];
const RANK_TXT: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };

function rnd(n: number): number
{
	const b = new Uint32Array(1);
	crypto.getRandomValues(b);
	return Math.floor((b[0] / 2 ** 32) * n);
}

function freshDeck(): Card[]
{
	const cards: Card[] = [];
	for (const s of SUITS) for (let r = 2; r <= 14; r++) cards.push({ r, s });
	for (let i = cards.length - 1; i > 0; i--)
	{
		const j = rnd(i + 1);
		[cards[i], cards[j]] = [cards[j], cards[i]];
	}
	return cards;
}

const HAND_NAMES = [
	"Carte haute", "Paire", "Double paire", "Brelan", "Quinte",
	"Couleur", "Full", "Carré", "Quinte flush",
];

// Score a 5-card hand: [category, tiebreakers...] comparable lexicographically.
function score5(cards: Card[]): number[]
{
	const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
	const flush = cards.every((c) => c.s === cards[0].s);
	// Straight (A-5 wheel handled)
	let straightHigh = 0;
	const uniq = [...new Set(ranks)];
	if (uniq.length === 5)
	{
		if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
		else if (uniq[0] === 14 && uniq[1] === 5 && uniq[1] - uniq[4] === 3) straightHigh = 5;
	}
	const counts = new Map<number, number>();
	for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
	// Sort by count desc, then rank desc.
	const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
	const kick = groups.flatMap(([r, n]) => Array(n).fill(r) as number[]);

	if (flush && straightHigh) return [8, straightHigh];
	if (groups[0][1] === 4) return [7, ...kick];
	if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...kick];
	if (flush) return [5, ...ranks];
	if (straightHigh) return [4, straightHigh];
	if (groups[0][1] === 3) return [3, ...kick];
	if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...kick];
	if (groups[0][1] === 2) return [1, ...kick];
	return [0, ...ranks];
}

function cmpScore(a: number[], b: number[]): number
{
	for (let i = 0; i < Math.max(a.length, b.length); i++)
	{
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

// Best 5-of-7.
function best7(cards: Card[]): { score: number[]; name: string }
{
	let best: number[] | null = null;
	for (let i = 0; i < 7; i++)
	{
		for (let j = i + 1; j < 7; j++)
		{
			const five = cards.filter((_, k) => k !== i && k !== j);
			const s = score5(five);
			if (!best || cmpScore(s, best) > 0) best = s;
		}
	}
	return { score: best!, name: HAND_NAMES[best![0]] };
}

// ── Balance ───────────────────────────────────────────────────────────────────
async function debit(userId: number, amount: number): Promise<boolean>
{
	if (amount <= 0) return true;
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

// ── Room helpers ──────────────────────────────────────────────────────────────
const genId = () => "p" + crypto.randomUUID().slice(0, 7);
const genCode = () =>
{
	let c = "";
	for (let i = 0; i < 5; i++) c += "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[rnd(31)];
	return c;
};
const occupied = (room: Room) => room.seats.filter((s): s is Seat => !!s);
const present = (room: Room) => occupied(room).filter((s) => !s.left);
const seatOfUser = (room: Room, userId: number) =>
	room.seats.find((s) => s && s.userId === userId) ?? null;
const inHand = (room: Room) => occupied(room).filter((s) => s.cards.length > 0 && !s.folded);

function clearTimer(room: Room)
{
	if (room.timer) clearTimeout(room.timer);
	room.timer = null;
	room.deadline = null;
}

function cardView(c: Card)
{
	return { r: RANK_TXT[c.r] ?? String(c.r), s: c.s };
}

function publicView(room: Room)
{
	const showdown = room.phase === "showdown";
	return {
		type: "poker",
		room: {
			id: room.id,
			code: room.code,
			name: room.name,
			hostId: room.hostId,
			isPublic: room.isPublic,
			phase: room.phase,
			pot: room.pot,
			board: room.board.map(cardView),
			currentBet: room.currentBet,
			minRaise: room.minRaise,
			buttonSeatId: room.button >= 0 && room.seats[room.button] ? room.seats[room.button]!.seatId : null,
			turnSeatId: room.turn >= 0 && room.seats[room.turn] ? room.seats[room.turn]!.seatId : null,
			deadline: room.deadline,
			maxSeats: MAX_SEATS,
			blinds: { small: SMALL_BLIND, big: BIG_BLIND },
			seats: room.seats.map((s) =>
				s
					? {
							seatId: s.seatId,
							userId: s.userId,
							login: s.login,
							display_name: s.display_name,
							image_url: s.image_url,
							inHand: s.cards.length > 0 && !s.folded,
							folded: s.folded,
							allIn: s.allIn,
							roundBet: s.roundBet,
							totalBet: s.totalBet,
							result: s.result,
							won: s.won,
							left: s.left,
							// Hole cards only revealed at showdown for non-folded players.
							cards: showdown && !s.folded && s.cards.length ? s.cards.map(cardView) : [],
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

function sendHole(room: Room, s: Seat)
{
	publishToUser(s.userId, {
		type: "poker_hole",
		roomId: room.id,
		cards: s.cards.map(cardView),
	});
}

export function pokerViewJSON(id: string): string | null
{
	const room = rooms.get(id);
	return room ? JSON.stringify(publicView(room)) : null;
}

function closeRoom(room: Room)
{
	clearTimer(room);
	getServer()?.publish(`room:${room.id}`, JSON.stringify({ type: "room_closed", id: room.id }));
	rooms.delete(room.id);
}

setInterval(() =>
{
	const now = Date.now();
	for (const room of rooms.values())
	{
		if (now - room.lastActivity > IDLE_MS) closeRoom(room);
	}
}, 60_000);

// ── Hand flow ─────────────────────────────────────────────────────────────────
async function startHand(room: Room)
{
	if (room.phase !== "waiting") return;
	// Drop seats of players who left between hands.
	room.seats = room.seats.map((s) => (s && s.left ? null : s));
	const players = occupied(room);
	if (players.length < 2) { broadcast(room); return; }

	// Stack cap = smallest balance among seated players (table stakes, no side pots).
	const balances = new Map<number, number>();
	for (const s of players)
	{
		const [u] = (await sql`SELECT points FROM users WHERE id = ${s.userId}`) as Array<{ points: number }>;
		balances.set(s.userId, u?.points ?? 0);
	}
	// Kick players who can't cover the big blind.
	for (let i = 0; i < room.seats.length; i++)
	{
		const s = room.seats[i];
		if (s && (balances.get(s.userId) ?? 0) < BIG_BLIND)
		{
			publishToUser(s.userId, { type: "poker_kick", roomId: room.id, reason: "solde insuffisant" });
			room.seats[i] = null;
		}
	}
	const active = occupied(room);
	if (active.length < 2) { broadcast(room); return; }
	const cap = Math.min(...active.map((s) => balances.get(s.userId) ?? 0));

	room.deck = freshDeck();
	room.board = [];
	room.pot = 0;
	room.currentBet = 0;
	room.minRaise = BIG_BLIND;
	for (const s of active)
	{
		s.cards = [room.deck.pop()!, room.deck.pop()!];
		s.folded = false;
		s.allIn = false;
		s.roundBet = 0;
		s.totalBet = 0;
		s.acted = false;
		s.handCap = cap;
		s.result = null;
		s.won = 0;
	}

	// Rotate the button to the next occupied seat.
	room.button = nextOccupied(room, room.button);
	const sbIdx = active.length === 2 ? room.button : nextOccupied(room, room.button);
	const bbIdx = nextOccupied(room, sbIdx);

	room.phase = "preflop";
	await postBlind(room, room.seats[sbIdx]!, SMALL_BLIND);
	await postBlind(room, room.seats[bbIdx]!, BIG_BLIND);
	room.currentBet = BIG_BLIND;

	for (const s of active) sendHole(room, s);
	room.turn = nextOccupied(room, bbIdx);
	armTurnTimer(room);
	broadcast(room);
}

function nextOccupied(room: Room, from: number): number
{
	for (let i = 1; i <= room.seats.length; i++)
	{
		const idx = (from + i) % room.seats.length;
		const s = room.seats[idx];
		if (s && s.cards.length > 0 && !s.folded && !s.allIn) return idx;
	}
	// fall back to any occupied seat (button rotation before dealing)
	for (let i = 1; i <= room.seats.length; i++)
	{
		const idx = (from + i) % room.seats.length;
		if (room.seats[idx]) return idx;
	}
	return from;
}

async function postBlind(room: Room, s: Seat, amount: number)
{
	const a = Math.min(amount, s.handCap);
	if (!(await debit(s.userId, a)))
	{
		s.folded = true;
		return;
	}
	s.roundBet = a;
	s.totalBet = a;
	room.pot += a;
	if (a >= s.handCap) s.allIn = true;
}

function armTurnTimer(room: Room)
{
	clearTimer(room);
	if (room.turn < 0) return;
	room.deadline = Date.now() + TURN_MS;
	const seat = room.seats[room.turn]!;
	room.timer = setTimeout(() =>
	{
		// Auto: check if free, else fold.
		if (seat.roundBet >= room.currentBet)
		{
			seat.acted = true;
			advance(room);
		}
		else
		{
			seat.folded = true;
			seat.result = "fold";
			advance(room);
		}
	}, TURN_MS);
}

function roundDone(room: Room): boolean
{
	const live = inHand(room).filter((s) => !s.allIn);
	if (inHand(room).length <= 1) return true;
	return live.every((s) => s.acted && s.roundBet === room.currentBet);
}

function advance(room: Room)
{
	// Only one player left → wins pot immediately.
	if (inHand(room).length <= 1)
	{
		void showdown(room, true);
		return;
	}
	if (!roundDone(room))
	{
		room.turn = nextOccupied(room, room.turn);
		armTurnTimer(room);
		broadcast(room);
		return;
	}
	// Next street.
	for (const s of occupied(room))
	{
		s.roundBet = 0;
		s.acted = false;
	}
	room.currentBet = 0;
	room.minRaise = BIG_BLIND;
	clearTimer(room);

	if (room.phase === "preflop")
	{
		room.phase = "flop";
		room.board.push(room.deck.pop()!, room.deck.pop()!, room.deck.pop()!);
	}
	else if (room.phase === "flop")
	{
		room.phase = "turn";
		room.board.push(room.deck.pop()!);
	}
	else if (room.phase === "turn")
	{
		room.phase = "river";
		room.board.push(room.deck.pop()!);
	}
	else
	{
		void showdown(room, false);
		return;
	}

	// Everyone all-in → run out the board automatically.
	const canAct = inHand(room).filter((s) => !s.allIn);
	if (canAct.length <= 1)
	{
		broadcast(room);
		setTimeout(() => advance(room), 1200);
		return;
	}
	room.turn = nextOccupied(room, room.button);
	armTurnTimer(room);
	broadcast(room);
}

async function showdown(room: Room, byFold: boolean)
{
	clearTimer(room);
	room.turn = -1;
	const contenders = inHand(room);

	let winners: Seat[];
	if (byFold || contenders.length === 1)
	{
		winners = contenders;
		if (winners[0]) winners[0].result = "win";
	}
	else
	{
		// Complete the board if needed (all-in before river).
		while (room.board.length < 5) room.board.push(room.deck.pop()!);
		let best: number[] | null = null;
		for (const s of contenders)
		{
			const r = best7([...s.cards, ...room.board]);
			s.result = r.name;
			(s as Seat & { _score?: number[] })._score = r.score;
			if (!best || cmpScore(r.score, best) > 0) best = r.score;
		}
		winners = contenders.filter(
			(s) => cmpScore((s as Seat & { _score?: number[] })._score!, best!) === 0,
		);
	}

	const share = winners.length ? Math.floor(room.pot / winners.length) : 0;
	for (const w of winners)
	{
		w.won = share;
		await credit(w.userId, share);
	}
	for (const s of occupied(room))
	{
		if (s.cards.length === 0) continue;
		void recordStat(s.userId, "poker", s.totalBet, s.won);
	}
	void publishLeaderboard();

	room.phase = "showdown";
	room.pot = 0;
	broadcast(room);

	room.timer = setTimeout(() =>
	{
		room.phase = "waiting";
		room.board = [];
		room.currentBet = 0;
		for (const s of occupied(room))
		{
			s.cards = [];
			s.folded = false;
			s.allIn = false;
			s.roundBet = 0;
			s.totalBet = 0;
			s.acted = false;
			s.result = null;
			s.won = 0;
		}
		room.seats = room.seats.map((s) => (s && s.left ? null : s));
		if (present(room).length === 0)
		{
			closeRoom(room);
			return;
		}
		if (!present(room).some((s) => s.userId === room.hostId))
			room.hostId = present(room)[0].userId;
		broadcast(room);
		// Auto-deal the next hand if 2+ players remain.
		if (occupied(room).length >= 2) void startHand(room);
	}, SHOWDOWN_MS);
}

// ── Plugin ────────────────────────────────────────────────────────────────────
function err(set: { status?: number | string }, code: number, msg: string)
{
	set.status = code;
	return { error: msg };
}

async function userCard(userId: number)
{
	const rows = (await sql`
		SELECT id, login, display_name, image_url, points FROM users WHERE id = ${userId}
	`) as Array<{ id: number; login: string; display_name: string | null; image_url: string | null; points: number }>;
	return rows[0] ?? null;
}

function newSeat(u: { id: number; login: string; display_name: string | null; image_url: string | null }): Seat
{
	return {
		seatId: genId(),
		userId: u.id,
		login: u.login,
		display_name: u.display_name,
		image_url: u.image_url,
		cards: [],
		folded: false,
		allIn: false,
		roundBet: 0,
		totalBet: 0,
		acted: false,
		handCap: 0,
		result: null,
		won: 0,
		left: false,
	};
}

async function doJoin(room: Room, userId: number, set: { status?: number | string })
{
	const mine = seatOfUser(room, userId);
	if (mine)
	{
		if (mine.left)
		{
			mine.left = false;
			broadcast(room);
		}
		return { id: room.id };
	}
	const idx = room.seats.findIndex((s) => !s);
	if (idx < 0) return err(set, 400, "table pleine");
	const me = await userCard(userId);
	if (!me) return err(set, 400, "user introuvable");
	if (me.points < MIN_SIT_POINTS) return err(set, 400, `minimum ${MIN_SIT_POINTS} pts pour s'asseoir`);
	room.seats[idx] = newSeat(me);
	broadcast(room);
	return { id: room.id };
}

export const poker = new Elysia({ prefix: "/api/poker" })
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
			.filter((r) => r.isPublic)
			.map((r) => ({
				id: r.id,
				name: r.name,
				host: occupied(r).find((s) => s.userId === r.hostId)?.login ?? "?",
				players: occupied(r).length,
				maxSeats: MAX_SEATS,
				phase: r.phase,
			})),
	}))

	.post(
		"/rooms",
		async ({ userId, body, set }) =>
		{
			const me = await userCard(userId!);
			if (!me) return err(set, 400, "user introuvable");
			if (me.points < MIN_SIT_POINTS) return err(set, 400, `minimum ${MIN_SIT_POINTS} pts`);
			const room: Room = {
				id: genId(),
				code: genCode(),
				name: (body.name?.trim() || `Table de ${me.login}`).slice(0, 40),
				hostId: userId!,
				isPublic: body.isPublic ?? true,
				seats: Array(MAX_SEATS).fill(null),
				phase: "waiting",
				deck: [],
				board: [],
				pot: 0,
				button: -1,
				turn: -1,
				currentBet: 0,
				minRaise: BIG_BLIND,
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
		if (!room) return err(set, 404, "room introuvable");
		return doJoin(room, userId!, set);
	}, { body: t.Object({ code: t.String() }) })

	.post("/rooms/:id/join", async ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		return doJoin(room, userId!, set);
	})

	.post("/rooms/:id/leave", ({ userId, params }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return { ok: true };
		const idx = room.seats.findIndex((s) => s && s.userId === userId);
		if (idx < 0) return { ok: true };
		const s = room.seats[idx]!;

		if (room.phase !== "waiting" && s.cards.length > 0 && !s.folded)
		{
			// Mid-hand: fold the hand, free the seat after the hand.
			s.left = true;
			s.folded = true;
			s.result = "fold";
			const wasTurn = room.turn === idx;
			broadcast(room);
			if (wasTurn) advance(room);
			else if (inHand(room).length <= 1) void showdown(room, true);
			return { ok: true };
		}

		room.seats[idx] = null;
		if (present(room).length === 0)
		{
			closeRoom(room);
			return { ok: true };
		}
		if (room.hostId === userId) room.hostId = present(room)[0].userId;
		broadcast(room);
		return { ok: true };
	})

	.post("/rooms/:id/start", async ({ userId, params, set }) =>
	{
		const room = rooms.get(params.id);
		if (!room) return err(set, 404, "room introuvable");
		if (room.hostId !== userId) return err(set, 403, "seul l'hote peut lancer");
		if (room.phase !== "waiting") return err(set, 400, "main en cours");
		if (occupied(room).length < 2) return err(set, 400, "il faut 2 joueurs minimum");
		await startHand(room);
		return { ok: true };
	})

	.post(
		"/rooms/:id/action",
		async ({ userId, params, body, set }) =>
		{
			const room = rooms.get(params.id);
			if (!room) return err(set, 404, "room introuvable");
			if (room.turn < 0 || !room.seats[room.turn] || room.seats[room.turn]!.userId !== userId)
				return err(set, 400, "pas ton tour");
			const s = room.seats[room.turn]!;
			const toCall = room.currentBet - s.roundBet;

			if (body.action === "fold")
			{
				s.folded = true;
				s.result = "fold";
				s.acted = true;
				advance(room);
				return { ok: true };
			}

			if (body.action === "check")
			{
				if (toCall > 0) return err(set, 400, "impossible de checker");
				s.acted = true;
				advance(room);
				return { ok: true };
			}

			if (body.action === "call")
			{
				const amount = Math.min(toCall, s.handCap - s.totalBet);
				if (amount < 0) return err(set, 400, "rien à suivre");
				s.acted = true; // optimistic lock before the await
				if (!(await debit(userId!, amount)))
				{
					s.folded = true;
					s.result = "fold";
					advance(room);
					return err(set, 400, "solde insuffisant — couché");
				}
				s.roundBet += amount;
				s.totalBet += amount;
				room.pot += amount;
				if (s.totalBet >= s.handCap) s.allIn = true;
				advance(room);
				return { ok: true };
			}

			// raise: body.amount = raise TO (total roundBet target).
			const target = Math.floor(body.amount ?? 0);
			const minTarget = room.currentBet + room.minRaise;
			const maxTarget = s.handCap - s.totalBet + s.roundBet;
			if (target < minTarget && target < maxTarget)
				return err(set, 422, `relance minimum : ${minTarget}`);
			const capped = Math.min(target, maxTarget);
			const add = capped - s.roundBet;
			if (add <= 0) return err(set, 422, "relance invalide");

			s.acted = true;
			if (!(await debit(userId!, add)))
			{
				s.acted = false;
				return err(set, 400, "solde insuffisant");
			}
			room.minRaise = Math.max(room.minRaise, capped - room.currentBet);
			s.roundBet = capped;
			s.totalBet += add;
			room.pot += add;
			room.currentBet = Math.max(room.currentBet, capped);
			if (s.totalBet >= s.handCap) s.allIn = true;
			// A raise reopens action for everyone else.
			for (const o of inHand(room)) if (o !== s && !o.allIn) o.acted = false;
			advance(room);
			return { ok: true };
		},
		{
			body: t.Object({
				action: t.Union([
					t.Literal("fold"), t.Literal("check"),
					t.Literal("call"), t.Literal("raise"),
				]),
				amount: t.Optional(t.Integer({ minimum: 1 })),
			}),
		},
	);
