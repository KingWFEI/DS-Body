import * as THREE from "three";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { DEFAULT_MOTION, isOneShotMotion, MOTION_OPTIONS, normalizeMotionPath } from "./motionCatalog.js";

/** 管理 VRMA 资源、动作切换和 VRM 表情，不负责界面或场景生命周期。 */
export class MotionController {
  constructor({ loader, motionUrl, setStatus, motionOptions = MOTION_OPTIONS }) {
    this.loader = loader;
    this.motionUrl = motionUrl;
    this.setStatus = setStatus;
    this.motionOptions = motionOptions;
    this.vrm = null;
    this.mixer = null;
    this.currentAction = null;
    this.activeMotion = "";
    this.requestId = 0;
    this.actionCache = new Map();
    this.expressionValues = new Map();
  }

  /** 在模型加载后绑定 VRM 和 AnimationMixer。 */
  attachModel(vrm, mixer) {
    this.vrm = vrm;
    this.mixer = mixer;
  }

  async #loadAction(path) {
    if (this.actionCache.has(path)) return this.actionCache.get(path);
    const data = await this.loader.loadAsync(this.motionUrl(path));
    const vrma = data.userData.vrmAnimations?.[0];
    if (!vrma) throw new Error(`无法从 ${path} 读取 VRMA 动画`);

    const clip = createVRMAnimationClip(vrma, this.vrm);
    const action = this.mixer.clipAction(clip);
    if (isOneShotMotion(path)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    this.actionCache.set(path, action);
    return action;
  }

  /** 播放动作名或动作路径；较新的播放命令会覆盖尚未加载完的旧命令。 */
  async playMotion(name) {
    if (!this.vrm || !this.mixer) throw new Error("人物模型尚未加载完成");
    const path = normalizeMotionPath(name);
    const requestId = ++this.requestId;

    try {
      this.setStatus(`正在加载：${path}`);
      const nextAction = await this.#loadAction(path);
      if (requestId !== this.requestId) {
        return { accepted: false, status: "superseded", motion: path };
      }

      if (this.currentAction && this.currentAction !== nextAction) {
        this.currentAction.fadeOut(0.25);
      }
      nextAction.reset();
      nextAction.enabled = true;
      nextAction.setEffectiveWeight(1);
      nextAction.setEffectiveTimeScale(1);
      nextAction.fadeIn(0.25).play();
      this.currentAction = nextAction;
      this.activeMotion = path;
      this.setStatus(`正在播放：${path}`);
      return { accepted: true, status: "playing", motion: path };
    } catch (error) {
      this.setStatus(`动作失败：${error.message}`);
      console.error(error);
      throw error;
    }
  }

  /** 设置指定表情的权重，范围限制为 0 到 1。 */
  setExpression(name, value = 1) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("表情名称必须是非空字符串");
    }
    if (!Number.isFinite(value)) throw new TypeError("表情强度必须是有限数字");
    const manager = this.vrm?.expressionManager;
    if (!manager?.getExpression(name)) return false;

    const normalizedValue = THREE.MathUtils.clamp(value, 0, 1);
    manager.setValue(name, normalizedValue);
    this.expressionValues.set(name, normalizedValue);
    return true;
  }

  /** 在当前权重和 0/1 之间切换表情。 */
  toggleExpression(name) {
    const currentValue = this.getExpression(name);
    if (currentValue === null) {
      this.setStatus(`当前模型没有 ${name} 表情`);
      return { success: false, name, value: null };
    }
    const value = currentValue > 0 ? 0 : 1;
    if (!this.setExpression(name, value)) {
      return { success: false, name, value: currentValue };
    }
    this.setStatus(value > 0 ? `已设置 ${name} 表情` : `已恢复 ${name} 表情`);
    return { success: true, name, value };
  }

  /** 读取模型当前表情权重；模型没有该表情时返回 null。 */
  getExpression(name) {
    const manager = this.vrm?.expressionManager;
    if (!manager?.getExpression(name)) return null;
    return manager.getValue(name) ?? this.expressionValues.get(name) ?? 0;
  }

  /** 返回当前模型可用的表情名称。 */
  getAvailableExpressions() {
    const manager = this.vrm?.expressionManager;
    if (!manager) return [];
    return [...new Set([
      ...Object.keys(manager.presetExpressionMap),
      ...Object.keys(manager.customExpressionMap),
    ])].sort();
  }

  /** 返回所有表情当前的权重快照。 */
  getExpressionValues() {
    return Object.fromEntries(
      this.getAvailableExpressions().map((name) => [name, this.getExpression(name) ?? 0]),
    );
  }

  /** 获取动作目录副本，避免调用方修改内部清单。 */
  getAvailableMotions() {
    return this.motionOptions.map((motion) => ({ ...motion }));
  }

  /** 返回当前动作名称；模型加载后初始值为默认待机。 */
  getActiveMotion() {
    return this.activeMotion || (this.vrm ? DEFAULT_MOTION : null);
  }

  /** 判断混合器结束的动作是否仍是当前动作。 */
  isCurrentAction(action) {
    return action === this.currentAction;
  }
}
