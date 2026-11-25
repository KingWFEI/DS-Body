import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseLocomotionMode,
  clampScreenPosition,
  findWorkArea,
  LocomotionController,
  screenDirectionToYaw,
} from "../src/character/LocomotionController.js";

const windowSize = { width: 480, height: 680 };
const mainWorkArea = { id: 1, x: 0, y: 0, width: 1920, height: 1080 };
const multiDisplayAreas = [
  { id: 1, x: -1920, y: 0, width: 1920, height: 1080 },
  mainWorkArea,
];

test("clamps logical screen coordinates inside a negative-origin monitor work area", () => {
  assert.deepEqual(
    clampScreenPosition(
      { x: -2400, y: 1400 },
      multiDisplayAreas[0],
      windowSize,
      16,
    ),
    { x: -1904, y: 384 },
  );
});

test("selects the monitor containing the window center", () => {
  assert.equal(findWorkArea({ x: -1800, y: 200 }, multiDisplayAreas, windowSize).id, 1);
  assert.equal(findWorkArea({ x: 100, y: 200 }, multiDisplayAreas, windowSize).id, 1);
});

test("maps screen directions to front, side, back and diagonal yaw", () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6);
  close(screenDirectionToYaw({ x: 0, y: 1 }), 0); // down/front
  close(screenDirectionToYaw({ x: 1, y: 0 }), Math.PI / 2); // right/side
  close(screenDirectionToYaw({ x: 0, y: -1 }), Math.PI); // up/back
  close(screenDirectionToYaw({ x: -1, y: 0 }), -Math.PI / 2); // left/side
  close(screenDirectionToYaw({ x: 1, y: 1 }), Math.PI / 4); // 3/4 view
  assert.equal(screenDirectionToYaw({ x: 0, y: 0 }), null);
});

test("auto mode chooses walk, run, jump, float and landing from position and speed", () => {
  const ground = { x: 300, y: 350 };
  const high = { x: 300, y: 16 };
  const common = {
    workAreas: [mainWorkArea],
    windowSize,
    position: ground,
    startPosition: ground,
    targetPosition: { x: 900, y: 350 },
  };
  assert.equal(chooseLocomotionMode({ ...common, speed: 0 }), "turning");
  assert.equal(chooseLocomotionMode({ ...common, speed: 250 }), "walking");
  assert.equal(chooseLocomotionMode({ ...common, speed: 620 }), "running");
  assert.equal(chooseLocomotionMode({
    ...common,
    targetPosition: high,
    elapsed: 0.1,
  }), "jumping");
  assert.equal(chooseLocomotionMode({
    ...common,
    targetPosition: high,
    elapsed: 0.6,
  }), "floating");
  assert.equal(chooseLocomotionMode({
    ...common,
    startPosition: high,
    position: { x: 300, y: 340 },
    targetPosition: ground,
    elapsed: 1,
  }), "landing");
});

test("estimates speed from actual position samples and settles at arrival", () => {
  const controller = new LocomotionController({
    velocitySmoothing: 100,
    directionLockSpeed: 30,
    directionReleaseSpeed: 15,
  });
  controller.updateTelemetry({
    status: "idle",
    position: { x: 100, y: 350 },
    timestamp: 0,
    workAreas: [mainWorkArea],
    windowSize,
  });
  controller.updateTelemetry({
    status: "moving",
    requestId: 1,
    position: { x: 100, y: 350 },
    startPosition: { x: 100, y: 350 },
    targetPosition: { x: 500, y: 350 },
    timestamp: 10,
    requestedMode: "auto",
    faceTarget: true,
    workAreas: [mainWorkArea],
    windowSize,
  });
  const moving = controller.updateTelemetry({
    status: "moving",
    requestId: 1,
    position: { x: 120, y: 350 },
    startPosition: { x: 100, y: 350 },
    targetPosition: { x: 500, y: 350 },
    timestamp: 110,
    requestedMode: "auto",
    workAreas: [mainWorkArea],
    windowSize,
  });
  assert.ok(moving.speed > 190 && moving.speed < 210);
  assert.equal(moving.mode, "walking");
  assert.ok(moving.direction.x > 0.99);

  controller.updateTelemetry({
    status: "moving",
    requestId: 1,
    position: { x: 500, y: 350 },
    startPosition: { x: 100, y: 350 },
    targetPosition: { x: 500, y: 350 },
    timestamp: 310,
    requestedMode: "auto",
    workAreas: [mainWorkArea],
    windowSize,
  });
  const arrived = controller.updateTelemetry({
    status: "arrived",
    requestId: 1,
    position: { x: 500, y: 350 },
    targetPosition: { x: 500, y: 350 },
    timestamp: 311,
    workAreas: [mainWorkArea],
    windowSize,
  });
  assert.equal(arrived.isMoving, false);
  assert.equal(arrived.mode, "idle");
  assert.equal(arrived.terminalStatus, "arrived");
});

test("keeps a horizontal step cycle while floating in the upper desktop area", () => {
  const controller = new LocomotionController({ velocitySmoothing: 100 });
  const topPosition = { x: 300, y: 16 };
  const shared = {
    requestId: 10,
    startPosition: topPosition,
    targetPosition: { x: 900, y: 16 },
    requestedMode: "auto",
    workAreas: [mainWorkArea],
    windowSize,
  };

  controller.updateTelemetry({
    status: "idle",
    position: topPosition,
    timestamp: 0,
    workAreas: [mainWorkArea],
    windowSize,
  });
  const started = controller.updateTelemetry({
    ...shared,
    status: "moving",
    position: topPosition,
    timestamp: 10,
  });
  assert.equal(started.mode, "floating");
  assert.equal(started.isHorizontalMovement, true);

  const moving = controller.updateTelemetry({
    ...shared,
    status: "moving",
    position: { x: 330, y: 16 },
    timestamp: 110,
  });
  assert.equal(moving.mode, "floating");
  assert.equal(moving.animation, "procedural_float_walk");
  assert.equal(moving.airHeight, 1);
});

test("cancellation stops the active task without reporting arrival", () => {
  const controller = new LocomotionController();
  const common = {
    requestId: 2,
    startPosition: { x: 100, y: 350 },
    targetPosition: { x: 900, y: 350 },
    requestedMode: "auto",
    workAreas: [mainWorkArea],
    windowSize,
  };
  controller.updateTelemetry({
    ...common,
    status: "moving",
    position: common.startPosition,
    timestamp: 0,
  });
  const cancelled = controller.updateTelemetry({
    ...common,
    status: "cancelled",
    position: { x: 220, y: 350 },
    timestamp: 100,
  });
  assert.equal(cancelled.isMoving, false);
  assert.equal(cancelled.terminalStatus, "cancelled");
  assert.equal(cancelled.position.x, 220);
});
