export function initAmbient(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;

  const resize = () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  };
  resize();

  interface Star {
    x: number;
    y: number;
    len: number;
    speed: number;
    angle: number;
    alpha: number;
    size: number;
  }

  const MAX = 35;
  const stars: Star[] = [];

  function spawn(initialY = false): Star {
    // angle: mostly downward, slight left-right drift (75°–105° from horizontal)
    const angle = (Math.PI / 180) * (75 + Math.random() * 30);
    const x = Math.random() * (innerWidth + 200) - 100;
    const y = initialY
      ? Math.random() * innerHeight  // spread on init
      : -(Math.random() * 200);      // spawn above screen
    return {
      x,
      y,
      len: 50 + Math.random() * 100,
      speed: 1.5 + Math.random() * 3,
      angle,
      alpha: 0.1 + Math.random() * 0.5,
      size: 0.6 + Math.random() * 1,
    };
  }

  for (let i = 0; i < MAX; i++) stars.push(spawn(true));

  let raf = 0;

  function loop() {
    raf = requestAnimationFrame(loop);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const s of stars) {
      s.x += Math.cos(s.angle) * s.speed;
      s.y += Math.sin(s.angle) * s.speed;

      if (s.y > innerHeight + s.len || s.x < -100 || s.x > innerWidth + 100) {
        Object.assign(s, spawn(false));
        continue;
      }

      const tx = s.x - Math.cos(s.angle) * s.len;
      const ty = s.y - Math.sin(s.angle) * s.len;

      const grad = ctx.createLinearGradient(tx, ty, s.x, s.y);
      grad.addColorStop(0, `rgba(180,210,255,0)`);
      grad.addColorStop(0.6, `rgba(180,210,255,${s.alpha * 0.35})`);
      grad.addColorStop(1, `rgba(220,235,255,${s.alpha})`);

      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.shadowBlur = 5;
      ctx.shadowColor = `rgba(150,200,255,${s.alpha * 0.4})`;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  loop();
  addEventListener("resize", resize);

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
  };
}
