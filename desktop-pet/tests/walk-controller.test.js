import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WalkController } from "../src/character/WalkController.js";

const boneNames = [
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftUpperArm",
  "rightUpperArm",
];

test("walk offsets restore exactly without leaving residual bone rotation", () => {
  const bones = new Map();
  for (const [index, name] of boneNames.entries()) {
    const bone = new THREE.Bone();
    bone.quaternion.setFromEuler(new THREE.Euler(index * 0.04, -index * 0.02, index * 0.03));
    bones.set(name, bone);
  }
  const initial = new Map([...bones].map(([name, bone]) => [name, bone.quaternion.clone()]));
  const vrm = { humanoid: { getNormalizedBoneNode: (name) => bones.get(name) } };
  const controller = new WalkController(vrm);

  for (let frame = 0; frame < 120; frame += 1) {
    controller.restore();
    controller.update(1 / 60, {
      mode: frame < 90 ? "walking" : "idle",
      isMoving: frame < 90,
      speed: 260,
      airHeight: 0,
    });
  }
  controller.restore();

  for (const [name, bone] of bones) {
    assert.ok(initial.get(name).angleTo(bone.quaternion) < 1e-6, `${name} retained an offset`);
  }
  assert.equal(controller.getState().missingBones.length, 0);
});

test("adds a horizontal step cycle without removing the floating pose", () => {
  const bones = new Map(boneNames.map((name) => [name, new THREE.Bone()]));
  const vrm = { humanoid: { getNormalizedBoneNode: (name) => bones.get(name) } };
  const controller = new WalkController(vrm);

  controller.update(1 / 60, {
    mode: "floating",
    isMoving: true,
    isHorizontalMovement: true,
    speed: 260,
    airHeight: 1,
  });

  assert.ok(controller.getState().walkWeight > 0);
  assert.ok(controller.getState().airWeight > 0);
});
