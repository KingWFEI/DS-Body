import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  CharacterOrientationController,
  getModelForwardYaw,
  getTargetYaw,
} from "../src/character/CharacterOrientationController.js";

const nearAngle = (actual, expected, tolerance = 1e-5) => {
  const difference = Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected));
  assert.ok(Math.abs(difference) <= tolerance, `${actual} is not near ${expected}`);
};

test("calibrates the model forward axis from its loaded root quaternion", () => {
  const modelRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2,
  );
  nearAngle(getModelForwardYaw(modelRotation), Math.PI / 2);
});

test("derives target yaw relative to the model and camera calibration", () => {
  nearAngle(getTargetYaw({ direction: { x: 0, y: 1 } }), 0);
  nearAngle(getTargetYaw({ direction: { x: 0, y: -1 } }), Math.PI);
  nearAngle(getTargetYaw({ direction: { x: 1, y: 0 } }), Math.PI / 2);
  nearAngle(getTargetYaw({ direction: { x: -1, y: 0 } }), -Math.PI / 2);
  nearAngle(getTargetYaw({
    direction: { x: 0, y: 1 },
    cameraHeading: Math.PI / 4,
    modelForwardYaw: Math.PI / 8,
    facingOffset: Math.PI / 8,
  }), Math.PI / 4);
});

test("turns smoothly and keeps its final heading after movement stops", () => {
  const root = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1, 3);
  const controller = new CharacterOrientationController(
    root,
    camera,
    new THREE.Vector3(0, 0, 0),
    0,
    { turnSpeed: 9, directionLockSpeed: 20 },
  );
  const movingState = {
    isMoving: true,
    faceTarget: true,
    speed: 120,
    directionLocked: true,
    direction: { x: 1, y: 0 },
  };
  for (let i = 0; i < 120; i += 1) controller.update(movingState, 1 / 60);
  nearAngle(controller.getYawDegrees() * Math.PI / 180, Math.PI / 2, 0.002);

  const heldYaw = controller.getYawDegrees();
  for (let i = 0; i < 30; i += 1) {
    controller.update({ ...movingState, isMoving: false, speed: 0 }, 1 / 60);
  }
  nearAngle(controller.getYawDegrees() * Math.PI / 180, heldYaw * Math.PI / 180, 0.002);
});
