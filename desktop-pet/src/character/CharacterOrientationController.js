import * as THREE from "three";
import { screenDirectionToYaw } from "./LocomotionController.js";

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** 从加载后模型根节点的四元数校准角色默认正面。 */
export function getModelForwardYaw(modelRotation) {
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(modelRotation).normalize();
  return Math.atan2(forward.x, forward.z);
}

/** 计算当前相机相对目标点的水平观察方向。 */
export function getCameraHeading(camera, target) {
  const dx = camera.position.x - target.x;
  const dz = camera.position.z - target.z;
  return Math.atan2(dx, dz);
}

/** 合并桌面方向、镜头方向、模型默认朝向和用户手动偏移。 */
export function getTargetYaw({ direction, cameraHeading = 0, modelForwardYaw = 0, facingOffset = 0 }) {
  const directionYaw = screenDirectionToYaw(direction);
  if (directionYaw === null) return wrapAngle(cameraHeading - modelForwardYaw + facingOffset);
  return wrapAngle(cameraHeading - modelForwardYaw + facingOffset + directionYaw);
}

/** 将角色朝向与 VRM 内部骨骼动作分离，并用四元数平滑转身。 */
export class CharacterOrientationController {
  constructor(root, camera, cameraTarget, modelForwardYaw, options = {}) {
    this.root = root;
    this.camera = camera;
    this.cameraTarget = cameraTarget;
    this.modelForwardYaw = modelForwardYaw;
    this.facingOffset = options.initialFacingOffsetRadians ?? 0;
    this.turnSpeed = options.turnSpeed ?? 9;
    this.directionLockSpeed = options.directionLockSpeed ?? 42;
    this.targetYaw = getTargetYaw({
      direction: null,
      cameraHeading: getCameraHeading(camera, cameraTarget),
      modelForwardYaw,
      facingOffset: this.facingOffset,
    });
    this.targetQuaternion = new THREE.Quaternion();
    this.upAxis = new THREE.Vector3(0, 1, 0);
  }

  /** 将手动朝向偏移增加 180°，返回新的目标朝向角度。 */
  rotateFacing180() {
    this.facingOffset = wrapAngle(this.facingOffset + Math.PI);
    this.targetYaw = getTargetYaw({
      direction: null,
      cameraHeading: getCameraHeading(this.camera, this.cameraTarget),
      modelForwardYaw: this.modelForwardYaw,
      facingOffset: this.facingOffset,
    });
    return THREE.MathUtils.radToDeg(this.targetYaw);
  }

  /**
   * 移动过程中根据锁定后的真实运动方向平滑转向；
   * 移动结束后自动平滑转回默认正面朝向（面向屏幕前的用户）。
   */
  update(state, dt) {
    if (
      state.isMoving && state.faceTarget !== false &&
      (state.directionLocked ?? state.speed >= this.directionLockSpeed)
    ) {
      this.targetYaw = getTargetYaw({
        direction: state.direction,
        cameraHeading: getCameraHeading(this.camera, this.cameraTarget),
        modelForwardYaw: this.modelForwardYaw,
        facingOffset: this.facingOffset,
      });
    } else if (!state.isMoving) {
      this.targetYaw = getTargetYaw({
        direction: null,
        cameraHeading: getCameraHeading(this.camera, this.cameraTarget),
        modelForwardYaw: this.modelForwardYaw,
        facingOffset: this.facingOffset,
      });
    }

    this.targetQuaternion.setFromAxisAngle(this.upAxis, this.targetYaw);
    this.root.quaternion.slerp(this.targetQuaternion, 1 - Math.exp(-this.turnSpeed * dt));
    return this.getYawDegrees();
  }

  getYawDegrees() {
    const q = this.root.quaternion;
    const yaw = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.x * q.x),
    );
    return THREE.MathUtils.radToDeg(wrapAngle(yaw));
  }
}
