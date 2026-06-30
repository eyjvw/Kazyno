const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://frontend:4321";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:3000";
const BACKEND_WS = BACKEND_URL.replace(/^http/, "ws");

// ── Global per-IP rate limiter ──────────────────────────────────────────────
interface GWBucket
{
	hits: number;
	windowStart: number;
	violations: number;
	blockedUntil: number;
}
const rlStore = new Map<string, GWBucket>();
setInterval(() =>
{
	const now = Date.now();
	for (const [k, b] of rlStore)
	{
		if (b.blockedUntil < now && now - b.windowStart > 120_000) rlStore.delete(k);
	}
}, 120_000);

// 2000 req / 60s per IP — pure DoS threshold, not per-user abuse prevention
// (campus: 150 students share one public IP, so limit must be very high)
const GW_MAX = 2000, GW_WIN = 60_000, GW_BASE = 30_000, GW_MAX_BLOCK = 3_600_000;

function gwRL(ip: string): number | null
{
	const now = Date.now();
	let b = rlStore.get(ip);
	if (!b)
	{
		b = { hits: 0, windowStart: now, violations: 0, blockedUntil: 0 };
		rlStore.set(ip, b);
	}
	if (b.blockedUntil > now) return Math.ceil((b.blockedUntil - now) / 1000);
	if (now - b.windowStart >= GW_WIN)
	{
		if (b.hits <= GW_MAX) b.violations = Math.max(0, b.violations - 1);
		b.hits = 0;
		b.windowStart = now;
	}
	b.hits++;
	if (b.hits > GW_MAX)
	{
		b.violations++;
		const blockMs = Math.min(GW_BASE * 2 ** (b.violations - 1), GW_MAX_BLOCK);
		b.blockedUntil = now + blockMs;
		b.hits = 0;
		return Math.ceil(blockMs / 1000);
	}
	return null; // ok
}

function clientIP(req: Request, server: ReturnType<typeof Bun.serve>): string
{
	return (
		req.headers.get("cf-connecting-ip") ??
		req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
		server.requestIP(req)?.address ??
		"unknown"
	);
}

interface WSData
{
	cookie: string | null;
	backend?: WebSocket;
	queue: (string | Buffer)[];
}

const server = Bun.serve<WSData, undefined>({
	port: 8080,
	hostname: "0.0.0.0",

	async fetch(req, server)
	{
		const url = new URL(req.url);

		if (url.pathname === "/health")
		{
			return Response.json({ ok: true, service: "gateway" });
		}

		const ip = clientIP(req, server);

		// Apply global RL only to API and non-asset requests
		const isAsset = /\.(js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|webp|avif|map)(\?|$)/.test(url.pathname);
		if (!isAsset)
		{
			const retryAfter = gwRL(ip);
			if (retryAfter !== null)
			{
				return new Response(
					JSON.stringify({ error: "trop de requêtes", retry_after: retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
		}

		// WebSocket upgrade -> proxied to the backend in the websocket handlers.
		if (url.pathname === "/api/ws")
		{
			const ok = server.upgrade(req, {
				data: { cookie: req.headers.get("cookie"), queue: [] },
			});
			return ok ? undefined : new Response("upgrade failed", { status: 426 });
		}

		// Plain HTTP reverse proxy — inject real IP so the backend can rate-limit per IP too.
		const target = url.pathname.startsWith("/api/") ? BACKEND_URL : FRONTEND_URL;
		const upstream = target + url.pathname + url.search;
		const hasBody = req.method !== "GET" && req.method !== "HEAD";

		const headers = new Headers(req.headers);
		headers.set("x-real-ip", ip);

		const init: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
			redirect: "manual",
		};
		if (hasBody)
		{
			init.body = req.body;
			init.duplex = "half";
		}
		return fetch(upstream, init);
	},

	websocket: {
		open(ws)
		{
			// Open a matching socket to the backend, forwarding the auth cookie.
			// Bun extends WebSocket constructor with options — not in DOM types
			type BunWsInit = { headers?: Record<string, string> };
			const backend = new WebSocket(
				`${BACKEND_WS}/api/ws`,
				(ws.data.cookie ? { headers: { cookie: ws.data.cookie } } : {}) as BunWsInit,
			);
			ws.data.backend = backend;

			backend.addEventListener("open", () =>
			{
				ws.data.queue.forEach((m) => backend.send(m));
				ws.data.queue = [];
			});
			backend.addEventListener("message", (e) => ws.send(e.data));
			backend.addEventListener("close", () => ws.close());
			backend.addEventListener("error", () => ws.close());
		},
		message(ws, message)
		{
			const b = ws.data.backend;
			if (b && b.readyState === WebSocket.OPEN) b.send(message);
			else ws.data.queue.push(message);
		},
		close(ws)
		{
			ws.data.backend?.close();
		},
	},
});

console.log(`gateway up on :${server.port}  ->  api=${BACKEND_URL} web=${FRONTEND_URL}`);
