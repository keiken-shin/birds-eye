import React, { useRef, useEffect } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const CONFIG = {
  rackSize: { x: 3, z: 8 },
  aisleWidth: 4,
  rackHeight: 12,
  levels: 5,
  boxSize: 0.85,
  colors: {
    zoneA: 0x10b981,
    zoneB: 0xf59e0b,
    zoneC: 0xf43f5e,
    rack: 0x334155,
    floor: 0x0f172a,
  },
};

type Zone = "A" | "B" | "C" | "D" | "E";

const BOX_ZONE_COLORS: Record<Zone, number> = {
  A: CONFIG.colors.zoneA,
  B: CONFIG.colors.zoneB,
  C: CONFIG.colors.zoneC,
  D: 0x3b82f6,
  E: 0x8b5cf6,
};

function buildScene(container: HTMLDivElement) {
  const w = container.clientWidth;
  const h = container.clientHeight;

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f);
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.015);

  // Camera
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200);
  camera.position.set(35, 30, 35);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  // Post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.5, 0.85);
  composer.addPass(bloomPass);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.minDistance = 10;
  controls.maxDistance = 80;
  controls.target.set(0, 5, 0);

  // Lighting
  scene.add(new THREE.AmbientLight(0x6366f1, 0.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(20, 40, 20);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.setScalar(2048);
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 100;
  Object.assign(dirLight.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40 });
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);
  scene.add(Object.assign(new THREE.DirectionalLight(0x818cf8, 0.4), { position: new THREE.Vector3(-20, 10, -20) }));

  [
    [15, 12, 15], [-15, 12, -15], [15, 12, -15], [-15, 12, 15],
  ].forEach(([x, y, z]) => {
    const pl = new THREE.PointLight(0x6366f1, 0.6, 30);
    pl.position.set(x, y, z);
    scene.add(pl);
  });

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: CONFIG.colors.floor, metalness: 0.1, roughness: 0.8 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(120, 60, 0x334155, 0x1e293b);
  grid.position.y = 0.01;
  scene.add(grid);

  // Rack materials
  const rackMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.rack, metalness: 0.7, roughness: 0.3 });
  const boxMats: Record<Zone, THREE.MeshStandardMaterial> = {
    A: new THREE.MeshStandardMaterial({ color: BOX_ZONE_COLORS.A, metalness: 0.1, roughness: 0.6 }),
    B: new THREE.MeshStandardMaterial({ color: BOX_ZONE_COLORS.B, metalness: 0.1, roughness: 0.6 }),
    C: new THREE.MeshStandardMaterial({ color: BOX_ZONE_COLORS.C, metalness: 0.1, roughness: 0.6 }),
    D: new THREE.MeshStandardMaterial({ color: BOX_ZONE_COLORS.D, metalness: 0.1, roughness: 0.6 }),
    E: new THREE.MeshStandardMaterial({ color: BOX_ZONE_COLORS.E, metalness: 0.1, roughness: 0.6 }),
  };

  function createRack(x: number, z: number, zone: Zone) {
    const rack = new THREE.Group();
    rack.position.set(x, 0, z);
    const { x: rw, z: rd } = CONFIG.rackSize;
    const rh = CONFIG.rackHeight;
    const lv = CONFIG.levels;

    const postGeo = new THREE.BoxGeometry(0.15, rh, 0.15);
    [[-rw / 2, -rd / 2], [rw / 2, -rd / 2], [-rw / 2, rd / 2], [rw / 2, rd / 2]].forEach(([px, pz]) => {
      const post = new THREE.Mesh(postGeo, rackMat);
      post.position.set(px, rh / 2, pz);
      post.castShadow = true;
      rack.add(post);
    });

    const beamH = new THREE.BoxGeometry(rw, 0.1, 0.1);
    const beamD = new THREE.BoxGeometry(0.1, 0.1, rd);
    for (let i = 1; i <= lv; i++) {
      const y = (rh / lv) * i;
      [-rd / 2, rd / 2].forEach(dz => {
        const b = new THREE.Mesh(beamH, rackMat);
        b.position.set(0, y, dz);
        rack.add(b);
      });
      [-rw / 2, rw / 2].forEach(dx => {
        const b = new THREE.Mesh(beamD, rackMat);
        b.position.set(dx, y, 0);
        rack.add(b);
      });
      const shelf = new THREE.Mesh(
        new THREE.BoxGeometry(rw - 0.2, 0.05, rd - 0.2),
        new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.5, roughness: 0.5 })
      );
      shelf.position.set(0, y - 0.05, 0);
      shelf.receiveShadow = true;
      rack.add(shelf);
    }

    const capacity = Math.floor(Math.random() * 40) + 60;
    rack.userData = { type: "rack", zone, capacity };

    // Fill with boxes
    const bw = rw - 0.4;
    const bd = rd - 0.4;
    const fillRatio = capacity / 100;
    for (let level = 1; level <= lv; level++) {
      const y = (rh / lv) * level + 0.3;
      const cols = Math.floor(bw / (CONFIG.boxSize + 0.1));
      const rows = Math.floor(bd / (CONFIG.boxSize + 0.1));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() > fillRatio * 0.9) continue;
          const s = CONFIG.boxSize * (0.7 + Math.random() * 0.5);
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(s, s * 0.8, s),
            Math.random() > 0.7 ? Object.assign(boxMats[zone].clone(), {
              emissive: new THREE.Color(BOX_ZONE_COLORS[zone]),
              emissiveIntensity: 0.15,
            }) : boxMats[zone]
          );
          box.position.set(
            (c - (cols - 1) / 2) * (CONFIG.boxSize + 0.1),
            y,
            (r - (rows - 1) / 2) * (CONFIG.boxSize + 0.1)
          );
          box.rotation.y = (Math.random() - 0.5) * 0.1;
          box.castShadow = true;
          box.receiveShadow = true;
          rack.add(box);
        }
      }
    }

    scene.add(rack);
    return rack;
  }

  // Generate warehouse
  const zones: Zone[] = ["A", "A", "A", "B", "B", "C", "C", "D", "E"];
  const rackSpacing = CONFIG.rackSize.z + CONFIG.aisleWidth;
  const rowSpacing = CONFIG.rackSize.x + CONFIG.aisleWidth * 1.5;
  for (let row = -2; row <= 2; row++) {
    const zone = zones[Math.floor(Math.random() * zones.length)];
    for (let col = -3; col <= 3; col++) {
      if (Math.random() > 0.85) continue;
      createRack(row * rowSpacing, col * rackSpacing, zone);
    }
  }

  // Particles
  const pCount = 200;
  const pPos = new Float32Array(pCount * 3);
  const pSpeed: Array<{ y: number; x: number; z: number }> = [];
  for (let i = 0; i < pCount; i++) {
    pPos[i * 3] = (Math.random() - 0.5) * 60;
    pPos[i * 3 + 1] = Math.random() * 20;
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    pSpeed.push({ y: 0.005 + Math.random() * 0.02, x: (Math.random() - 0.5) * 0.01, z: (Math.random() - 0.5) * 0.01 });
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    color: 0x6366f1, size: 0.15, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
  }));
  scene.add(particles);

  // Animation loop
  let animId: number;
  let time = 0;

  function animate() {
    animId = requestAnimationFrame(animate);
    time += 0.01;
    controls.update();

    // Animate particles
    const pos = pGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pCount; i++) {
      pos.array[i * 3] += pSpeed[i].x;
      pos.array[i * 3 + 1] += pSpeed[i].y;
      pos.array[i * 3 + 2] += pSpeed[i].z;
      if ((pos.array as Float32Array)[i * 3 + 1] > 20) (pos.array as Float32Array)[i * 3 + 1] = 0;
    }
    pos.needsUpdate = true;

    composer.render();
  }
  animate();

  // Resize observer
  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth;
    const nh = container.clientHeight;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
    composer.setSize(nw, nh);
  });
  ro.observe(container);

  return () => {
    cancelAnimationFrame(animId);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
  };
}

export const NexusCanvas: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    return buildScene(mountRef.current);
  }, []);

  return <div ref={mountRef} className="absolute inset-0 bg-[#0a0a0f]" />;
};
