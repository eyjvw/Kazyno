// Shared client helpers for auth state, balance, and placing bets.
import { syncLocale } from "./i18n";

export interface NotifPrefs
{
	rain: boolean;
	giveaway: boolean;
	social: boolean;
	exam: boolean;
	admin: boolean;
}

export interface Me
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
	points: number;
	locale: string;
	show_presence: boolean;
	notif_prefs: NotifPrefs;
	welcomed: boolean;
	core_reward_seen: boolean;
	piscine_reward_seen: boolean;
}

type BalanceListener = (points: number) => void;
const listeners = new Set<BalanceListener>();
let balance = 0;
let myId: number | null = null;

export const getMyId = () => myId;

const DEFAULT_PREFS: NotifPrefs = { rain: true, giveaway: true, social: true, exam: true, admin: true };
let showPresence = true;
let notifPrefs: NotifPrefs = { ...DEFAULT_PREFS };

export const getShowPresence = () => showPresence;
export const getNotifPrefs = () => notifPrefs;

/** Persist preference changes to the account and update local state. */
export async function setPrefs(patch: { show_presence?: boolean; notif_prefs?: Partial<NotifPrefs> })
{
	if (patch.show_presence !== undefined) showPresence = patch.show_presence;
	if (patch.notif_prefs) notifPrefs = { ...notifPrefs, ...patch.notif_prefs };
	try
	{
		await fetch("/api/auth/prefs", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
	} catch {}
}

/** Subscribe to balance changes; fires immediately with the current value. */
export function onBalance(fn: BalanceListener)
{
	listeners.add(fn);
	fn(balance);
}

function setBalance(points: number)
{
	balance = points;
	listeners.forEach((fn) => fn(points));
}

export function getBalance()
{
	return balance;
}

/** Fetch the current user; updates balance. Returns null if unauthenticated. */
export async function loadMe(): Promise<Me | null>
{
	try
	{
		const res = await fetch("/api/auth/me");
		if (!res.ok) return null;
		const data = await res.json();
		if (!data?.authenticated) return null;
		myId = data.user.id;
		setBalance(data.user.points);
		syncLocale(data.user.locale);
		showPresence = data.user.show_presence ?? true;
		notifPrefs = { ...DEFAULT_PREFS, ...(data.user.notif_prefs ?? {}) };
		return data.user as Me;
	} catch {
		return null;
	}
}

/** Dismiss the common-core +2000 popup (fire-and-forget). */
export function ackCoreReward()
{
	void fetch("/api/auth/core-seen", { method: "POST" }).catch(() => {});
}

/** Dismiss the piscine +1000 popup (fire-and-forget). */
export function ackPiscineReward()
{
	void fetch("/api/auth/piscine-seen", { method: "POST" }).catch(() => {});
}

export async function logout()
{
	await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
}

/** RGPD: permanently delete the current account. */
export async function deleteAccount(): Promise<boolean>
{
	try
	{
		const res = await fetch("/api/auth/account", { method: "DELETE" });
		return res.ok;
	} catch {
		return false;
	}
}

export interface BetResult
{
	win: boolean;
	payout: number;
	balance: number;
	multiplier?: number;
	[k: string]: unknown;
}

export class BetError extends Error {}

/** Place a bet on a game endpoint. Updates balance on success. */
export async function bet(
	game: string,
	body: Record<string, unknown>,
): Promise<BetResult>
{
	const res = await fetch(`/api/games/${game}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok)
	{
		throw new BetError(data?.error ?? "Erreur de mise");
	}
	setBalance(data.balance);
	return data as BetResult;
}

export const fmt = (n: number) => n.toLocaleString("fr-FR");

// ── Realtime (WebSocket) ────────────────────────────────────────────────
type LeaderListener = (rows: LeaderRow[]) => void;
const leaderListeners = new Set<LeaderListener>();
let ws: WebSocket | null = null;

export function onLeaderboard(fn: LeaderListener)
{
	leaderListeners.add(fn);
}

/** Open the live socket (balance + leaderboard pushes). Auto-reconnects. */
export function connectRealtime()
{
	if (ws) return;
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const sock = new WebSocket(`${proto}://${location.host}/api/ws`);
	ws = sock;
	sock.onmessage = (e) =>
	{
		let msg: any;
		try
		{
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		switch (msg.type)
		{
			case "balance":
				setBalance(msg.points);
				break;
			case "leaderboard":
				leaderListeners.forEach((fn) => fn(msg.leaderboard));
				break;
			case "presence":
				if (!showPresence) break; // opted out: don't see anyone else's status either
				if (msg.user.id === myId) break; // ignore self
				if (msg.online) onlineUsers.set(msg.user.id, msg.user);
				else onlineUsers.delete(msg.user.id);
				emitPresence();
				break;
			// Live list refresh signals (toasts handled via "notification")
			case "friend_request":
			case "friend_accepted":
			case "friend_removed":
				friendListeners.forEach((fn) => fn(msg));
				break;
			case "room":
			case "room_closed":
				roomListeners.forEach((fn) => fn(msg));
				break;
			case "bj_invite":
				inviteListeners.forEach((fn) => fn(msg));
				break;
			case "exam_settled":
				examListeners.forEach((fn) => fn(msg));
				break;
			case "giveaway_drawn":
				giveawayListeners.forEach((fn) => fn(msg));
				break;
			case "crash":
				crashListeners.forEach((fn) => fn(msg));
				break;
			case "achievement":
				toast(`🏆 Succès débloqué : ${msg.achievement.name} ${msg.achievement.icon}`, "/profile");
				achievementListeners.forEach((fn) => fn(msg.achievement));
				break;
			case "challenge_complete":
				toast(`✅ Défi complété : ${msg.challenge.desc} (+${fmt(msg.challenge.reward)} pts)`, "/app");
				challengeListeners.forEach((fn) => fn(msg.challenge));
				setBalance(msg.balance);
				break;
			case "notification":
				toast(msg.notif.message, msg.notif.link || undefined);
				notifListeners.forEach((fn) => fn());
				break;
			case "admin-log":
				adminLogListeners.forEach((fn) => fn(msg));
				break;
			case "jackpot":
				if (msg.won && msg.login) toast(`🎰 JACKPOT ! ${msg.login} remporte ${fmt(msg.won)} pts !`);
				jackpotListeners.forEach((fn) => fn(msg.amount));
				break;
			case "feed":
				feedListeners.forEach((fn) => fn(msg.item));
				break;
			case "rain":
				if (notifPrefs.rain) showRainBanner(msg);
				break;
			case "rain_update":
				if (msg.remaining <= 0) hideRainBanner();
				break;
			case "duel":
				duelListeners.forEach((fn) => fn(msg));
				break;
			case "poker":
			case "poker_hole":
			case "poker_kick":
				pokerListeners.forEach((fn) => fn(msg));
				break;
		}
	};
	sock.onopen = () => resubscribeRooms();
	sock.onclose = () =>
	{
		ws = null;
		setTimeout(connectRealtime, 2000);
	};
	sock.onerror = () => sock.close();
}

// ── Presence ────────────────────────────────────────────────────────────
export interface OnlineUser
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
}
const onlineUsers = new Map<number, OnlineUser>();
type PresenceListener = (list: OnlineUser[]) => void;
const presenceListeners = new Set<PresenceListener>();

function emitPresence()
{
	const list = [...onlineUsers.values()];
	presenceListeners.forEach((fn) => fn(list));
}
export function onPresence(fn: PresenceListener)
{
	presenceListeners.add(fn);
	fn([...onlineUsers.values()]);
}
export async function loadPresence()
{
	try
	{
		const res = await fetch("/api/presence");
		if (!res.ok) return;
		const data = await res.json();
		onlineUsers.clear();
		(data.online as OnlineUser[]).forEach((u) => onlineUsers.set(u.id, u));
		emitPresence();
	} catch {}
}

// ── Friends ─────────────────────────────────────────────────────────────
export interface FriendCard extends OnlineUser
{
	points?: number;
	online?: boolean;
}
type FriendListener = (ev: any) => void;
const friendListeners = new Set<FriendListener>();
export function onFriendEvent(fn: FriendListener)
{
	friendListeners.add(fn);
}

export async function getFriends(): Promise<FriendCard[]>
{
	try
	{
		const r = await fetch("/api/friends");
		return r.ok ? (await r.json()).friends : [];
	} catch {
		return [];
	}
}
export interface SearchResult extends OnlineUser
{
	status: "none" | "pending_out" | "pending_in" | "friend";
	online: boolean;
}
export async function searchUsers(q: string): Promise<SearchResult[]>
{
	try
	{
		const r = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
		return r.ok ? (await r.json()).results : [];
	} catch {
		return [];
	}
}

export interface RequestsData
{
	incoming: OnlineUser[];
	outgoing: OnlineUser[];
}
export async function getRequests(): Promise<RequestsData>
{
	try
	{
		const r = await fetch("/api/friends/requests");
		if (!r.ok) return { incoming: [], outgoing: [] };
		return await r.json();
	} catch {
		return { incoming: [], outgoing: [] };
	}
}
async function post(url: string, body?: unknown)
{
	const r = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export const sendFriendRequest = (login: string) =>
	post("/api/friends/request", { login });
export const acceptFriend = (userId: number) =>
	post("/api/friends/accept", { userId });
export const declineFriend = (userId: number) =>
	post("/api/friends/decline", { userId });
export const cancelFriend = (userId: number) =>
	post("/api/friends/cancel", { userId });
export async function removeFriend(userId: number)
{
	await fetch(`/api/friends/${userId}`, { method: "DELETE" });
}

// ── Toast ───────────────────────────────────────────────────────────────
export function toast(message: string, href?: string)
{
	let host = document.querySelector<HTMLElement>(".toast-host");
	if (!host)
	{
		host = document.createElement("div");
		host.className = "toast-host";
		document.body.appendChild(host);
	}
	const el = document.createElement(href ? "a" : "div") as HTMLElement;
	el.className = "toast" + (href ? " clickable" : "");
	if (href) (el as HTMLAnchorElement).href = href;

	const txt = document.createElement("span");
	txt.textContent = message;
	el.appendChild(txt);

	const dismiss = () =>
	{
		el.classList.remove("show");
		setTimeout(() => el.remove(), 300);
	};

	const btn = document.createElement("button");
	btn.className = "toast-close";
	btn.textContent = "✕";
	btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); dismiss(); });
	el.appendChild(btn);

	host.appendChild(el);
	requestAnimationFrame(() => el.classList.add("show"));
	setTimeout(dismiss, 6000);
}

// ── Blackjack realtime + API ──────────────────────────────────────────────
type RoomListener = (msg: any) => void;
const roomListeners = new Set<RoomListener>();
const inviteListeners = new Set<RoomListener>();
const subscribedRooms = new Set<string>();

export function onRoom(fn: RoomListener)
{
	roomListeners.add(fn);
	return () => roomListeners.delete(fn);
}
export function onBjInvite(fn: RoomListener)
{
	inviteListeners.add(fn);
}

function wsSend(obj: unknown)
{
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
export function subscribeRoom(id: string)
{
	subscribedRooms.add(id);
	wsSend({ type: "room:sub", id });
}
export function unsubscribeRoom(id: string)
{
	subscribedRooms.delete(id);
	wsSend({ type: "room:unsub", id });
}
/** Called from connectRealtime on (re)open to restore room subs. */
function resubscribeRooms()
{
	subscribedRooms.forEach((id) => wsSend({ type: "room:sub", id }));
}

const bjApi = async (path: string, body?: unknown) =>
{
	const r = await fetch(`/api/bj${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
};

export const bjCreateRoom = (name: string, isPublic: boolean) =>
	bjApi("/rooms", { name, isPublic });
export async function bjListRooms()
{
	try
	{
		const r = await fetch("/api/bj/rooms");
		return r.ok ? (await r.json()).rooms : [];
	} catch {
		return [];
	}
}
export const bjJoin = (id: string) => bjApi(`/rooms/${id}/join`);
export const bjJoinByCode = (code: string) => bjApi("/join", { code });
export const bjLeave = (id: string) => bjApi(`/rooms/${id}/leave`);
export const bjStart = (id: string) => bjApi(`/rooms/${id}/start`);
export const bjBet = (id: string, amount: number) => bjApi(`/rooms/${id}/bet`, { amount });
export const bjHit = (id: string) => bjApi(`/rooms/${id}/hit`);
export const bjStand = (id: string) => bjApi(`/rooms/${id}/stand`);
export const bjDouble = (id: string) => bjApi(`/rooms/${id}/double`);
export const bjAddBot = (id: string) => bjApi(`/rooms/${id}/bot`);
export const bjInvite = (id: string, friendId: number) =>
	bjApi(`/rooms/${id}/invite`, { friendId });

// ── Exam bets ─────────────────────────────────────────────────────────────
type ExamListener = (msg: any) => void;
const examListeners = new Set<ExamListener>();
export function onExamSettled(fn: ExamListener)
{
	examListeners.add(fn);
}
type GiveawayListener = (msg: any) => void;
const giveawayListeners = new Set<GiveawayListener>();
export function onGiveawayDrawn(fn: GiveawayListener)
{
	giveawayListeners.add(fn);
}
export async function getExamBets()
{
	try
	{
		const r = await fetch("/api/exam-bets/me");
		return r.ok ? await r.json() : { pending: null, history: [] };
	} catch {
		return { pending: null, history: [] };
	}
}
export async function getExamFeed()
{
	try
	{
		const r = await fetch("/api/exam-bets/feed");
		return r.ok ? (await r.json()).feed : [];
	} catch {
		return [];
	}
}
// ── Notifications ───────────────────────────────────────────────────────────
export interface Notif
{
	id?: number;
	kind: string;
	message: string;
	from_login: string | null;
	from_name: string | null;
	from_image: string | null;
	link: string | null;
	read: boolean;
	created_at: string;
}
type NotifListener = () => void;
const notifListeners = new Set<NotifListener>();
export function onNotification(fn: NotifListener)
{
	notifListeners.add(fn);
}

type AdminLogListener = (event: any) => void;
const adminLogListeners = new Set<AdminLogListener>();
export function onAdminLog(fn: AdminLogListener)
{
	adminLogListeners.add(fn);
}
export async function getNotifications(): Promise<{ items: Notif[]; unread: number }> {
	try
	{
		const r = await fetch("/api/notifications");
		return r.ok ? await r.json() : { items: [], unread: 0 };
	} catch {
		return { items: [], unread: 0 };
	}
}
export async function markNotifsRead()
{
	await fetch("/api/notifications/read", { method: "POST" }).catch(() => {});
}
export async function deleteNotif(id: number)
{
	await fetch(`/api/notifications/${id}`, { method: "DELETE" }).catch(() => {});
}
export async function clearNotifs()
{
	await fetch("/api/notifications", { method: "DELETE" }).catch(() => {});
}

// ── Admin ─────────────────────────────────────────────────────────────────
export async function adminMe(): Promise<boolean>
{
	try
	{
		const r = await fetch("/api/admin/me");
		return r.ok ? (await r.json()).isAdmin : false;
	} catch {
		return false;
	}
}
async function adminPost(path: string, body: unknown)
{
	const r = await fetch(`/api/admin${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function adminSearch(q: string)
{
	try
	{
		const r = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`);
		return r.ok ? (await r.json()).results : [];
	} catch {
		return [];
	}
}
export const adminNotify = (message: string, login?: string) =>
	adminPost("/notify", login ? { message, login } : { message });
export const adminAddPoints = (login: string, amount: number) =>
	adminPost("/points", { login, amount });
export const adminResetAll = () => adminPost("/reset-all", {});
export async function adminGetLogs(params: {
	login?: string; action?: string; from?: string; to?: string;
	limit?: number; offset?: number;
} = {})
{
	const q = new URLSearchParams();
	if (params.login)  q.set("login",  params.login);
	if (params.action) q.set("action", params.action);
	if (params.from)   q.set("from",   params.from);
	if (params.to)     q.set("to",     params.to);
	if (params.limit)  q.set("limit",  String(params.limit));
	if (params.offset) q.set("offset", String(params.offset));
	const r = await fetch(`/api/admin/logs?${q}`);
	if (!r.ok) throw new Error(await r.text());
	return r.json() as Promise<{ logs: any[]; total: number }>;
}

export async function getExams(): Promise<any[]>
{
	try
	{
		const r = await fetch("/api/exams");
		return r.ok ? (await r.json()).exams : [];
	} catch { return []; }
}
export interface ExamCtx
{
	common_core_done: boolean;
	exam_rank: number | null;
}
export async function getExamsWithCtx(): Promise<{ exams: any[]; ctx: ExamCtx | null }>
{
	try
	{
		const r = await fetch("/api/exams");
		if (!r.ok) return { exams: [], ctx: null };
		const d = await r.json();
		return { exams: d.exams ?? [], ctx: d.ctx ?? null };
	} catch { return { exams: [], ctx: null }; }
}
export async function placeExamBet(exam_id: number, predicted: number, stake: number)
{
	const r = await fetch("/api/exam-bets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ exam_id, predicted, stake }),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function modifyExamBet(betId: number, predicted: number, stake: number)
{
	const r = await fetch(`/api/exam-bets/${betId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ predicted, stake }),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function cancelExamBet(betId: number)
{
	const r = await fetch(`/api/exam-bets/${betId}`, { method: "DELETE" });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}

// Giveaways
export interface Giveaway
{
	id: number;
	title: string;
	description: string | null;
	prize_points: number;
	ends_at: string;
	created_at: string;
	entry_count: number;
	entered: boolean;
}
export interface GiveawayHistoryRow
{
	id: number;
	title: string;
	prize_points: number;
	ends_at: string;
	winner_login: string | null;
	winner_name: string | null;
	winner_image: string | null;
}
export async function getGiveaways(): Promise<{ active: Giveaway[]; history: GiveawayHistoryRow[] }>
{
	try
	{
		const r = await fetch("/api/giveaways");
		return r.ok ? await r.json() : { active: [], history: [] };
	} catch { return { active: [], history: [] }; }
}
export async function enterGiveaway(id: number)
{
	const r = await fetch(`/api/giveaways/${id}/enter`, { method: "POST" });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function leaveGiveaway(id: number)
{
	const r = await fetch(`/api/giveaways/${id}/enter`, { method: "DELETE" });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function adminCreateGiveaway(
	title: string,
	description: string,
	prize_points: number,
	ends_at: string,
)
{
	const r = await fetch("/api/giveaways", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, description: description || undefined, prize_points, ends_at }),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}
export async function adminDeleteGiveaway(id: number)
{
	const r = await fetch(`/api/giveaways/${id}`, { method: "DELETE" });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
}

export interface LeaderRow
{
	rank: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
	points: number;
}

export interface GameLeaderRow
{
	rank: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
	games_played: number;
	total_wagered: number;
	total_payout: number;
	profit: number;
	biggest_win: number;
}

export async function getGameLeaderboard(game: string): Promise<GameLeaderRow[]>
{
	try
	{
		const r = await fetch(`/api/leaderboard/game/${encodeURIComponent(game)}`);
		return r.ok ? ((await r.json()).leaderboard ?? []) : [];
	} catch { return []; }
}

export interface LeaderPage
{
	leaderboard: LeaderRow[];
	total: number;
	limit: number;
	offset: number;
}

export async function getLeaderboardPage(
	limit: number,
	offset: number,
	q = "",
): Promise<LeaderPage>
{
	try
	{
		const params = new URLSearchParams({
			limit: String(limit),
			offset: String(offset),
		});
		if (q) params.set("q", q);
		const res = await fetch(`/api/leaderboard?${params}`);
		if (!res.ok) return { leaderboard: [], total: 0, limit, offset };
		return await res.json();
	} catch {
		return { leaderboard: [], total: 0, limit, offset };
	}
}

export interface Profile
{
	id: number;
	login: string;
	display_name: string | null;
	image_url: string | null;
	points: number;
	created_at: string;
	rank: number | null;
	online: boolean;
	status: "self" | "friend" | "pending_out" | "pending_in" | "none";
	title: string | null;
	name_color: string | null;
}
export async function getProfile(login: string): Promise<Profile | null>
{
	try
	{
		const r = await fetch(`/api/users/${encodeURIComponent(login)}`);
		if (!r.ok) return null;
		return (await r.json()).user as Profile;
	} catch {
		return null;
	}
}

export async function getMyRank(): Promise<number | null>
{
	try
	{
		const res = await fetch("/api/leaderboard/me");
		if (!res.ok) return null;
		return (await res.json()).rank;
	} catch {
		return null;
	}
}

export async function getStats(): Promise<{ players: number; total_points: number }> {
	try
	{
		const res = await fetch("/api/stats");
		if (!res.ok) return { players: 0, total_points: 0 };
		return await res.json();
	} catch {
		return { players: 0, total_points: 0 };
	}
}

// ── Crash ─────────────────────────────────────────────────────────────────────
type CrashListener = (msg: any) => void;
const crashListeners = new Set<CrashListener>();
export function onCrash(fn: CrashListener) { crashListeners.add(fn); return () => crashListeners.delete(fn); }
export function subscribeCrash() { wsSend({ type: "crash:sub" }); }
export function unsubscribeCrash() { wsSend({ type: "crash:unsub" }); }
export async function crashBet(amount: number) {
	const r = await fetch("/api/crash/bet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}
export async function crashCashout() {
	const r = await fetch("/api/crash/cashout", { method: "POST" });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}
export async function getCrashState() {
	const r = await fetch("/api/crash/state");
	return r.ok ? r.json() : null;
}

// ── Mines ─────────────────────────────────────────────────────────────────────
export async function getMinesSession() {
	const r = await fetch("/api/mines/session");
	return r.ok ? (await r.json()).session : null;
}
export async function minesStart(bet: number, mines_n: number) {
	const r = await fetch("/api/mines/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bet, mines_n }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}
export async function minesReveal(tile: number) {
	const r = await fetch("/api/mines/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tile }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	return d;
}
export async function minesCashout() {
	const r = await fetch("/api/mines/cashout", { method: "POST" });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}

// ── Hi-Lo ─────────────────────────────────────────────────────────────────────
export async function getHiloSession() {
	const r = await fetch("/api/hilo/session");
	return r.ok ? (await r.json()).session : null;
}
export async function hiloStart(bet: number) {
	const r = await fetch("/api/hilo/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bet }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}
export async function hiloGuess(dir: "higher" | "lower") {
	const r = await fetch("/api/hilo/guess", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	return d;
}
export async function hiloCashout() {
	const r = await fetch("/api/hilo/cashout", { method: "POST" });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}

// ── Tower ─────────────────────────────────────────────────────────────────────
export async function getTowerSession() {
	const r = await fetch("/api/tower/session");
	return r.ok ? (await r.json()).session : null;
}
export async function towerStart(bet: number) {
	const r = await fetch("/api/tower/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bet }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}
export async function towerPick(tile: number) {
	const r = await fetch("/api/tower/pick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tile }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	return d;
}
export async function towerCashout() {
	const r = await fetch("/api/tower/cashout", { method: "POST" });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}

// ── Daily ─────────────────────────────────────────────────────────────────────
export async function getDailyStatus() {
	const r = await fetch("/api/daily/status");
	return r.ok ? r.json() : null;
}
/** Atomic popup slot: true for exactly one call per user per day (all devices). */
export async function askDailyPopup(): Promise<boolean> {
	try {
		const r = await fetch("/api/daily/popup", { method: "POST" });
		if (!r.ok) return false;
		return !!(await r.json()).pop;
	} catch { return false; }
}
export async function claimDaily() {
	const r = await fetch("/api/daily/claim", { method: "POST" });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}

// ── Roulette ─────────────────────────────────────────────────────────────────
export type RouletteBetType =
	| "number" | "red" | "black" | "even" | "odd" | "low" | "high"
	| "dozen1" | "dozen2" | "dozen3" | "col1" | "col2" | "col3";

export async function roulettePlay(bet_type: RouletteBetType, bet: number, number?: number)
{
	const body: Record<string, unknown> = { bet_type, bet };
	if (number !== undefined) body.number = number;
	const r = await fetch("/api/games/roulette",
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new BetError(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d as { result: number; win: boolean; multiplier: number; payout: number; balance: number };
}

// ── Achievements ─────────────────────────────────────────────────────────────
type AchievementListener = (a: any) => void;
const achievementListeners = new Set<AchievementListener>();
export function onAchievement(fn: AchievementListener) { achievementListeners.add(fn); return () => achievementListeners.delete(fn); }

export async function getAchievements(login: string)
{
	try
	{
		const r = await fetch(`/api/achievements/${encodeURIComponent(login)}`);
		return r.ok ? (await r.json()).achievements as any[] : [];
	} catch { return []; }
}

// ── Weekly challenges ─────────────────────────────────────────────────────────
type ChallengeListener = (c: any) => void;
const challengeListeners = new Set<ChallengeListener>();
export function onChallengeComplete(fn: ChallengeListener) { challengeListeners.add(fn); return () => challengeListeners.delete(fn); }

export async function getMyChallenges()
{
	try
	{
		const r = await fetch("/api/challenges/me");
		return r.ok ? (await r.json()).challenges as any[] : [];
	} catch { return []; }
}

// ── Gift points ───────────────────────────────────────────────────────────────
export async function giftPoints(to_login: string, amount: number)
{
	const r = await fetch("/api/social/gift",
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to_login, amount }),
	});
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d?.error ?? "Erreur");
	setBalance(d.balance);
	return d;
}

// ── Jackpot ───────────────────────────────────────────────────────────────────
type JackpotListener = (amount: number) => void;
const jackpotListeners = new Set<JackpotListener>();
export function onJackpot(fn: JackpotListener) { jackpotListeners.add(fn); }
export async function getJackpot(): Promise<number>
{
	try
	{
		const r = await fetch("/api/jackpot");
		return r.ok ? (await r.json()).amount : 0;
	} catch { return 0; }
}

// ── Live feed ─────────────────────────────────────────────────────────────────
export interface FeedItem
{
	login: string;
	display_name: string | null;
	game: string;
	bet: number;
	payout: number;
	ts: number;
}
type FeedListener = (item: FeedItem) => void;
const feedListeners = new Set<FeedListener>();
export function onFeed(fn: FeedListener) { feedListeners.add(fn); }
export async function getFeed(): Promise<FeedItem[]>
{
	try
	{
		const r = await fetch("/api/feed");
		return r.ok ? (await r.json()).feed : [];
	} catch { return []; }
}

// ── Rain ──────────────────────────────────────────────────────────────────────
let rainEl: HTMLElement | null = null;

function hideRainBanner()
{
	rainEl?.remove();
	rainEl = null;
}

function showRainBanner(rain: { id: string; share: number; expires: number })
{
	hideRainBanner();
	const el = document.createElement("div");
	el.className = "rain-banner";
	el.innerHTML = `
		<span class="rain-txt">🌧️ Il pleut des points ! <b>+${fmt(rain.share)} pts</b> pour les plus rapides</span>
		<button class="rain-claim">Réclamer</button>`;
	el.querySelector<HTMLButtonElement>(".rain-claim")!.addEventListener("click", async (e) =>
	{
		const btn = e.currentTarget as HTMLButtonElement;
		btn.disabled = true;
		try
		{
			const r = await fetch("/api/rain/claim", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: rain.id }),
			});
			const d = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(d?.error ?? "Trop tard !");
			setBalance(d.balance);
			toast(`🌧️ +${fmt(d.amount)} pts réclamés !`);
		}
		catch (err: any)
		{
			toast(err?.message ?? "Trop tard !");
		}
		hideRainBanner();
	});
	document.body.appendChild(el);
	rainEl = el;
	setTimeout(hideRainBanner, Math.max(0, rain.expires - Date.now()));
}

/** Check for an active rain on page load. */
export async function checkRain()
{
	try
	{
		const r = await fetch("/api/rain");
		if (!r.ok) return;
		const { rain } = await r.json();
		if (rain && !rain.claimed && rain.remaining > 0) showRainBanner(rain);
	} catch {}
}

export const adminStartRain = (amount: number, winners: number) =>
	post("/api/rain/start", { amount, winners });

// ── Duels ─────────────────────────────────────────────────────────────────────
type DuelListener = (msg: any) => void;
const duelListeners = new Set<DuelListener>();
export function onDuel(fn: DuelListener) { duelListeners.add(fn); }
export async function getMyDuels()
{
	try
	{
		const r = await fetch("/api/duels/me");
		return r.ok ? (await r.json()).duels : [];
	} catch { return []; }
}
export const challengeDuel = (login: string, stake: number) =>
	post("/api/duels", { login, stake }).then((d) => { if (d.balance !== undefined) setBalance(d.balance); return d; });
export const acceptDuel = (id: number) =>
	post(`/api/duels/${id}/accept`).then((d) => { if (d.balance !== undefined) setBalance(d.balance); return d; });
export const declineDuel = (id: number) => post(`/api/duels/${id}/decline`);
export const cancelDuel = (id: number) =>
	post(`/api/duels/${id}/cancel`).then((d) => { if (d.balance !== undefined) setBalance(d.balance); return d; });

// ── Shop ──────────────────────────────────────────────────────────────────────
export async function getShop()
{
	try
	{
		const r = await fetch("/api/shop");
		return r.ok ? await r.json() : { items: [], owned: [], equipped: {} };
	} catch { return { items: [], owned: [], equipped: {} }; }
}
export const buyItem = (key: string) =>
	post("/api/shop/buy", { key }).then((d) => { if (d.balance !== undefined) setBalance(d.balance); return d; });
export const equipItem = (key: string | null, kind?: "title" | "color") =>
	post("/api/shop/equip", key ? { key } : { kind });

// ── History ───────────────────────────────────────────────────────────────────
export async function getMyHistory()
{
	try
	{
		const r = await fetch("/api/history/me");
		return r.ok ? (await r.json()).history : [];
	} catch { return []; }
}

// ── Provably fair ─────────────────────────────────────────────────────────────
export async function getFairSeeds()
{
	try
	{
		const r = await fetch("/api/fair");
		return r.ok ? await r.json() : null;
	} catch { return null; }
}
export const rotateFairSeeds = (client_seed?: string) =>
	post("/api/fair/rotate", { client_seed });

// ── Poker ─────────────────────────────────────────────────────────────────────
type PokerListener = (msg: any) => void;
const pokerListeners = new Set<PokerListener>();
export function onPoker(fn: PokerListener)
{
	pokerListeners.add(fn);
	return () => pokerListeners.delete(fn);
}
const pokerApi = async (path: string, body?: unknown) =>
{
	const r = await fetch(`/api/poker${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data?.error ?? "Erreur");
	return data;
};
export const pokerCreateRoom = (name: string, isPublic: boolean) =>
	pokerApi("/rooms", { name, isPublic });
export async function pokerListRooms()
{
	try
	{
		const r = await fetch("/api/poker/rooms");
		return r.ok ? (await r.json()).rooms : [];
	} catch { return []; }
}
export const pokerJoin = (id: string) => pokerApi(`/rooms/${id}/join`);
export const pokerJoinByCode = (code: string) => pokerApi("/join", { code });
export const pokerLeave = (id: string) => pokerApi(`/rooms/${id}/leave`);
export const pokerStart = (id: string) => pokerApi(`/rooms/${id}/start`);
export const pokerAction = (id: string, action: "fold" | "check" | "call" | "raise", amount?: number) =>
	pokerApi(`/rooms/${id}/action`, amount !== undefined ? { action, amount } : { action });

export const clampBet = (v: number) =>
	Math.max(1, Math.min(1_000_000, Math.floor(v || 0)));

/** Wire ½ / 2× / Max chip buttons (data-amt) to a bet amount input. */
export function setupAmount(input: HTMLInputElement, root: ParentNode = document)
{
	root.querySelectorAll<HTMLButtonElement>("[data-amt]").forEach((b) =>
	{
		b.addEventListener("click", () =>
		{
			const cur = clampBet(Number(input.value));
			const m = b.dataset.amt;
			if (m === "half") input.value = String(clampBet(cur / 2));
			else if (m === "double") input.value = String(clampBet(cur * 2));
			else if (m === "max") input.value = String(clampBet(getBalance()));
		});
	});
}
