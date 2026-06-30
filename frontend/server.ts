// Minimal static server for the built Astro site (dist/).
// Replaces `astro preview` so the frontend works behind the gateway/tunnel
// without host-header restrictions.
const DIST = "./dist";
const PORT = Number(process.env.PORT ?? 4321);

async function resolve(pathname: string)
{
	const candidates = [
		DIST + pathname,
		DIST + pathname + (pathname.endsWith("/") ? "index.html" : "/index.html"),
		DIST + pathname + ".html",
	];
	for (const c of candidates)
	{
		const f = Bun.file(c);
		if (await f.exists()) return f;
	}
	return null;
}

Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	async fetch(req)
	{
		const { pathname } = new URL(req.url);
		const file = await resolve(pathname === "/" ? "/index.html" : pathname);
		if (file) return new Response(file);
		const fallback = Bun.file(DIST + "/404.html");
		if (await fallback.exists())
			return new Response(fallback, { status: 404 });
		return new Response("Not found", { status: 404 });
	},
});

console.log(`frontend static server on :${PORT}`);
