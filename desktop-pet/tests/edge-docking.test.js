import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeDockButtonBounds,
  computeRestoredPetPosition,
  detectEdgeDockSide,
} = require("../electron/edgeDocking.cjs");

const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1400 },
};

const leftSecondaryDisplay = {
  id: 2,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
};

test("docks only when at least half of the pet window crosses outer left or right screen edge", () => {
  const size = { width: 280, height: 480 };

  // 超出左边缘不足一半（仅超出 100px < 140px）：不折叠
  assert.equal(
    detectEdgeDockSide({ x: -100, y: 300, ...size }, [primaryDisplay]),
    null,
  );

  // 恰好有一半超出左边缘（超出 140px = 50%）：折叠到左侧
  assert.equal(
    detectEdgeDockSide({ x: -140, y: 300, ...size }, [primaryDisplay])?.side,
    "left",
  );

  // 超过一半超出右边缘（x=2430, centerX=2570 > 2560）：折叠到右侧
  assert.equal(
    detectEdgeDockSide({ x: 2430, y: 300, ...size }, [primaryDisplay])?.side,
    "right",
  );
});

test("does not falsely dock when crossing internal seam between dual monitors", () => {
  const displays = [leftSecondaryDisplay, primaryDisplay];
  const size = { width: 280, height: 480 };

  // 窗口正好骑在两块屏幕 x=0 的拼接缝中央（centerX = 0）：不折叠
  assert.equal(
    detectEdgeDockSide({ x: -140, y: 300, ...size }, displays),
    null,
  );

  // 真正超出左扩展屏最左侧一半（x = -2065, centerX = -1925 <= -1920）：折叠到左侧
  const hit = detectEdgeDockSide({ x: -2065, y: 300, ...size }, displays);
  assert.equal(hit?.side, "left");
  assert.equal(hit?.display.id, 2);
});

test("computes flush side tab bounds and restores pet safely inside workArea", () => {
  const petBounds = { x: 2440, y: 400, width: 280, height: 480 };
  const dockSize = { width: 58, height: 68 };

  const dockBounds = computeDockButtonBounds({
    side: "right",
    display: primaryDisplay,
    petBounds,
    dockSize,
  });
  assert.equal(dockBounds.x, 2560 - 58);
  assert.ok(dockBounds.y >= 12 && dockBounds.y <= 1400 - 68 - 12);

  const restored = computeRestoredPetPosition({
    side: "right",
    display: primaryDisplay,
    petSize: { width: 280, height: 480 },
    dockBounds,
    margin: 16,
  });
  assert.equal(restored.x, 2560 - 280 - 16);
  assert.equal(restored.y, 400);
});
