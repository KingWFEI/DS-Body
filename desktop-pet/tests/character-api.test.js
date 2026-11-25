import test from "node:test";
import assert from "node:assert/strict";
import { createCharacterApi } from "../src/api/CharacterApi.js";
import { isOneShotMotion } from "../src/animation/motionCatalog.js";
import { MotionController } from "../src/animation/MotionController.js";

test("unified character API forwards commands and waits for movement completion", async () => {
  let movementListener;
  let agentActionListener;
  let presetCall;
  let activeMotion = "idle/idle.vrma";
  let lastPlayMotionCall = null;
  const expressionCalls = [];
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
    onAgentAction: (callback) => { agentActionListener = callback; },
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
    playMotion: async (name, options) => {
      activeMotion = name;
      lastPlayMotionCall = { name, options };
      return { accepted: true, status: "playing", motion: name, duration: 4.2 };
    },
    getActiveMotion: () => activeMotion,
    setExpression: (name, value) => {
      expressionCalls.push({ name, value, temporary: false });
      return true;
    },
    setTemporaryExpression: (name, value, holdSeconds) => {
      expressionCalls.push({ name, value, holdSeconds, temporary: true });
      return true;
    },
    resetExpressions: () => {},
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

  const summary = await api.applyAgentAction({
    motion: "dance/dance1",
    expression: "happy",
    expression_weight: 0.85,
    move_preset: "right",
  });
  assert.equal(summary.applied, true);
  assert.equal(summary.motion, "dance/dance1");
  assert.equal(summary.expression, "happy");
  assert.equal(summary.movePreset, "right");
  assert.deepEqual(lastPlayMotionCall, { name: "dance/dance1", options: { once: true } });
  assert.equal(isOneShotMotion("attention/wave hand 1.vrma"), true);
  assert.deepEqual(expressionCalls[0], {
    name: "happy",
    value: 0.85,
    holdSeconds: 4.2,
    temporary: true,
  });
  assert.equal(typeof agentActionListener, "function");
});

test("temporary expression holds during interaction and smoothly resets back to default zero", () => {
  const values = new Map([["happy", 0], ["sad", 0.6], ["aa", 0.5]]);
  const fakeVrm = {
    expressionManager: {
      getExpression: (name) => (values.has(name) ? {} : null),
      setValue: (name, value) => values.set(name, value),
      getValue: (name) => values.get(name) ?? 0,
      presetExpressionMap: { happy: {}, sad: {}, aa: {} },
      customExpressionMap: {},
    },
  };

  const controller = new MotionController({
    loader: {},
    motionUrl: (n) => n,
    setStatus: () => {},
  });
  controller.attachModel(fakeVrm, {});

  assert.equal(controller.setTemporaryExpression("happy", 1.0, 1.0), true);
  assert.equal(values.get("happy"), 1.0);
  assert.equal(values.get("sad"), 0); // 切换新情绪时立即归零旧情绪

  // 保持阶段（0.8 秒内仍为 1.0）
  controller.update(0.8);
  assert.equal(values.get("happy"), 1.0);

  // 超过保持时长后平滑衰减至归零
  for (let i = 0; i < 60; i += 1) {
    controller.update(1 / 30);
  }
  assert.equal(values.get("happy"), 0);
});
