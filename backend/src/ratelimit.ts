// Token-bucket rate limiter, Discord-style:
//  - refill continu (pas de fenêtre fixe => pas de burst x2 en bord de fenêtre)
//  - headers X-RateLimit-* sur chaque réponse, Retry-After sur 429
//  - buckets par domaine, lectures/écritures séparées côté social
//  - blocage exponentiel en cas d'abus répété

interface Bucket
{
	tokens: number;
	last: number;          // dernier refill (ms)
	violations: number;
	blockedUntil: number;
}

const store = new Map<string, Bucket>();

// Sweep stale entries every 10 min
setInterval(() =>
{
	const now = Date.now();
	for (const [k, b] of store)
	{
		if (b.blockedUntil < now && now - b.last > 600_000) store.delete(k);
	}
}, 600_000);

export interface RLConfig
{
	name: string;       // bucket id exposé dans X-RateLimit-Bucket
	max: number;        // capacité du bucket (burst max)
	window: number;     // ms pour régénérer `max` tokens (débit = max/window)
	baseBlock: number;  // blocage à la 1re violation (ms)
	maxBlock: number;   // plafond du blocage (ms)
}

export const BUCKETS = {
	// Campus : 150 étudiants derrière une IP, seuil large.
	auth:        { name: "auth",         max: 100, window: 60_000, baseBlock: 60_000, maxBlock: 86_400_000 },
	// Actions de jeu : 30 mises en burst, régénérées sur 10s.
	games:       { name: "games",        max: 30,  window: 10_000, baseBlock:  5_000, maxBlock:    300_000 },
	// Mutations de paris d'exam, volontairement serré.
	examBets:    { name: "exam-bets",    max: 10,  window: 60_000, baseBlock: 30_000, maxBlock:    600_000 },
	// Lectures sociales (presence, amis, profils, notifs) : très large,
	// chaque navigation en consomme 4-5.
	socialRead:  { name: "social-read",  max: 240, window: 30_000, baseBlock: 10_000, maxBlock:    300_000 },
	// Écritures sociales (demandes d'ami, duels, cadeaux) : serré.
	socialWrite: { name: "social-write", max: 20,  window: 30_000, baseBlock: 10_000, maxBlock:    300_000 },
} satisfies Record<string, RLConfig>;

interface RLResult
{
	ok: boolean;
	remaining: number;
	resetMs: number;     // ms avant qu'un token soit disponible / fin de blocage
	retryAfter?: number; // secondes (429 uniquement)
}

export function checkRL(key: string, cfg: RLConfig): RLResult
{
	const now = Date.now();
	let b = store.get(key);
	if (!b)
	{
		b = { tokens: cfg.max, last: now, violations: 0, blockedUntil: 0 };
		store.set(key, b);
	}

	if (b.blockedUntil > now)
	{
		const wait = b.blockedUntil - now;
		return { ok: false, remaining: 0, resetMs: wait, retryAfter: Math.ceil(wait / 1000) };
	}

	// Refill continu + décroissance des violations après une longue accalmie.
	const rate = cfg.max / cfg.window; // tokens per ms
	const elapsed = now - b.last;
	b.tokens = Math.min(cfg.max, b.tokens + elapsed * rate);
	if (elapsed > cfg.window * 2) b.violations = Math.max(0, b.violations - 1);
	b.last = now;

	if (b.tokens >= 1)
	{
		b.tokens -= 1;
		const resetMs = b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / rate);
		return { ok: true, remaining: Math.floor(b.tokens), resetMs };
	}

	// À sec : violation + blocage exponentiel.
	b.violations++;
	const blockMs = Math.min(cfg.baseBlock * 2 ** (b.violations - 1), cfg.maxBlock);
	b.blockedUntil = now + blockMs;
	return { ok: false, remaining: 0, resetMs: blockMs, retryAfter: Math.ceil(blockMs / 1000) };
}

// Elysia onBeforeHandle helper — pose les headers, early-exit 429 si limité.
export function rl(
	key: string,
	cfg: RLConfig,
	set: { status?: number | string; headers: Record<string, string | number> },
)
{
	const r = checkRL(key, cfg);
	set.headers["X-RateLimit-Bucket"] = cfg.name;
	set.headers["X-RateLimit-Limit"] = String(cfg.max);
	set.headers["X-RateLimit-Remaining"] = String(r.remaining);
	set.headers["X-RateLimit-Reset"] = ((Date.now() + r.resetMs) / 1000).toFixed(3);
	if (!r.ok)
	{
		set.status = 429;
		set.headers["Retry-After"] = String(r.retryAfter);
		return { error: "trop de requêtes", retry_after: r.retryAfter };
	}
}
