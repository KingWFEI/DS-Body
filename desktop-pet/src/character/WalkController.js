import * as THREE from "three";

/**
 * 程序化步态的骨骼叠加层。
 * 每帧先撤销上一帧的偏移，再让 VRMA 写入基础姿势，最后叠加当前行走或空中姿势。
 */
export class WalkController {
  constructor(vrm, options = {}) {
    this.vrm = vrm;
    this.phase = 0;
    this.walkWeight = 0;
    this.airWeight = 0;
    this.bodyOffset = 0;
    this.config = {
      strideLength: 175,
      minWalkCyclesPerSecond: 0.75,
      maxWalkCyclesPerSecond: 2.3,
      maxRunCyclesPerSecond: 3.5,
      runSpeed: 500,
      walkSwing: 0.34,
      runSwing: 0.46,
      kneeBend: 0.48,
      armSwing: 0.19,
      transition: 8,
      airTransition: 5,
      bodyBob: 0.018,
      airLegLift: 0.16,
      airKneeBend: 0.24,
      airArmLift: 0.18,
      airArmSpread: 0.12,
      ...options,
    };

    this.boneNames = [
      "leftUpperLeg",
      "rightUpperLeg",
      "leftLowerLeg",
      "rightLowerLeg",
      "leftUpperArm",
      "rightUpperArm",
    ];
    this.bones = new Map();
    this.offsets = new Map();
    this.missingBones = [];

    for (const name of this.boneNames) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      if (bone) {
        this.bones.set(name, bone);
        this.offsets.set(name, new THREE.Quaternion());
      } else {
        this.missingBones.push(name);
        console.warn(`[WalkController] 缺少标准化骨骼: ${name}`);
      }
    }

    this.xAxis = new THREE.Vector3(1, 0, 0);
    this.zAxis = new THREE.Vector3(0, 0, 1);
    this.tempQ = new THREE.Quaternion();
    this.zQ = new THREE.Quaternion();
    this.inverseQ = new THREE.Quaternion();
  }

  /** 只撤销本控制器上一帧添加的旋转，不改动 VRMA 或模型的基础姿势。 */
  restore() {
    for (const [name, bone] of this.bones) {
      const offset = this.offsets.get(name);
      if (offset.lengthSq() < 1e-12) continue;
      this.inverseQ.copy(offset).invert();
      bone.quaternion.multiply(this.inverseQ).normalize();
      offset.identity();
    }
  }

  /** 在骨骼当前基础姿势上叠加指定局部轴旋转，并记录可撤销偏移。 */
  rotateBone(name, xAngle = 0, zAngle = 0) {
    const bone = this.bones.get(name);
    if (!bone || (Math.abs(xAngle) < 1e-5 && Math.abs(zAngle) < 1e-5)) return;

    const offset = this.offsets.get(name);
    this.tempQ.setFromAxisAngle(this.xAxis, xAngle);
    this.zQ.setFromAxisAngle(this.zAxis, zAngle);
    this.tempQ.multiply(this.zQ);
    bone.quaternion.multiply(this.tempQ).normalize();
    offset.copy(this.tempQ);
  }

  /** 按真实速度推进步态相位，并混合地面步态和空中姿态。 */
  update(dt, state = {}) {
    const c = this.config;
    const mode = state.mode ?? "idle";
    const walkMode = mode === "walking" || mode === "running";
    const airMode = mode === "jumping" || mode === "floating" || mode === "landing";
    const floatingWalkMode = mode === "floating" && state.isHorizontalMovement;
    const targetWalkWeight = state.isMoving && (walkMode || floatingWalkMode) ? 1 : 0;
    const targetAirWeight = airMode ? (state.airHeight ?? 1) : 0;

    this.walkWeight += (targetWalkWeight - this.walkWeight) *
      (1 - Math.exp(-c.transition * dt));
    this.airWeight += (targetAirWeight - this.airWeight) *
      (1 - Math.exp(-c.airTransition * dt));

    const speed = Math.max(0, state.speed ?? 0);
    const running = mode === "running" || (floatingWalkMode && speed >= c.runSpeed);
    const cyclesPerSecond = running
      ? THREE.MathUtils.clamp(speed / c.strideLength, 2.2, c.maxRunCyclesPerSecond)
      : THREE.MathUtils.clamp(speed / c.strideLength, c.minWalkCyclesPerSecond, c.maxWalkCyclesPerSecond);
    this.phase += dt * Math.PI * 2 * cyclesPerSecond;

    const wave = Math.sin(this.phase);
    const swing = running ? c.runSwing : c.walkSwing;
    const leg = wave * swing * this.walkWeight;
    const leftKnee = Math.max(0, -wave) * c.kneeBend * this.walkWeight;
    const rightKnee = Math.max(0, wave) * c.kneeBend * this.walkWeight;
    const arm = wave * c.armSwing * this.walkWeight;
    const air = this.airWeight;

    this.rotateBone("leftUpperLeg", leg + c.airLegLift * air);
    this.rotateBone("rightUpperLeg", -leg + c.airLegLift * air);
    this.rotateBone("leftLowerLeg", -leftKnee - c.airKneeBend * air);
    this.rotateBone("rightLowerLeg", -rightKnee - c.airKneeBend * air);
    this.rotateBone("leftUpperArm", -arm - c.airArmLift * air, c.airArmSpread * air);
    this.rotateBone("rightUpperArm", arm - c.airArmLift * air, -c.airArmSpread * air);

    this.bodyOffset = Math.abs(Math.sin(this.phase * 2)) * c.bodyBob * this.walkWeight;
    return this.getState();
  }

  /** 获取用于视觉层的身体起伏偏移。 */
  getBodyOffset() {
    return this.bodyOffset;
  }

  getState() {
    return {
      walkWeight: this.walkWeight,
      airWeight: this.airWeight,
      phase: this.phase,
      controlledBones: [...this.bones.keys()],
      missingBones: [...this.missingBones],
    };
  }
}
