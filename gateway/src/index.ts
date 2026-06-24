const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://frontend:4321";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:3000";
const BACKEND_WS = BACKEND_URL.replace(/^http/, "ws");

interface WSData {
  cookie: string | null;
  backend?: WebSocket;
  queue: (string | Buffer)[];
}

const server = Bun.serve<WSData, undefined>({
  port: 8080,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gateway" });
    }

    // WebSocket upgrade -> proxied to the backend in the websocket handlers.
    if (url.pathname === "/api/ws") {
      const ok = server.upgrade(req, {
        data: { cookie: req.headers.get("cookie"), queue: [] },
      });
      return ok ? undefined : new Response("upgrade failed", { status: 426 });
    }

    // Plain HTTP reverse proxy.
    const target = url.pathname.startsWith("/api/") ? BACKEND_URL : FRONTEND_URL;
    const upstream = target + url.pathname + url.search;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: req.headers,
      redirect: "manual",
    };
    if (hasBody) {
      init.body = req.body;
      init.duplex = "half";
    }
    return fetch(upstream, init);
  },

  websocket: {
    open(ws) {
      // Open a matching socket to the backend, forwarding the auth cookie.
      const backend = new WebSocket(`${BACKEND_WS}/api/ws`, {
        headers: ws.data.cookie ? { cookie: ws.data.cookie } : {},
      } as any);
      ws.data.backend = backend;

      backend.addEventListener("open", () => {
        ws.data.queue.forEach((m) => backend.send(m));
        ws.data.queue = [];
      });
      backend.addEventListener("message", (e) => ws.send(e.data));
      backend.addEventListener("close", () => ws.close());
      backend.addEventListener("error", () => ws.close());
    },
    message(ws, message) {
      const b = ws.data.backend;
      if (b && b.readyState === WebSocket.OPEN) b.send(message);
      else ws.data.queue.push(message);
    },
    close(ws) {
      ws.data.backend?.close();
    },
  },
});

console.log(`gateway up on :${server.port}  ->  api=${BACKEND_URL} web=${FRONTEND_URL}`);
