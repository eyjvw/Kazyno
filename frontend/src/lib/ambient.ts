import * as THREE from "three";

// Subtle drifting particle field for page backgrounds. Low-key, not flashy.
export function initAmbient(canvas: HTMLCanvasElement) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
  cam.position.z = 14;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const size = () => {
    renderer.setSize(innerWidth, innerHeight);
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
  };
  size();

  const N = 480;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 26;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x5b9bff,
    size: 0.16,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);

  let raf = 0;
  let mx = 0;
  let my = 0;
  const onMove = (e: PointerEvent) => {
    mx = (e.clientX / innerWidth - 0.5) * 2;
    my = (e.clientY / innerHeight - 0.5) * 2;
  };
  addEventListener("pointermove", onMove);

  const clock = new THREE.Clock();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    pts.rotation.y = t * 0.025;
    pts.rotation.x = Math.sin(t * 0.05) * 0.08;
    // gentle parallax toward cursor
    cam.position.x += (mx * 1.5 - cam.position.x) * 0.03;
    cam.position.y += (-my * 1.5 - cam.position.y) * 0.03;
    cam.lookAt(0, 0, 0);
    renderer.render(scene, cam);
  };
  loop();
  addEventListener("resize", size);

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", size);
    removeEventListener("pointermove", onMove);
    renderer.dispose();
  };
}
