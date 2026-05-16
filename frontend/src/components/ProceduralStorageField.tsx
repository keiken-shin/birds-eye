import { useEffect, useRef } from "react";

const PALETTE = {
  line: "#555",
  lineDash: [4, 6],
  fieldStyles: [
    { fill: "#f4f1ea", stroke: "#dddddd", alpha: 0.08 },
    { fill: "#00d0c4", stroke: "#00b894", alpha: 0.12 },
    { fill: "#202328", stroke: "#636e72", alpha: 0.15 },
    { fill: "#b7ff5c", stroke: "#56ab2f", alpha: 0.10 },
  ],
  nodeColors: ["#ffffff", "#00d0c4", "#74b9ff", "#fdcb6e", "#b7ff5c"],
};

type FieldState = {
  w: number; h: number; x: number; y: number; vx: number;
  style: { fill: string; stroke: string; alpha: number };
  dead: boolean;
};

type NodeState = {
  id: number; x: number; y: number; tx: number; ty: number;
  r: number; targetR: number;
  type: "normal" | "orphan" | "leaf";
  parent: NodeState | null;
  children: NodeState[];
  state: "spawning" | "alive" | "dying" | "dead";
  opacity: number; age: number; color: string;
  vx: number; vy: number; bob: number;
  ry: number; // repulsion y-displacement (springs back to 0)
};

type LinkState = {
  a: NodeState; b: NodeState;
  opacity: number;
  state: "growing" | "alive" | "dying";
  dashOffset: number;
};

export function ProceduralStorageField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const _canvas = canvasRef.current;
    if (!_canvas) return;
    const _ctx = _canvas.getContext("2d");
    if (!_ctx) return;

    // Capture as typed consts so closures don't see the nullable ref types
    const canvas: HTMLCanvasElement = _canvas;
    const ctx: CanvasRenderingContext2D = _ctx;

    let W = 0, H = 0;
    const DPR = Math.min(window.devicePixelRatio, 2);
    let nodes: NodeState[] = [];
    let links: LinkState[] = [];
    let fields: FieldState[] = [];
    let nextId = 0;
    let afid = 0;
    let spawnTimer = 0;

    // Interaction state
    let mouseX = -9999, mouseY = -9999;
    let frameCount = 0;
    const activePulses = new Map<number, { age: number; color: string }>();
    let scheduledPulses: Array<{ nodeId: number; atFrame: number; color: string }> = [];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    function makeField(): FieldState {
      const w = 140 + Math.random() * 220;
      const h = 70 + Math.random() * 90;
      return {
        w, h,
        x: W + w + Math.random() * 300,
        y: H * 0.15 + Math.random() * (H * 0.7 - h),
        vx: -(0.3 + Math.random() * 0.4),
        style: PALETTE.fieldStyles[Math.floor(Math.random() * PALETTE.fieldStyles.length)],
        dead: false,
      };
    }

    function makeNode(x: number, y: number, type: "normal" | "orphan" = "normal"): NodeState {
      return {
        id: nextId++, x, y, tx: x, ty: y,
        r: 0, targetR: 3.5 + Math.random() * 2,
        type, parent: null, children: [],
        state: "spawning", opacity: 0, age: 0,
        color: PALETTE.nodeColors[Math.floor(Math.random() * PALETTE.nodeColors.length)],
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        bob: Math.random() * Math.PI * 2,
        ry: 0,
      };
    }

    function makeLink(a: NodeState, b: NodeState): LinkState {
      return { a, b, opacity: 0, state: "growing", dashOffset: 0 };
    }

    function updateField(f: FieldState) {
      f.x += f.vx;
      if (f.x + f.w < -100) f.dead = true;
    }

    function drawField(f: FieldState) {
      ctx.save();
      ctx.globalAlpha = f.style.alpha;
      ctx.fillStyle = f.style.fill;
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.globalAlpha = f.style.alpha * 2.5;
      ctx.strokeStyle = f.style.stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      ctx.restore();
    }

    function updateNode(n: NodeState) {
      n.age++;
      n.bob += 0.02;
      if (n.state === "spawning") {
        n.r += (n.targetR - n.r) * 0.07;
        n.opacity += (1 - n.opacity) * 0.05;
        if (Math.abs(n.r - n.targetR) < 0.3 && n.opacity > 0.92) n.state = "alive";
      } else if (n.state === "alive") {
        n.opacity = 1;
        n.r += (n.targetR - n.r) * 0.04;
        if (n.type === "orphan") {
          n.x += n.vx; n.y += n.vy;
          n.vx *= 0.92; n.vy *= 0.92;
          n.vx += (Math.random() - 0.5) * 0.02;
          n.vy += (Math.random() - 0.5) * 0.02;
        } else {
          // Spring back to bob path with repulsion offset
          n.ry *= 0.87;
          n.y = n.ty + Math.sin(n.bob) * 2 + n.ry;
        }
        if (n.x < -60) n.state = "dying";
      } else if (n.state === "dying") {
        n.r *= 0.88; n.opacity -= 0.04;
        if (n.opacity <= 0 || n.r < 0.4) n.state = "dead";
      }
    }

    function drawNode(n: NodeState) {
      if (n.opacity < 0.01) return;
      ctx.save();
      ctx.globalAlpha = n.opacity;

      // Glow halo
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 4);
      g.addColorStop(0, n.color + "44");
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 4, 0, Math.PI * 2); ctx.fill();

      // Core dot
      ctx.fillStyle = n.color;
      ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(0.1, n.r), 0, Math.PI * 2); ctx.fill();

      // Pulse ring
      const pulse = activePulses.get(n.id);
      if (pulse) {
        const ringAlpha = Math.max(0, 1 - pulse.age / 50) * n.opacity;
        if (ringAlpha > 0.01) {
          ctx.globalAlpha = ringAlpha;
          ctx.strokeStyle = pulse.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + pulse.age * 1.1, 0, Math.PI * 2); ctx.stroke();
          // Second trailing ring
          const trailAlpha = Math.max(0, 1 - (pulse.age + 8) / 50) * n.opacity * 0.4;
          if (trailAlpha > 0.01) {
            ctx.globalAlpha = trailAlpha;
            ctx.lineWidth = 0.8;
            ctx.beginPath(); ctx.arc(n.x, n.y, n.r + Math.max(0, pulse.age - 8) * 1.1, 0, Math.PI * 2); ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    function updateLink(l: LinkState) {
      if (l.state === "growing") {
        l.opacity += (1 - l.opacity) * 0.08;
        if (l.opacity > 0.92) l.state = "alive";
      }
      if (l.a.state === "dying" || l.b.state === "dying" || l.a.state === "dead" || l.b.state === "dead") {
        l.state = "dying"; l.opacity -= 0.05;
      }
      l.dashOffset -= 0.3;
    }

    function drawLink(l: LinkState) {
      if (l.opacity < 0.01) return;
      ctx.save();
      ctx.globalAlpha = l.opacity * 0.6;
      ctx.strokeStyle = PALETTE.line;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(PALETTE.lineDash);
      ctx.lineDashOffset = l.dashOffset;
      ctx.lineCap = "round";
      const mx = (l.a.x + l.b.x) / 2;
      const my = (l.a.y + l.b.y) / 2 - 30 * (Math.random() < 0.5 ? 1 : -1) * (Math.abs(l.a.y - l.b.y) < 20 ? 2 : 0.5);
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y);
      ctx.quadraticCurveTo(mx, my, l.b.x, l.b.y);
      ctx.stroke();
      ctx.restore();
    }

    function spawnNode() {
      const y = H * 0.12 + Math.random() * (H * 0.76);
      const x = W + 20 + Math.random() * 60;
      const candidates = nodes.filter(
        (n) => n.state === "alive" && n.x < x && n.x > x - 220 && Math.abs(n.y - y) < 90
      );
      let parent: NodeState | null = null;
      let type: "normal" | "orphan" = "normal";
      if (Math.random() < 0.12 || candidates.length === 0) {
        type = "orphan";
      } else {
        candidates.sort((a, b) => b.x - a.x);
        for (const c of candidates) {
          const alreadyChild = c.children.find((ch) => Math.abs(ch.y - y) < 15);
          if (alreadyChild && Math.random() < 0.5) continue;
          parent = c; break;
        }
        if (!parent) type = "orphan";
      }
      const node = makeNode(x, y, type);
      if (parent) {
        node.parent = parent;
        parent.children.push(node);
        node.ty = parent.y + (Math.random() - 0.5) * 10;
        links.push(makeLink(parent, node));
      }
      nodes.push(node);
    }

    function spawnField() {
      if (fields.length < 6 && Math.random() < 0.015) fields.push(makeField());
    }

    function cleanup() {
      const dead = new Set<number>();
      nodes = nodes.filter((n) => { if (n.state === "dead") { dead.add(n.id); return false; } return true; });
      links = links.filter((l) => !dead.has(l.a.id) && !dead.has(l.b.id));
      nodes.forEach((n) => {
        if (n.parent && dead.has(n.parent.id)) { n.parent = null; n.type = "orphan"; }
        n.children = n.children.filter((c) => !dead.has(c.id));
      });
      nodes.forEach((n) => {
        if (n.children.length === 0 && n.state === "alive" && n.type !== "orphan") n.type = "leaf";
      });
      fields = fields.filter((f) => !f.dead);
      // Remove pulses for dead nodes
      for (const id of dead) { activePulses.delete(id); }
      scheduledPulses = scheduledPulses.filter((sp) => !dead.has(sp.nodeId));
    }

    function applyRepulsion() {
      if (mouseX < -999) return;
      const RADIUS = 90;
      const FORCE = 3.5;
      for (const n of nodes) {
        if (n.state !== "alive") continue;
        const dx = n.x - mouseX;
        const dy = n.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < RADIUS && dist > 0) {
          const strength = ((RADIUS - dist) / RADIUS) * FORCE;
          const nx = dx / dist;
          const ny = dy / dist;
          if (n.type === "orphan") {
            n.vx += nx * strength;
            n.vy += ny * strength;
          } else {
            n.ry += ny * strength * 1.4;
          }
        }
      }
    }

    function triggerClick(cx: number, cy: number) {
      // Find closest alive node within 55px
      let closest: NodeState | null = null;
      let closestDist = 55;
      for (const n of nodes) {
        if (n.state !== "alive") continue;
        const d = Math.hypot(n.x - cx, n.y - cy);
        if (d < closestDist) { closestDist = d; closest = n; }
      }
      if (!closest) return;

      // BFS: schedule pulse waves outward through the link graph
      const visited = new Set<number>();
      let frontier = [closest];
      const FRAMES_PER_HOP = 16;

      for (let wave = 0; frontier.length > 0 && wave < 5; wave++) {
        const atFrame = frameCount + wave * FRAMES_PER_HOP;
        for (const n of frontier) {
          visited.add(n.id);
          scheduledPulses.push({ nodeId: n.id, atFrame, color: n.color });
        }
        const frontierIds = new Set(frontier.map((n) => n.id));
        const next: NodeState[] = [];
        for (const link of links) {
          let neighbor: NodeState | null = null;
          if (frontierIds.has(link.a.id) && !visited.has(link.b.id)) neighbor = link.b;
          else if (frontierIds.has(link.b.id) && !visited.has(link.a.id)) neighbor = link.a;
          if (neighbor && !next.find((n) => n.id === neighbor!.id)) next.push(neighbor);
        }
        frontier = next;
      }
    }

    function updateCursor() {
      if (mouseX < -999) { canvas.style.cursor = "default"; return; }
      const near = nodes.some(
        (n) => n.state === "alive" && Math.hypot(n.x - mouseX, n.y - mouseY) < 16
      );
      canvas.style.cursor = near ? "pointer" : "default";
    }

    function loop() {
      frameCount++;

      spawnTimer--;
      if (spawnTimer <= 0) { spawnNode(); spawnTimer = 40 + Math.random() * 100; }
      spawnField();

      applyRepulsion();

      const flow = 0.5;
      nodes.forEach((n) => { n.x -= n.type !== "orphan" ? flow : flow * 0.25; });
      fields.forEach(updateField);
      nodes.forEach(updateNode);
      links.forEach(updateLink);
      cleanup();

      // Activate scheduled pulses
      for (const sp of scheduledPulses) {
        if (frameCount >= sp.atFrame) {
          activePulses.set(sp.nodeId, { age: 0, color: sp.color });
        }
      }
      scheduledPulses = scheduledPulses.filter((sp) => frameCount < sp.atFrame);

      // Age active pulses
      for (const [id, pulse] of activePulses) {
        pulse.age++;
        if (pulse.age > 55) activePulses.delete(id);
      }

      updateCursor();

      ctx.clearRect(0, 0, W, H);
      fields.forEach(drawField);
      links.forEach(drawLink);
      nodes.forEach(drawNode);
      afid = requestAnimationFrame(loop);
    }

    function regen() {
      cancelAnimationFrame(afid);
      nodes = []; links = []; fields = []; nextId = 0; spawnTimer = 0;
      activePulses.clear();
      scheduledPulses = [];
      for (let i = 0; i < 10; i++) {
        const x = W * 0.1 + Math.random() * W * 0.8;
        const y = H * 0.15 + Math.random() * H * 0.7;
        const n = makeNode(x, y, "normal");
        n.state = "alive"; n.opacity = 1; n.r = n.targetR;
        nodes.push(n);
      }
      for (let i = 0; i < 3; i++) {
        const f = makeField(); f.x = W * 0.1 + Math.random() * W * 0.7; fields.push(f);
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const left = nodes.filter(
          (o) => o.id !== n.id && o.x < n.x && Math.abs(o.y - n.y) < 70 && n.x - o.x < 180
        );
        if (left.length > 0 && !n.parent) {
          const p = left.sort((a, b) => b.x - a.x)[0];
          if (!p.children.some((c) => Math.abs(c.y - n.y) < 12)) {
            n.parent = p; p.children.push(n); links.push(makeLink(p, n));
          }
        }
      }
      loop();
    }

    function getCanvasPos(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handleMouseMove(e: MouseEvent) {
      const pos = getCanvasPos(e);
      mouseX = pos.x; mouseY = pos.y;
    }
    function handleMouseLeave() {
      mouseX = -9999; mouseY = -9999;
      canvas.style.cursor = "default";
    }
    function handleClick(e: MouseEvent) {
      const pos = getCanvasPos(e);
      triggerClick(pos.x, pos.y);
    }

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("click", handleClick);

    resize();
    regen();

    const ro = new ResizeObserver(() => { resize(); });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(afid);
      ro.disconnect();
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      canvas.removeEventListener("click", handleClick);
    };
  }, []);

  return (
    <div className="relative min-h-56 overflow-hidden border-y border-y-white/15 max-sm:min-h-[166px]" aria-hidden="true">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <span className="absolute bottom-4 left-[18px] bg-[#f4f1ea] px-2 py-1.5 font-mono text-[11px] uppercase font-extrabold text-[#050607] max-sm:bottom-3 max-sm:left-3 max-sm:max-w-[calc(100%-24px)]">
        Procedural storage field
      </span>
      <span className="font-mono text-[11px] uppercase absolute bottom-4 right-[18px] text-[#9a9a94] max-sm:hidden">
        folders / density / duplicate vectors
      </span>
    </div>
  );
}
