import * as THREE from "three";
import {
	CSS2DRenderer,
	CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";

// 3D blackjack table renderer. Feed it room state via update(); it animates
// dealing and flipping cards smoothly. Game logic stays server-side.

const CARD_W = 0.92;
const CARD_H = 1.28;
const SEAT_X = [-4.3, -2.15, 0, 2.15, 4.3];
const SEAT_Z = 2.5;
const DEALER = new THREE.Vector3(0, 0, -2.3);
const DECK = new THREE.Vector3(5.2, 0.8, -2.3);

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
)
{
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

const RED = new Set(["♥", "♦"]);
const frontCache = new Map<string, THREE.CanvasTexture>();

function frontTexture(r: string, s: string): THREE.CanvasTexture {
	const key = r + s;
	const cached = frontCache.get(key);
	if (cached) return cached;
	const c = document.createElement("canvas");
	c.width = 256;
	c.height = 358;
	const x = c.getContext("2d")!;
	x.clearRect(0, 0, 256, 358);
	x.fillStyle = "#fdfdfd";
	roundRect(x, 6, 6, 244, 346, 24);
	x.fill();
	const col = RED.has(s) ? "#d4123f" : "#16202b";
	x.fillStyle = col;
	x.textAlign = "center";
	x.font = "bold 70px Inter, Arial";
	x.fillText(r, 46, 78);
	x.font = "52px Arial";
	x.fillText(s, 46, 128);
	x.font = "170px Arial";
	x.fillText(s, 128, 240);
	const t = new THREE.CanvasTexture(c);
	t.anisotropy = 4;
	frontCache.set(key, t);
	return t;
}

let backTex: THREE.CanvasTexture | null = null;
function backTexture(): THREE.CanvasTexture {
	if (backTex) return backTex;
	const c = document.createElement("canvas");
	c.width = 256;
	c.height = 358;
	const x = c.getContext("2d")!;
	roundRect(x, 6, 6, 244, 346, 24);
	x.fillStyle = "#1f5fd0";
	x.fill();
	x.strokeStyle = "#7fb0ff";
	x.lineWidth = 6;
	for (let i = -358; i < 256; i += 26)
	{
		x.beginPath();
		x.moveTo(i, 0);
		x.lineTo(i + 358, 358);
		x.stroke();
	}
	roundRect(x, 22, 22, 212, 314, 16);
	x.strokeStyle = "#fff";
	x.lineWidth = 8;
	x.stroke();
	backTex = new THREE.CanvasTexture(c);
	return backTex;
}

function feltTexture(): THREE.CanvasTexture {
	const c = document.createElement("canvas");
	c.width = 1024;
	c.height = 720;
	const x = c.getContext("2d")!;
	x.clearRect(0, 0, 1024, 720);
	const g = x.createRadialGradient(512, 300, 80, 512, 360, 620);
	g.addColorStop(0, "#1c6a4f");
	g.addColorStop(1, "#0c3326");
	x.fillStyle = g;
	roundRect(x, 30, 30, 964, 660, 220);
	x.fill();
	x.strokeStyle = "rgba(255,255,255,0.25)";
	x.lineWidth = 4;
	roundRect(x, 54, 54, 916, 612, 200);
	x.stroke();
	x.fillStyle = "rgba(255,255,255,0.85)";
	x.textAlign = "center";
	x.font = "bold 54px Inter, Arial";
	x.fillText("BLACKJACK", 512, 250);
	x.font = "26px Inter, Arial";
	x.fillStyle = "rgba(255,255,255,0.45)";
	x.fillText("PAIE  3  POUR  2", 512, 292);
	x.fillStyle = "rgba(255,255,255,0.07)";
	x.font = "bold 40px Inter, Arial";
	x.fillText("PISCASINO", 512, 470);
	return new THREE.CanvasTexture(c);
}

interface CardObj
{
	group: THREE.Group;
	front: THREE.Mesh;
	faceUp: boolean;
	rank: string;
	tpos: THREE.Vector3;
	trotX: number;
	tscale: number;
	removing: boolean;
}

export class BlackjackScene
{
	private scene = new THREE.Scene();
	private camera: THREE.PerspectiveCamera;
	private renderer: THREE.WebGLRenderer;
	private labelRenderer: CSS2DRenderer;
	private cards = new Map<string, CardObj>();
	private labels = new Map<string, { obj: CSS2DObject; el: HTMLDivElement }>();
	private ring: THREE.Mesh;
	private raf = 0;
	private container: HTMLElement;
	private myId: number | null = null;

	constructor(container: HTMLElement)
	{
		this.container = container;
		const w = container.clientWidth;
		const h = container.clientHeight || 480;

		this.scene.background = new THREE.Color("#0d2230");
		this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
		this.camera.position.set(0, 9, 7.4);
		this.camera.lookAt(0, 0, 0.6);

		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.setSize(w, h);
		container.appendChild(this.renderer.domElement);

		this.labelRenderer = new CSS2DRenderer();
		this.labelRenderer.setSize(w, h);
		const ld = this.labelRenderer.domElement;
		ld.style.position = "absolute";
		ld.style.top = "0";
		ld.style.left = "0";
		ld.style.pointerEvents = "none";
		container.appendChild(ld);

		// Felt
		const felt = new THREE.Mesh(
			new THREE.PlaneGeometry(16, 11),
			new THREE.MeshBasicMaterial({ map: feltTexture(), transparent: true }),
		);
		felt.rotation.x = -Math.PI / 2;
		this.scene.add(felt);

		// Turn highlight ring
		this.ring = new THREE.Mesh(
			new THREE.RingGeometry(0.7, 0.95, 48),
			new THREE.MeshBasicMaterial({
				color: 0x3b82f6,
				transparent: true,
				opacity: 0.9,
				side: THREE.DoubleSide,
			}),
		);
		this.ring.rotation.x = -Math.PI / 2;
		this.ring.position.y = 0.02;
		this.ring.visible = false;
		this.scene.add(this.ring);

		window.addEventListener("resize", this.onResize);
		this.loop();
	}

	private onResize = () =>
	{
		const w = this.container.clientWidth;
		const h = this.container.clientHeight || 480;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
		this.labelRenderer.setSize(w, h);
	};

	private makeCard(): CardObj
	{
		const group = new THREE.Group();
		const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
		const front = new THREE.Mesh(
			geo,
			new THREE.MeshBasicMaterial({ transparent: true }),
		);
		const back = new THREE.Mesh(
			geo.clone(),
			new THREE.MeshBasicMaterial({ map: backTexture(), transparent: true }),
		);
		back.rotation.y = Math.PI;
		group.add(front, back);
		group.scale.setScalar(0.01);
		group.position.copy(DECK);
		this.scene.add(group);
		return {
			group,
			front,
			faceUp: false,
			rank: "",
			tpos: DECK.clone(),
			trotX: Math.PI / 2,
			tscale: 1,
			removing: false,
		};
	}

	private layout(anchorX: number, anchorZ: number, i: number, n: number)
	{
		const sp = 0.5;
		const x = anchorX - (sp * (n - 1)) / 2 + i * sp;
		return new THREE.Vector3(x, 0.02 + i * 0.015, anchorZ + i * 0.18);
	}

	private ensureLabel(key: string): HTMLDivElement
	{
		let l = this.labels.get(key);
		if (!l)
		{
			const el = document.createElement("div");
			el.className = "bj-label";
			const obj = new CSS2DObject(el);
			this.scene.add(obj);
			l = { obj, el };
			this.labels.set(key, l);
		}
		return l.el;
	}

	update(room: any, myId: number | null)
	{
		this.myId = myId;
		const seen = new Set<string>();

		// Dealer cards
		const dc = room.dealer.cards as Array<{ r: string; s: string }>;
		dc.forEach((c, i) =>
		{
			const key = `d${i}`;
			seen.add(key);
			this.placeCard(key, c, this.layout(DEALER.x, DEALER.z, i, dc.length));
		});

		// Seats
		(room.seats as any[]).forEach((s, slot) =>
		{
			if (!s)
			{
				this.setLabel(`seat${slot}`, "", false, SEAT_X[slot], SEAT_Z, true);
				return;
			}
			const cards = (s.cards || []) as Array<{ r: string; s: string }>;
			cards.forEach((c, i) =>
			{
				const key = `s${slot}_${i}`;
				seen.add(key);
				this.placeCard(key, c, this.layout(SEAT_X[slot], SEAT_Z, i, cards.length));
			});
			this.setSeatLabel(slot, s, room);
		});

		// Dealer label
		const dealerVal = room.dealer.value != null ? `<span class="bj-val">${room.dealer.value}</span>` : "";
		this.setLabel(
			"dealer",
			`<span class="bj-name">Croupier</span>${dealerVal}`,
			true,
			DEALER.x,
			DEALER.z - 0.1,
			false,
		);

		// Remove stale cards
		for (const [key, c] of this.cards)
		{
			if (!seen.has(key)) c.removing = true;
		}

		// Turn ring
		const turnSlot = (room.seats as any[]).findIndex(
			(s) => s && s.seatId === room.turnSeatId,
		);
		if (turnSlot >= 0 && room.phase === "playing")
		{
			this.ring.visible = true;
			this.ring.position.x = SEAT_X[turnSlot];
			this.ring.position.z = SEAT_Z - 0.2;
		}
		else
		{
			this.ring.visible = false;
		}
	}

	private placeCard(
		key: string,
		c: { r: string; s: string },
		pos: THREE.Vector3,
	)
	{
		let card = this.cards.get(key);
		if (!card)
		{
			card = this.makeCard();
			this.cards.set(key, card);
		}
		const faceUp = c.r !== "?";
		if (faceUp && card.rank !== c.r + c.s)
		{
			(card.front.material as THREE.MeshBasicMaterial).map = frontTexture(c.r, c.s);
			(card.front.material as THREE.MeshBasicMaterial).needsUpdate = true;
			card.rank = c.r + c.s;
		}
		card.faceUp = faceUp;
		card.tpos.copy(pos);
		card.trotX = faceUp ? -Math.PI / 2 : Math.PI / 2;
		card.tscale = 1;
		card.removing = false;
	}

	private setSeatLabel(slot: number, s: any, room: any)
	{
		const name = (s.display_name || s.login) + (s.isBot ? " 🤖" : "");
		const RES: Record<string, string> =
			{ win: "Gagné", lose: "Perdu", push: "Égalité", blackjack: "BJ!", bust: "Bust" };
		const res =
			s.result && room.phase === "payout"
				? `<span class="bj-res ${s.result}">${RES[s.result as string] ?? ""}${s.win > 0 ? " +" + s.win : ""}</span>`
				: "";
		const html = `
			<span class="bj-name ${s.userId === this.myId ? "me" : ""}">${name}</span>
			<span class="bj-line">
				${s.cards?.length ? `<span class="bj-val">${s.value}</span>` : ""}
				${s.bet ? `<span class="bj-bet">${s.bet}</span>` : ""}
			</span>${res}`;
		this.setLabel(`seat${slot}`, html, true, SEAT_X[slot], SEAT_Z, false);
	}

	private setLabel(
		key: string,
		html: string,
		visible: boolean,
		x: number,
		z: number,
		empty: boolean,
	)
	{
		const el = this.ensureLabel(key);
		const l = this.labels.get(key)!;
		el.innerHTML = html;
		el.style.display = visible ? "" : "none";
		l.obj.visible = visible;
		l.obj.position.set(x, 0.05, z + 1.2);
	}

	private loop = () =>
	{
		this.raf = requestAnimationFrame(this.loop);
		for (const [key, c] of this.cards)
		{
			const g = c.group;
			g.position.lerp(c.tpos, 0.16);
			g.rotation.x += (c.trotX - g.rotation.x) * 0.16;
			const target = c.removing ? 0.01 : c.tscale;
			const sc = g.scale.x + (target - g.scale.x) * 0.18;
			g.scale.setScalar(sc);
			if (c.removing && sc < 0.05)
			{
				this.scene.remove(g);
				this.cards.delete(key);
			}
		}
		this.renderer.render(this.scene, this.camera);
		this.labelRenderer.render(this.scene, this.camera);
	};

	dispose()
	{
		cancelAnimationFrame(this.raf);
		window.removeEventListener("resize", this.onResize);
		this.renderer.dispose();
		this.renderer.domElement.remove();
		this.labelRenderer.domElement.remove();
	}
}
