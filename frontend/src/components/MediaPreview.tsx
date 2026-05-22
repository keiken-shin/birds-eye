import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

export type MediaType = "image" | "video" | "audio" | "gltf" | "fbx" | "unsupported";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "heic"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "mov", "webm", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "flac", "wav", "aac", "ogg", "m4a"]);
const GLTF_EXTS = new Set(["glb", "gltf"]);
const FBX_EXTS = new Set(["fbx"]);

export function mediaTypeFromPath(path: string): MediaType {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (GLTF_EXTS.has(ext)) return "gltf";
  if (FBX_EXTS.has(ext)) return "fbx";
  return "unsupported";
}

interface MediaPreviewProps {
  path: string;
}

export function MediaPreview({ path }: MediaPreviewProps) {
  const type = mediaTypeFromPath(path);
  const src = convertFileSrc(path);

  if (type === "image") return <ImagePreview src={src} />;
  if (type === "video") return <VideoPreview src={src} />;
  if (type === "audio") return <AudioPreview src={src} />;
  if (type === "gltf") return <ThreeDPreview src={src} loaderType="gltf" />;
  if (type === "fbx") return <ThreeDPreview src={src} loaderType="fbx" />;
  return <UnsupportedPreview ext={path.split(".").pop()?.toUpperCase() ?? "?"} />;
}

function ImagePreview({ src }: { src: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewUnavailable />;
  return (
    <div className="flex h-[160px] w-full items-center justify-center overflow-hidden bg-white/[0.03]">
      <img
        src={src}
        alt=""
        className="h-full w-full object-contain"
        onError={() => setError(true)}
      />
    </div>
  );
}

function VideoPreview({ src }: { src: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewUnavailable />;
  return (
    <div className="h-[160px] w-full bg-black">
      <video
        src={src}
        controls
        muted
        className="h-full w-full object-contain"
        onError={() => setError(true)}
      />
    </div>
  );
}

function AudioPreview({ src }: { src: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewUnavailable />;
  return (
    <div className="flex h-[160px] w-full flex-col items-center justify-center gap-3 bg-white/[0.03]">
      <svg className="h-8 w-8 text-muted/30" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
      <audio
        src={src}
        controls
        className="w-[calc(100%-24px)]"
        onError={() => setError(true)}
      />
    </div>
  );
}

function ThreeDPreview({ src, loaderType }: { src: string; loaderType: "gltf" | "fbx" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 300;
    const height = 160;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 10000);
    camera.position.set(0, 1, 3);

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 5);
    scene.add(dir);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.5;
    controls.addEventListener("start", () => { controls.autoRotate = false; });

    function centerAndAdd(object: THREE.Object3D) {
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      object.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      camera.position.set(0, maxDim * 0.5, maxDim * 2);
      camera.lookAt(0, 0, 0);
      controls.update();
      scene.add(object);
    }

    if (loaderType === "gltf") {
      new GLTFLoader().load(src, (gltf) => centerAndAdd(gltf.scene), undefined, () => setError(true));
    } else {
      new FBXLoader().load(src, (fbx) => centerAndAdd(fbx), undefined, () => setError(true));
    }

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [src, loaderType]);

  if (error) return <PreviewUnavailable />;
  return <div ref={containerRef} className="h-[160px] w-full bg-black/30" />;
}

function UnsupportedPreview({ ext }: { ext: string }) {
  return (
    <div className="flex h-[160px] w-full flex-col items-center justify-center gap-1.5 bg-white/[0.02]">
      <span className="font-mono text-16 font-black text-muted/30">.{ext.toLowerCase()}</span>
      <span className="font-mono text-10 uppercase text-muted/40">No preview</span>
    </div>
  );
}

function PreviewUnavailable() {
  return (
    <div className="flex h-[160px] w-full items-center justify-center bg-white/[0.02]">
      <span className="font-mono text-10 uppercase text-muted/40">Preview unavailable</span>
    </div>
  );
}
