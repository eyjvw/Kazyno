interface Bucket {
  hits: number;
  windowStart: number;
  violations: number;
  blockedUntil: number;
}

const store = new Map<string, Bucket>();

// Sweep stale entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) {
    if (b.blockedUntil < now && now - b.windowStart > 600_000) store.delete(k);
  }
}, 600_000);

export interface RLConfig {
  max: number;        // hits allowed per window
  window: number;     // window in ms
  baseBlock: number;  // block duration on first violation (ms)
  maxBlock: number;   // cap on block duration (ms)
}

export const BUCKETS = {
  // 100 login attempts / 60s → 1 min block doubling up to 24h
  // Campus: 150 students share one IP, so threshold must accommodate burst logins
  auth:     { max: 100, window: 60_000,  baseBlock:  60_000, maxBlock: 86_400_000 },
  // 30 game actions / 10s → 5s block up to 5 min
  games:    { max: 30,  window: 10_000,  baseBlock:   5_000, maxBlock:    300_000 },
  // 10 exam bet mutations / 60s → 30s block up to 10 min
  examBets: { max: 10,  window: 60_000,  baseBlock:  30_000, maxBlock:    600_000 },
  // 30 social actions / 30s → 10s block up to 5 min
  friends:  { max: 30,  window: 30_000,  baseBlock:  10_000, maxBlock:    300_000 },
} satisfies Record<string, RLConfig>;

export function checkRL(
  key: string,
  cfg: RLConfig,
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  let b = store.get(key);
  if (!b) {
    b = { hits: 0, windowStart: now, violations: 0, blockedUntil: 0 };
    store.set(key, b);
  }

  // Still blocked?
  if (b.blockedUntil > now) {
    return { ok: false, retryAfter: Math.ceil((b.blockedUntil - now) / 1000) };
  }

  // New window — decay violations if last window was clean
  if (now - b.windowStart >= cfg.window) {
    if (b.hits <= cfg.max) b.violations = Math.max(0, b.violations - 1);
    b.hits = 0;
    b.windowStart = now;
  }

  b.hits++;

  if (b.hits > cfg.max) {
    b.violations++;
    const blockMs = Math.min(cfg.baseBlock * 2 ** (b.violations - 1), cfg.maxBlock);
    b.blockedUntil = now + blockMs;
    b.hits = 0;
    return { ok: false, retryAfter: Math.ceil(blockMs / 1000) };
  }

  return { ok: true };
}

// Elysia onBeforeHandle helper — returns early-exit payload or undefined
export function rl(
  key: string,
  cfg: RLConfig,
  set: { status?: number | string; headers: Record<string, string> },
) {
  const r = checkRL(key, cfg);
  if (!r.ok) {
    set.status = 429;
    set.headers["Retry-After"] = String(r.retryAfter);
    return { error: "trop de requêtes", retry_after: r.retryAfter };
  }
}
