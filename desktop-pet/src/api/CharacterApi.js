/**
 * 创建供后台智能体或其他渲染端代码调用的桌宠控制接口。
 * 本模块不依赖 DOM；界面也必须通过此接口触发角色行为。
 */
export function createCharacterApi({
  movementBridge = globalThis.__desktopPetBridge ?? globalThis.desktopPet,
  locomotion,
  modelScaleController,
  motionController,
  cameraController,
  getOrientationController,
  isReady,
}) {
  const pendingMoves = new Map();
  const movementListeners = new Set();
  const motionListeners = new Set();
  let lastMovementSignature = "";
  // 切换情绪表情时需要归零的互斥情绪列表，避免多个情绪叠加导致五官变形。
  const EMOTION_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised"];

  function getMovementState() {
    return locomotion.getState();
  }

  function notifyMovementListeners(state) {
    const signature = [
      state.requestId,
      state.mode,
      state.animation,
      state.position?.x,
      state.position?.y,
      Math.round(state.speed),
      Math.round(state.yawDegrees),
      state.isMoving,
      state.isHorizontalMovement,
      state.requestedMode,
      Math.round(state.progress * 100),
      state.terminalStatus,
    ].join("|");
    if (signature === lastMovementSignature) return;
    lastMovementSignature = signature;

    for (const listener of movementListeners) {
      try {
        listener(getMovementState());
      } catch (error) {
        movementListeners.delete(listener);
        console.error("桌宠状态订阅回调失败：", error);
      }
    }
  }

  function notifyMotionListeners(motion) {
    for (const listener of motionListeners) {
      try {
        listener(motion);
      } catch (error) {
        motionListeners.delete(listener);
        console.error("桌宠动作订阅回调失败：", error);
      }
    }
  }

  function waitForMovementResult(result) {
    if (!result?.accepted) {
      return Promise.reject(new Error(result?.error ?? "移动命令未被接受"));
    }
    if (result.status !== "moving") return Promise.resolve(result);
    return new Promise((resolve) => pendingMoves.set(result.requestId, resolve));
  }

  async function startMove(command) {
    if (!movementBridge) throw new Error("桌面坐标移动需要 Electron 环境");
    const result = await command();
    return waitForMovementResult(result);
  }

  /**
   * 移动到 Windows 桌面逻辑坐标（DIP）。Promise 在到达、取消或错误后结束。
   * @param {number} x 目标屏幕 X 坐标。
   * @param {number} y 目标屏幕 Y 坐标。
   * @param {{mode?:"auto"|"ground"|"air",speed?:"auto"|"slow"|"normal"|"fast"|number,faceTarget?:boolean}} [options] 移动选项。
   */
  function moveToScreen(x, y, options = {}) {
    options ??= {};
    return startMove(() => movementBridge.moveToScreen(x, y, {
      mode: options.mode ?? locomotion.getMovementMode(),
      speed: options.speed ?? "auto",
      faceTarget: options.faceTarget ?? true,
    }));
  }

  /** 按 left/right/up/down、四个对角线、center 或 home 预设移动。 */
  function moveToPreset(preset, options = {}) {
    options ??= {};
    return startMove(() => movementBridge.moveToPreset(preset, {
      mode: options.mode ?? locomotion.getMovementMode(),
      speed: options.speed ?? "auto",
      faceTarget: options.faceTarget ?? true,
    }));
  }

  /** 取消当前移动；没有任务时返回 idle。 */
  async function stopMovement() {
    if (!movementBridge) return { stopped: false, status: "unavailable" };
    return movementBridge.stopMovement();
  }

  /** 设置模型显示比例，范围为 0.5 到 1.4，1 表示原始大小。 */
  function setModelScale(scale) {
    if (!modelScaleController) throw new Error("模型比例控制器不可用");
    return modelScaleController.setScale(scale);
  }

  /** 设置桌宠窗口是否始终置顶（浏览器预览环境下降级返回目标布尔值）。 */
  async function setAlwaysOnTop(flag) {
    const nextFlag = Boolean(flag);
    if (typeof movementBridge?.setAlwaysOnTop !== "function") {
      return { alwaysOnTop: nextFlag };
    }
    return movementBridge.setAlwaysOnTop(nextFlag);
  }

  /** 读取桌宠窗口当前是否处于始终置顶状态。 */
  async function getAlwaysOnTop() {
    if (typeof movementBridge?.getAlwaysOnTop !== "function") {
      return { alwaysOnTop: true };
    }
    return movementBridge.getAlwaysOnTop();
  }

  /** 打开独立的历史聊天记录面板（从后端 SQLite 加载持久化记录）。 */
  function openHistoryWindow() {
    if (typeof movementBridge?.openHistoryWindow !== "function") {
      window.open("/history.html", "_blank", "width=360,height=490");
      return Promise.resolve({ opened: true, browserFallback: true });
    }
    return movementBridge.openHistoryWindow();
  }

  /** 在模型头部右上角（靠屏幕右边缘时自动翻到左上角）显示透明回答气泡。 */
  function showSpeechBubble(payload) {
    if (typeof movementBridge?.showSpeechBubble !== "function") {
      return Promise.resolve({ shown: false });
    }
    return movementBridge.showSpeechBubble(payload);
  }

  /** 播放 VRMA 动作，并通知界面和订阅者更新当前动作。 */
  async function playMotion(name, options = {}) {
    const result = await motionController.playMotion(name, options);
    if (result.status === "playing") notifyMotionListeners(result.motion);
    return result;
  }

  /**
   * 执行后端智能体伴随聊天回复下发的组合指令（表情、VRMA 动作、屏幕预设位置移动）。
   * 动作播放一遍后自动回默认待机；表情在动作期间（或约 3 秒阅读时间）保持后自动平滑恢复默认表情；
   * 移动到达目标后自动平滑转回正面并恢复默认站姿。
   * @param {{motion?:string|null,expression?:string|null,expression_weight?:number,move_preset?:string|null}} action
   */
  async function applyAgentAction(action) {
    if (!action || typeof action !== "object") {
      return { applied: false };
    }

    const summary = { applied: true, expression: null, motion: null, movePreset: null };
    let motionDuration = 0;

    // 1. 先触发伴随的 VRMA 骨骼动作（单次播放，获取动画时长以对齐表情保持时间）
    if (typeof action.motion === "string" && action.motion.trim()) {
      try {
        const motionResult = await playMotion(action.motion.trim(), { once: true });
        summary.motion = motionResult.motion;
        motionDuration = Number.isFinite(motionResult.duration) ? motionResult.duration : 0;
      } catch (error) {
        console.warn("执行智能体动作失败：", error);
      }
    }

    // 2. 设置临时面部情绪表情：在动作持续时间或至少 3 秒后自动平滑淡回默认自然表情
    if (typeof action.expression === "string" && action.expression.trim()) {
      const targetExpression = action.expression.trim();
      const weight = Number.isFinite(action.expression_weight) ? action.expression_weight : 1;
      const holdSeconds = Math.min(Math.max(motionDuration, 3.0), 8.0);

      if (typeof motionController.setTemporaryExpression === "function") {
        if (motionController.setTemporaryExpression(targetExpression, weight, holdSeconds)) {
          summary.expression = targetExpression;
        }
      } else {
        for (const emotion of EMOTION_EXPRESSIONS) {
          if (emotion !== targetExpression) {
            motionController.setExpression(emotion, 0);
          }
        }
        if (targetExpression === "neutral") {
          summary.expression = "neutral";
        } else if (motionController.setExpression(targetExpression, weight)) {
          summary.expression = targetExpression;
        }
      }
    }

    // 3. 触发屏幕预设移动（到达后由 LocomotionController 和 OrientationController 自动恢复正面待机）
    if (typeof action.move_preset === "string" && action.move_preset.trim()) {
      const preset = action.move_preset.trim();
      summary.movePreset = preset;
      moveToPreset(preset).catch((error) => {
        console.warn("执行智能体屏幕移动失败：", error);
      });
    }

    return summary;
  }

  /** 订阅运动状态；注册时立即发送当前快照，返回的函数可取消订阅。 */
  function onMovementChanged(callback) {
    if (typeof callback !== "function") throw new TypeError("状态订阅参数必须是函数");
    movementListeners.add(callback);
    try {
      callback(getMovementState());
    } catch (error) {
      movementListeners.delete(callback);
      console.error("桌宠状态订阅回调失败：", error);
    }
    return () => movementListeners.delete(callback);
  }

  /** 订阅动作变化；注册时立即发送当前动作，返回的函数可取消订阅。 */
  function onMotionChanged(callback) {
    if (typeof callback !== "function") throw new TypeError("动作订阅参数必须是函数");
    motionListeners.add(callback);
    try {
      callback(motionController.getActiveMotion());
    } catch (error) {
      motionListeners.delete(callback);
      console.error("桌宠动作订阅回调失败：", error);
    }
    return () => motionListeners.delete(callback);
  }

  /** 收到 Electron 窗口遥测后更新状态并完成对应的移动 Promise。 */
  movementBridge?.onMovementChanged((sample) => {
    const state = locomotion.updateTelemetry(sample);
    notifyMovementListeners(state);

    if (!["arrived", "cancelled", "error"].includes(sample.status)) return;
    const resolve = pendingMoves.get(sample.requestId);
    if (!resolve) return;

    pendingMoves.delete(sample.requestId);
    resolve({
      accepted: true,
      status: sample.status,
      requestId: sample.requestId,
      position: state.position,
      targetPosition: state.targetPosition,
    });
  });

  // 监听 Electron 主进程转发的对话窗口智能体动作指令。
  if (typeof movementBridge?.onAgentAction === "function") {
    movementBridge.onAgentAction((action) => {
      void applyAgentAction(action);
    });
  } else if (typeof globalThis.BroadcastChannel === "function") {
    // 浏览器多标签页开发预览模式下的降级联动通道。
    const channel = new globalThis.BroadcastChannel("ds-body:agent-action");
    channel.addEventListener("message", (event) => {
      void applyAgentAction(event.data);
    });
  }

  /**
   * 冻结公开对象，避免后端或其他调用者意外替换控制方法。
   * `window.character` 即为唯一业务控制入口。
   */
  const api = Object.freeze({
    moveToScreen,
    moveToPreset,
    stopMovement,
    setAlwaysOnTop,
    getAlwaysOnTop,
    openHistoryWindow,
    showSpeechBubble,
    applyAgentAction,
    setModelScale,
    getModelScale: () => modelScaleController?.getScale() ?? 1,
    onModelScaleChanged: (callback) => modelScaleController?.onChange(callback) ?? (() => {}),
    setMovementMode: (mode) => locomotion.setMovementMode(mode),
    getMovementState,
    onMovementChanged,
    playMotion,
    onMotionChanged,
    setExpression: (name, value = 1) => motionController.setExpression(name, value),
    resetExpressions: () => motionController.resetExpressions?.(),
    toggleExpression: (name) => motionController.toggleExpression(name),
    getExpression: (name) => motionController.getExpression(name),
    getAvailableExpressions: () => motionController.getAvailableExpressions(),
    rotateFacing180: () => getOrientationController()?.rotateFacing180() ?? null,
    getCameraState: () => cameraController.getCameraState(),
    resetCamera: () => cameraController.resetCamera(),
    getState: () => ({
      ready: Boolean(isReady()),
      motion: motionController.getActiveMotion(),
      movement: getMovementState(),
      modelScale: modelScaleController?.getScale() ?? 1,
      expressions: motionController.getExpressionValues(),
      camera: cameraController.getCameraState(),
    }),
    getAvailableMotions: () => motionController.getAvailableMotions(),
  });

  return Object.freeze({
    api,
    publishMovementState: notifyMovementListeners,
  });
}
