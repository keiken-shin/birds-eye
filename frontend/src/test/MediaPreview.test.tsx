// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mediaTypeFromPath } from "../components/MediaPreview";

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
    ["archive.zip", "unsupported"],
    ["script.py", "unsupported"],
    ["no-extension", "unsupported"],
  ])("mediaTypeFromPath(%s) === %s", (path, expected) => {
    expect(mediaTypeFromPath(path)).toBe(expected);
  });
});
