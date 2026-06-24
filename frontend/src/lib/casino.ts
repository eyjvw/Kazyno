// Shared client helpers for auth state, balance, and placing bets.

export interface Me {
  id: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
  points: number;
}

type BalanceListener = (points: number) => void;
const listeners = new Set<BalanceListener>();
let balance = 0;
let myId: number | null = null;

export const getMyId = () => myId;

/** Subscribe to balance changes; fires immediately with the current value. */
export function onBalance(fn: BalanceListener) {
  listeners.add(fn);
  fn(balance);
}

function setBalance(points: number) {
  balance = points;
  listeners.forEach((fn) => fn(points));
}

export function getBalance() {
  return balance;
}

/** Fetch the current user; updates balance. Returns null if unauthenticated. */
export async function loadMe(): Promise<Me | null> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.authenticated) return null;
    myId = data.user.id;
    setBalance(data.user.points);
    return data.user as Me;
  } catch {
    return null;
  }
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
}

/** RGPD: permanently delete the current account. */
export async function deleteAccount(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/account", { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface BetResult {
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
): Promise<BetResult> {
  const res = await fetch(`/api/games/${game}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
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

export function onLeaderboard(fn: LeaderListener) {
  leaderListeners.add(fn);
}

/** Open the live socket (balance + leaderboard pushes). Auto-reconnects. */
export function connectRealtime() {
  if (ws) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws = sock;
  sock.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "balance":
        setBalance(msg.points);
        break;
      case "leaderboard":
        leaderListeners.forEach((fn) => fn(msg.leaderboard));
        break;
      case "presence":
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
      case "notification":
        toast(msg.notif.message, msg.notif.link || undefined);
        notifListeners.forEach((fn) => fn());
        break;
    }
  };
  sock.onopen = () => resubscribeRooms();
  sock.onclose = () => {
    ws = null;
    setTimeout(connectRealtime, 2000);
  };
  sock.onerror = () => sock.close();
}

// ── Presence ────────────────────────────────────────────────────────────
export interface OnlineUser {
  id: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
}
const onlineUsers = new Map<number, OnlineUser>();
type PresenceListener = (list: OnlineUser[]) => void;
const presenceListeners = new Set<PresenceListener>();

function emitPresence() {
  const list = [...onlineUsers.values()];
  presenceListeners.forEach((fn) => fn(list));
}
export function onPresence(fn: PresenceListener) {
  presenceListeners.add(fn);
  fn([...onlineUsers.values()]);
}
export async function loadPresence() {
  try {
    const res = await fetch("/api/presence");
    if (!res.ok) return;
    const data = await res.json();
    onlineUsers.clear();
    (data.online as OnlineUser[]).forEach((u) => onlineUsers.set(u.id, u));
    emitPresence();
  } catch {}
}

// ── Friends ─────────────────────────────────────────────────────────────
export interface FriendCard extends OnlineUser {
  points?: number;
  online?: boolean;
}
type FriendListener = (ev: any) => void;
const friendListeners = new Set<FriendListener>();
export function onFriendEvent(fn: FriendListener) {
  friendListeners.add(fn);
}

export async function getFriends(): Promise<FriendCard[]> {
  try {
    const r = await fetch("/api/friends");
    return r.ok ? (await r.json()).friends : [];
  } catch {
    return [];
  }
}
export interface SearchResult extends OnlineUser {
  status: "none" | "pending_out" | "pending_in" | "friend";
  online: boolean;
}
export async function searchUsers(q: string): Promise<SearchResult[]> {
  try {
    const r = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    return r.ok ? (await r.json()).results : [];
  } catch {
    return [];
  }
}

export interface RequestsData {
  incoming: OnlineUser[];
  outgoing: OnlineUser[];
}
export async function getRequests(): Promise<RequestsData> {
  try {
    const r = await fetch("/api/friends/requests");
    if (!r.ok) return { incoming: [], outgoing: [] };
    return await r.json();
  } catch {
    return { incoming: [], outgoing: [] };
  }
}
async function post(url: string, body?: unknown) {
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
export async function removeFriend(userId: number) {
  await fetch(`/api/friends/${userId}`, { method: "DELETE" });
}

// ── Toast ───────────────────────────────────────────────────────────────
export function toast(message: string, href?: string) {
  let host = document.querySelector<HTMLElement>(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement(href ? "a" : "div") as HTMLElement;
  el.className = "toast" + (href ? " clickable" : "");
  el.textContent = message;
  if (href) (el as HTMLAnchorElement).href = href;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 6000);
}

// ── Blackjack realtime + API ──────────────────────────────────────────────
type RoomListener = (msg: any) => void;
const roomListeners = new Set<RoomListener>();
const inviteListeners = new Set<RoomListener>();
const subscribedRooms = new Set<string>();

export function onRoom(fn: RoomListener) {
  roomListeners.add(fn);
  return () => roomListeners.delete(fn);
}
export function onBjInvite(fn: RoomListener) {
  inviteListeners.add(fn);
}

function wsSend(obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
export function subscribeRoom(id: string) {
  subscribedRooms.add(id);
  wsSend({ type: "room:sub", id });
}
export function unsubscribeRoom(id: string) {
  subscribedRooms.delete(id);
  wsSend({ type: "room:unsub", id });
}
/** Called from connectRealtime on (re)open to restore room subs. */
function resubscribeRooms() {
  subscribedRooms.forEach((id) => wsSend({ type: "room:sub", id }));
}

const bjApi = async (path: string, body?: unknown) => {
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
export async function bjListRooms() {
  try {
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
export function onExamSettled(fn: ExamListener) {
  examListeners.add(fn);
}
export async function getExamBets() {
  try {
    const r = await fetch("/api/exam-bets/me");
    return r.ok ? await r.json() : { pending: null, history: [] };
  } catch {
    return { pending: null, history: [] };
  }
}
export async function getExamFeed() {
  try {
    const r = await fetch("/api/exam-bets/feed");
    return r.ok ? (await r.json()).feed : [];
  } catch {
    return [];
  }
}
// ── Notifications ───────────────────────────────────────────────────────────
export interface Notif {
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
export function onNotification(fn: NotifListener) {
  notifListeners.add(fn);
}
export async function getNotifications(): Promise<{ items: Notif[]; unread: number }> {
  try {
    const r = await fetch("/api/notifications");
    return r.ok ? await r.json() : { items: [], unread: 0 };
  } catch {
    return { items: [], unread: 0 };
  }
}
export async function markNotifsRead() {
  await fetch("/api/notifications/read", { method: "POST" }).catch(() => {});
}
export async function deleteNotif(id: number) {
  await fetch(`/api/notifications/${id}`, { method: "DELETE" }).catch(() => {});
}
export async function clearNotifs() {
  await fetch("/api/notifications", { method: "DELETE" }).catch(() => {});
}

// ── Admin ─────────────────────────────────────────────────────────────────
export async function adminMe(): Promise<boolean> {
  try {
    const r = await fetch("/api/admin/me");
    return r.ok ? (await r.json()).isAdmin : false;
  } catch {
    return false;
  }
}
async function adminPost(path: string, body: unknown) {
  const r = await fetch(`/api/admin${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? "Erreur");
  return data;
}
export async function adminSearch(q: string) {
  try {
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

export async function placeExamBet(predicted: number, stake: number) {
  const r = await fetch("/api/exam-bets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ predicted, stake }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? "Erreur");
  return data;
}

export interface LeaderRow {
  rank: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
  points: number;
}

export interface LeaderPage {
  leaderboard: LeaderRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function getLeaderboardPage(
  limit: number,
  offset: number,
  q = "",
): Promise<LeaderPage> {
  try {
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

export interface Profile {
  id: number;
  login: string;
  display_name: string | null;
  image_url: string | null;
  points: number;
  created_at: string;
  rank: number | null;
  online: boolean;
  status: "self" | "friend" | "pending_out" | "pending_in" | "none";
}
export async function getProfile(login: string): Promise<Profile | null> {
  try {
    const r = await fetch(`/api/users/${encodeURIComponent(login)}`);
    if (!r.ok) return null;
    return (await r.json()).user as Profile;
  } catch {
    return null;
  }
}

export async function getMyRank(): Promise<number | null> {
  try {
    const res = await fetch("/api/leaderboard/me");
    if (!res.ok) return null;
    return (await res.json()).rank;
  } catch {
    return null;
  }
}

export async function getStats(): Promise<{ players: number; total_points: number }> {
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) return { players: 0, total_points: 0 };
    return await res.json();
  } catch {
    return { players: 0, total_points: 0 };
  }
}

export const clampBet = (v: number) =>
  Math.max(1, Math.min(1_000_000, Math.floor(v || 0)));

/** Wire ½ / 2× / Max chip buttons (data-amt) to a bet amount input. */
export function setupAmount(input: HTMLInputElement, root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>("[data-amt]").forEach((b) => {
    b.addEventListener("click", () => {
      const cur = clampBet(Number(input.value));
      const m = b.dataset.amt;
      if (m === "half") input.value = String(clampBet(cur / 2));
      else if (m === "double") input.value = String(clampBet(cur * 2));
      else if (m === "max") input.value = String(clampBet(getBalance()));
    });
  });
}
