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

  /** 在模型窗口旁打开独立的对话窗口，避免遮挡 3D 模型。 */
  function openChatWindow() {
    if (typeof movementBridge?.openChatWindow !== "function") {
      return Promise.reject(new Error("对话窗口需要 Electron 环境"));
    }
    return movementBridge.openChatWindow();
  }

  /** 播放 VRMA 动作，并通知界面和订阅者更新当前动作。 */
  async function playMotion(name) {
    const result = await motionController.playMotion(name);
    if (result.status === "playing") notifyMotionListeners(result.motion);
    return result;
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

  /**
   * 冻结公开对象，避免后端或其他调用者意外替换控制方法。
   * `window.character` 即为唯一业务控制入口。
   */
  const api = Object.freeze({
    moveToScreen,
    moveToPreset,
    stopMovement,
    openChatWindow,
    setModelScale,
    getModelScale: () => modelScaleController?.getScale() ?? 1,
    onModelScaleChanged: (callback) => modelScaleController?.onChange(callback) ?? (() => {}),
    setMovementMode: (mode) => locomotion.setMovementMode(mode),
    getMovementState,
    onMovementChanged,
    playMotion,
    onMotionChanged,
    setExpression: (name, value = 1) => motionController.setExpression(name, value),
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
