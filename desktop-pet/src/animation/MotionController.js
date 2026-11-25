import * as THREE from "three";
import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { DEFAULT_MOTION, isOneShotMotion, MOTION_OPTIONS, normalizeMotionPath } from "./motionCatalog.js";

// 需要互斥切换并归零的情绪与口型预设表情（不触碰 blink 自动眨眼）
const EMOTION_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised"];
const MOUTH_EXPRESSIONS = ["aa", "ih", "ou", "ee", "oh"];
const FADE_DURATION = 0.25;

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
    // 记录正在淡出的旧 AnimationAction，淡出完成后调用 stop() 彻底释放骨骼与表情轨道绑定
    this.fadingActions = new Map();
    // 记录临时表情（如对话触发的笑脸），倒计时结束后平滑淡出回默认表情
    this.temporaryExpression = null;
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
    this.actionCache.set(path, action);
    return action;
  }

  /**
   * 播放动作名或动作路径；较新的播放命令会覆盖尚未加载完的旧命令。
   * @param {string} name 动作名称或路径。
   * @param {{once?:boolean}} [options] 播放选项；once=true 时单次播放完毕自动触发 finished 回到默认待机。
   */
  async playMotion(name, options = {}) {
    if (!this.vrm || !this.mixer) throw new Error("人物模型尚未加载完成");
    const path = normalizeMotionPath(name);
    const requestId = ++this.requestId;

    try {
      this.setStatus(`正在加载：${path}`);
      const nextAction = await this.#loadAction(path);
      if (requestId !== this.requestId) {
        return { accepted: false, status: "superseded", motion: path };
      }

      // 默认待机动画始终循环；其余动作按显式参数 options.once 或动作目录默认规则决定是否只播一次。
      const playOnce = path !== DEFAULT_MOTION && (options?.once ?? isOneShotMotion(path));
      if (playOnce) {
        nextAction.setLoop(THREE.LoopOnce, 1);
        nextAction.clampWhenFinished = true;
      } else {
        nextAction.setLoop(THREE.LoopRepeat, Infinity);
        nextAction.clampWhenFinished = false;
      }

      if (this.currentAction && this.currentAction !== nextAction) {
        this.currentAction.fadeOut(FADE_DURATION);
        this.fadingActions.set(this.currentAction, FADE_DURATION + 0.04);
      }
      this.fadingActions.delete(nextAction);
      nextAction.reset();
      nextAction.enabled = true;
      nextAction.setEffectiveWeight(1);
      nextAction.setEffectiveTimeScale(1);
      nextAction.fadeIn(FADE_DURATION).play();
      this.currentAction = nextAction;
      this.activeMotion = path;
      // 切回默认待机时，顺带清理上一支 VRMA（如舞蹈/挥手）可能遗留的口型或附带情绪权重
      if (path === DEFAULT_MOTION) {
        this.#clearResidualMorphs();
      }
      const duration = nextAction.getClip()?.duration ?? 0;
      this.setStatus(`正在播放：${path}`);
      return { accepted: true, status: "playing", motion: path, duration };
    } catch (error) {
      this.setStatus(`动作失败：${error.message}`);
      console.error(error);
      throw error;
    }
  }

  /**
   * 每帧在 mixer.update 之后、vrm.update 之前调用：
   * 1. 彻底 stop 已完成淡出的旧动作，释放其占用的手指/口型/表情轨道；
   * 2. 推进临时对话表情的保持计时与平滑归零恢复。
   */
  update(dt) {
    if (dt <= 0) return;

    for (const [action, remaining] of this.fadingActions) {
      const nextRemaining = remaining - dt;
      if (nextRemaining <= 0) {
        if (action !== this.currentAction) {
          action.stop();
        }
        this.fadingActions.delete(action);
        if (this.activeMotion === DEFAULT_MOTION) {
          this.#clearResidualMorphs();
        }
      } else {
        this.fadingActions.set(action, nextRemaining);
      }
    }

    if (this.temporaryExpression) {
      const temp = this.temporaryExpression;
      if (temp.holdRemaining > 0) {
        temp.holdRemaining = Math.max(0, temp.holdRemaining - dt);
        this.#applyRawExpression(temp.name, temp.weight);
      } else {
        temp.weight *= Math.exp(-8 * dt);
        if (temp.weight <= 0.015) {
          this.#applyRawExpression(temp.name, 0);
          this.temporaryExpression = null;
        } else {
          this.#applyRawExpression(temp.name, temp.weight);
        }
      }
    }
  }

  #applyRawExpression(name, value) {
    const manager = this.vrm?.expressionManager;
    if (!manager?.getExpression(name)) return false;
    const normalizedValue = THREE.MathUtils.clamp(value, 0, 1);
    manager.setValue(name, normalizedValue);
    this.expressionValues.set(name, normalizedValue);
    return true;
  }

  #clearResidualMorphs() {
    const activeTempName = this.temporaryExpression?.name ?? null;
    for (const mouth of MOUTH_EXPRESSIONS) {
      this.#applyRawExpression(mouth, 0);
    }
    for (const emotion of EMOTION_EXPRESSIONS) {
      if (emotion !== activeTempName) {
        this.#applyRawExpression(emotion, 0);
      }
    }
  }

  /** 重置所有情绪与口型表情回到默认自然状态。 */
  resetExpressions() {
    this.temporaryExpression = null;
    this.#clearResidualMorphs();
  }

  /**
   * 设置临时情绪表情（用于对话互动）：保持指定秒数后自动平滑淡回默认无表情状态。
   * @param {string} name 表情名称（如 happy / surprised / neutral）。
   * @param {number} [value=1] 表情最大权重 (0~1)。
   * @param {number} [holdSeconds=3] 保持时长（秒），结束后自动平滑归零。
   */
  setTemporaryExpression(name, value = 1, holdSeconds = 3) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("表情名称必须是非空字符串");
    }
    const target = name.trim();
    if (target === "neutral") {
      this.resetExpressions();
      return true;
    }

    const clampedWeight = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 1, 0, 1);
    for (const emotion of EMOTION_EXPRESSIONS) {
      if (emotion !== target) {
        this.#applyRawExpression(emotion, 0);
      }
    }
    if (!this.#applyRawExpression(target, clampedWeight)) {
      return false;
    }
    this.temporaryExpression = {
      name: target,
      weight: clampedWeight,
      holdRemaining: Math.max(0.5, Number.isFinite(holdSeconds) ? holdSeconds : 3),
    };
    return true;
  }

  /** 设置指定表情的权重，范围限制为 0 到 1（手动持久设置，会取消同名的临时自动恢复）。 */
  setExpression(name, value = 1) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("表情名称必须是非空字符串");
    }
    if (!Number.isFinite(value)) throw new TypeError("表情强度必须是有限数字");
    if (this.temporaryExpression?.name === name) {
      this.temporaryExpression = null;
    }
    return this.#applyRawExpression(name, value);
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
