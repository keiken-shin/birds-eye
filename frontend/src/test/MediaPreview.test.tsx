// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConvertFileSrc, mockIsTauri } = vi.hoisted(() => ({
  mockIsTauri: vi.fn(),
  mockConvertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
  isTauri: () => mockIsTauri(),
}));

import { mediaSrcFromPath, mediaTypeFromPath } from "../components/MediaPreview";

describe("mediaSrcFromPath", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(false);
    mockConvertFileSrc.mockClear();
  });

  it("uses convertFileSrc in Tauri runtime", () => {
    mockIsTauri.mockReturnValue(true);

    expect(mediaSrcFromPath("C:\\Users\\me\\photo.jpg")).toBe("asset://C:\\Users\\me\\photo.jpg");
    expect(mockConvertFileSrc).toHaveBeenCalledWith("C:\\Users\\me\\photo.jpg");
  });

  it("leaves existing URLs alone", () => {
    mockIsTauri.mockReturnValue(true);

    expect(mediaSrcFromPath("file:///tmp/photo.jpg")).toBe("file:///tmp/photo.jpg");
    expect(mediaSrcFromPath("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
  });
});

describe("mediaTypeFromPath", () => {
  it.each([
    ["photo.jpg", "image"],
    ["PHOTO.JPEG", "image"],
    ["image.png", "image"],
    ["anim.gif", "image"],
    ["clip.mp4", "video"],
    ["film.mkv", "video"],
    ["movie.mov", "video"],
    ["song.mp3", "audio"],
    ["lossless.flac", "audio"],
    ["voice.wav", "audio"],
    ["model.glb", "gltf"],
    ["scene.gltf", "gltf"],
    ["mesh.fbx", "fbx"],
    ["photo.webp", "image"],
    ["scan.bmp", "image"],
    ["scan.tiff", "image"],
    ["iphone.heic", "image"],
    ["clip.avi", "video"],
    ["clip.webm", "video"],
    ["clip.m4v", "video"],
    ["podcast.aac", "audio"],
    ["music.ogg", "audio"],
    ["voice.m4a", "audio"],
    ["archive.zip", "unsupported"],
    ["script.py", "unsupported"],
    ["no-extension", "unsupported"],
  ])("mediaTypeFromPath(%s) === %s", (path, expected) => {
    expect(mediaTypeFromPath(path)).toBe(expected);
  });
});
