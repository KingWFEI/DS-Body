import test from "node:test";
import assert from "node:assert/strict";
import {
  downsampleTo16kMono,
  encodeWav16kMono,
  getSharedSessionId,
  mergeFloat32Chunks,
} from "../src/utils/wavEncoder.js";

test("merges, downsamples 48kHz PCM to 16kHz, and encodes valid 16-bit mono WAV", () => {
  const partA = new Float32Array(2400).fill(0.5);
  const partB = new Float32Array(2400).fill(-0.5);
  const merged = mergeFloat32Chunks([partA, partB]);
  assert.equal(merged.length, 4800);

  const samples16k = downsampleTo16kMono(merged, 48000);
  assert.equal(samples16k.length, 1600);
  assert.ok(Math.abs(samples16k[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(samples16k[samples16k.length - 1] + 0.5) < 1e-5);

  const wavBuffer = encodeWav16kMono(samples16k);
  assert.equal(wavBuffer.byteLength, 44 + 1600 * 2);

  const view = new DataView(wavBuffer);
  const headerTag = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  assert.equal(headerTag, "RIFF");
  assert.equal(view.getUint16(22, true), 1); // 单声道
  assert.equal(view.getUint32(24, true), 16000); // 16kHz 采样率
  assert.equal(view.getUint16(34, true), 16); // 16-bit
});

test("persists and reuses shared session id across windows", () => {
  const store = new Map();
  const fakeStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
  };
  const first = getSharedSessionId(fakeStorage);
  const second = getSharedSessionId(fakeStorage);
  assert.equal(first, second);
  assert.ok(first.startsWith("pet-"));
});
