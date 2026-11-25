import test from "node:test";
import assert from "node:assert/strict";
import { createCharacterApi } from "../src/api/CharacterApi.js";

test("unified character API forwards commands and waits for movement completion", async () => {
  let movementListener;
  let presetCall;
  let activeMotion = "idle/idle.vrma";
  let movementState = {
    position: { x: 20, y: 30 },
    targetPosition: null,
    velocity: { x: 0, y: 0 },
    speed: 0,
    direction: { x: 0, y: 1 },
    yawDegrees: 0,
    mode: "idle",
    animation: "idle",
    progress: 0,
    terminalStatus: "idle",
    isMoving: false,
    requestedMode: "ground",
  };
  const bridge = {
    moveToPreset: (preset, options) => {
      presetCall = { preset, options };
      return { accepted: true, status: "arrived", requestId: 1 };
    },
    moveToScreen: () => ({
      accepted: true,
      status: "moving",
      requestId: 2,
      position: movementState.position,
      targetPosition: { x: 100, y: 30 },
    }),
    stopMovement: () => ({ stopped: true, status: "cancelled" }),
    onMovementChanged: (callback) => { movementListener = callback; },
  };
  const locomotion = {
    getMovementMode: () => "ground",
    getState: () => structuredClone(movementState),
    setMovementMode: (mode) => mode,
    updateTelemetry: (sample) => {
      movementState = { ...movementState, ...sample };
      return structuredClone(movementState);
    },
  };
  const motionController = {
    playMotion: async (name) => {
      activeMotion = name;
      return { accepted: true, status: "playing", motion: name };
    },
    getActiveMotion: () => activeMotion,
    setExpression: () => true,
    toggleExpression: () => ({ success: true, name: "happy", value: 1 }),
    getExpression: () => 0,
    getAvailableExpressions: () => ["happy"],
    getExpressionValues: () => ({ happy: 0 }),
    getAvailableMotions: () => [{ name: "idle/idle.vrma" }],
  };
  const { api, publishMovementState } = createCharacterApi({
    movementBridge: bridge,
    locomotion,
    motionController,
    cameraController: {
      setCameraView: (options) => options,
      getCameraState: () => ({ yaw: 0, pitch: 0, zoom: 1 }),
      resetCamera: () => ({ yaw: 0, pitch: 0, zoom: 1 }),
    },
    getOrientationController: () => ({ rotateFacing180: () => 180 }),
    isReady: () => true,
  });

  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(await api.moveToPreset("left"), {
    accepted: true,
    status: "arrived",
    requestId: 1,
  });
  assert.deepEqual(presetCall, {
    preset: "left",
    options: { mode: "ground", speed: "auto", faceTarget: true },
  });

  let moveFinished = false;
  const movePromise = api.moveToScreen(100, 30).then((result) => {
    moveFinished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(moveFinished, false);
  movementListener({
    requestId: 2,
    status: "arrived",
    position: { x: 100, y: 30 },
    targetPosition: { x: 100, y: 30 },
    timestamp: 100,
  });
  assert.equal((await movePromise).status, "arrived");

  let observedMotion = null;
  const unsubscribeMotion = api.onMotionChanged((motion) => { observedMotion = motion; });
  assert.equal(observedMotion, "idle/idle.vrma");
  await api.playMotion("attention/wave hand 1");
  assert.equal(observedMotion, "attention/wave hand 1");
  unsubscribeMotion();

  const observedMovement = [];
  const unsubscribeMovement = api.onMovementChanged((state) => observedMovement.push(state.mode));
  movementState = { ...movementState, mode: "floating", animation: "procedural_float" };
  publishMovementState(movementState);
  assert.ok(observedMovement.includes("floating"));
  unsubscribeMovement();
});
