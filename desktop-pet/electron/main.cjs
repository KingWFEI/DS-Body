const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const path = require("node:path");
const { createWindowInteraction } = require("./WindowInteraction.cjs");
const {
  computeDockButtonBounds,
  computeRestoredPetPosition,
  detectEdgeDockSide,
} = require("./edgeDocking.cjs");

const MOVEMENT_INTERVAL_MS = 16;
const WINDOW_MARGIN = 16;
const SPEED_PRESETS = { slow: 180, normal: 300, fast: 500 };
const PET_WINDOW_BASE_SIZE = { width: 280, height: 480 };
const BUBBLE_WINDOW_SIZE = { width: 268, height: 168 };
const DOCK_WINDOW_SIZE = { width: 72, height: 120 };

// 在双显卡（核显 + 独显）机器上强制使用高性能独显合成透明 WebGL 窗口，消除跨显卡复制导致的掉帧与拖影。
app.commandLine.appendSwitch("force_high_performance_gpu");

let petWindow = null;
let historyWindow = null;
let bubbleWindow = null;
let dockWindow = null;
let dockReadyPromise = null;
let dockedState = null; // { side: "left" | "right", displayId: number } | null
let lastDockPreviewSide = null;
let bubbleReadyPromise = null;
let currentBubbleSide = "right";
let bubblePositionTimer = null;
let movementTimer = null;
let activeMovement = null;
let windowInteraction = null;
let homePosition = null;
let homePositionCenter = null;
let nextRequestId = 1;

function isValidMode(mode) {
  return ["auto", "ground", "air"].includes(mode);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getPosition() {
  if (!petWindow || petWindow.isDestroyed()) return { x: 0, y: 0 };
  const { x, y } = petWindow.getBounds();
  return { x, y };
}

function getWorkAreas() {
  return screen.getAllDisplays().map(({ id, workArea }) => ({
    id,
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
  }));
}

function publishMovement(state) {
  if (
    petWindow &&
    !petWindow.isDestroyed() &&
    !petWindow.webContents.isDestroyed()
  ) {
    petWindow.webContents.send("pet:movement-state", {
      timestamp: performance.now(),
      ...state,
    });
  }
}

function publishIdlePosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  publishMovement({
    requestId: null,
    status: "idle",
    isMoving: false,
    position: { x: bounds.x, y: bounds.y },
    startPosition: null,
    targetPosition: null,
    velocity: { x: 0, y: 0 },
    speed: 0,
    direction: { x: 0, y: 1 },
    requestedMode: "auto",
    faceTarget: true,
    workAreas: getWorkAreas(),
    windowSize: { width: bounds.width, height: bounds.height },
  });
}

function movementTelemetry(
  movement,
  status,
  position,
  velocity = { x: 0, y: 0 },
) {
  const speed = Math.hypot(velocity.x, velocity.y);
  return {
    requestId: movement.requestId,
    status,
    isMoving: status === "moving",
    position,
    startPosition: movement.startPosition,
    targetPosition: movement.targetPosition,
    velocity,
    speed,
    direction:
      speed > 0
        ? { x: velocity.x / speed, y: velocity.y / speed }
        : movement.lastDirection,
    requestedMode: movement.requestedMode,
    faceTarget: movement.faceTarget,
    workAreas: movement.workAreas,
    windowSize: movement.windowSize,
  };
}

function finishMovement(status) {
  const movement = activeMovement;
  if (!movement) return { stopped: false, status: "idle" };

  if (movementTimer) clearInterval(movementTimer);
  movementTimer = null;
  activeMovement = null;
  windowInteraction?.setMoving(false);

  const position = getPosition();
  publishMovement(movementTelemetry(movement, status, position, { x: 0, y: 0 }));
  if (status === "arrived") {
    void checkAndEnterEdgeDock();
  }
  return { stopped: true, status, requestId: movement.requestId, position };
}

function stopMovement() {
  return finishMovement("cancelled");
}

function clampToWorkArea(position, windowSize, area) {
  const minX = area.x + WINDOW_MARGIN;
  const minY = area.y + WINDOW_MARGIN;
  const maxX = Math.max(
    minX,
    area.x + area.width - windowSize.width - WINDOW_MARGIN,
  );
  const maxY = Math.max(
    minY,
    area.y + area.height - windowSize.height - WINDOW_MARGIN,
  );
  return {
    x: Math.round(clamp(position.x, minX, maxX)),
    y: Math.round(clamp(position.y, minY, maxY)),
  };
}

function setWindowScale(scale) {
  if (!petWindow || petWindow.isDestroyed() || !Number.isFinite(scale)) return;
  stopMovement();
  const nextScale = Math.round(clamp(scale, 0.5, 1.4) * 100) / 100;
  const width = Math.round(PET_WINDOW_BASE_SIZE.width * nextScale);
  const height = Math.round(PET_WINDOW_BASE_SIZE.height * nextScale);
  const bounds = petWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const position = clampToWorkArea(
    {
      x: center.x - width / 2,
      y: center.y - height / 2,
    },
    { width, height },
    area,
  );

  petWindow.setBounds({ ...position, width, height }, false);
  publishIdlePosition();

  // home 预设保持同一中心点，缩放后也回到视觉上的原位。
  if (homePositionCenter) {
    const homeArea = screen.getDisplayNearestPoint(homePositionCenter).workArea;
    homePosition = clampToWorkArea(
      {
        x: homePositionCenter.x - width / 2,
        y: homePositionCenter.y - height / 2,
      },
      { width, height },
      homeArea,
    );
  }
}

function resolveTravelSpeed(distance, requestedSpeed) {
  if (Number.isFinite(requestedSpeed) && requestedSpeed > 0)
    return requestedSpeed;
  if (requestedSpeed === "auto")
    return distance >= 800 ? 620 : SPEED_PRESETS.normal;
  return SPEED_PRESETS[requestedSpeed] ?? SPEED_PRESETS.normal;
}

function startMovement(x, y, options = {}) {
  if (!petWindow || petWindow.isDestroyed()) throw new Error("桌宠窗口不可用");
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("目标坐标必须是有限数字");

  const requestedMode = options.mode ?? "auto";
  if (!isValidMode(requestedMode))
    throw new Error(`未知运动模式：${requestedMode}`);

  stopMovement();
  if (dockedState) {
    awaitRestoreFromDockSync();
  }
  const bounds = petWindow.getBounds();
  const windowSize = { width: bounds.width, height: bounds.height };
  const startPosition = { x: bounds.x, y: bounds.y };
  const requestedEdgeDock = detectEdgeDockSide(
    { x, y, width: windowSize.width, height: windowSize.height },
    screen.getAllDisplays(),
  );
  const display = requestedEdgeDock?.display ?? screen.getDisplayNearestPoint({
    x: x + windowSize.width / 2,
    y: y + windowSize.height / 2,
  });
  const workArea = display.workArea;
  // 若外部显式传入超出屏幕左右边缘过半的目标坐标，允许走到半出界处并在到达后自动折叠为侧边按钮
  const targetPosition = requestedEdgeDock
    ? {
        x: Math.round(
          requestedEdgeDock.side === "left"
            ? display.bounds.x - Math.ceil(windowSize.width / 2) - 4
            : display.bounds.x + display.bounds.width - Math.floor(windowSize.width / 2) + 4,
        ),
        y: clampToWorkArea({ x: workArea.x + WINDOW_MARGIN, y }, windowSize, workArea).y,
      }
    : clampToWorkArea({ x, y }, windowSize, workArea);
  const workAreas = getWorkAreas();
  const requestId = nextRequestId++;
  const distance = Math.hypot(
    targetPosition.x - startPosition.x,
    targetPosition.y - startPosition.y,
  );
  const movement = {
    requestId,
    startPosition,
    targetPosition,
    requestedMode,
    faceTarget: options.faceTarget !== false,
    workAreas,
    windowSize,
    lastSampleTime: performance.now(),
    lastSamplePosition: startPosition,
    smoothedVelocity: { x: 0, y: 0 },
    lastDirection: { x: 0, y: 1 },
  };

  if (distance < 2) {
    publishMovement(movementTelemetry(movement, "arrived", startPosition));
    return {
      accepted: true,
      status: "arrived",
      requestId,
      targetPosition,
      position: startPosition,
    };
  }

  const speed = resolveTravelSpeed(distance, options.speed ?? "auto");
  const durationMs = clamp((distance / speed) * 1000, 180, 12000);
  const deltaX = targetPosition.x - startPosition.x;
  const deltaY = targetPosition.y - startPosition.y;
  const unitDirection = { x: deltaX / distance, y: deltaY / distance };

  movement.startedAt = performance.now();
  movement.durationMs = durationMs;
  movement.deltaX = deltaX;
  movement.deltaY = deltaY;
  movement.travelSpeed = speed;
  movement.lastDirection = unitDirection;
  movement.lastSetX = startPosition.x;
  movement.lastSetY = startPosition.y;
  movement.lastTickAt = movement.startedAt;
  activeMovement = movement;
  windowInteraction?.setMoving(true);

  publishMovement(
    movementTelemetry(movement, "moving", startPosition, {
      x: unitDirection.x * Math.min(speed * 0.25, 80),
      y: unitDirection.y * Math.min(speed * 0.25, 80),
    }),
  );

  // 兜底定时器：正常情况下由渲染层 VSync (如 144Hz/280Hz) 驱动 stepActiveMovement，
  // 仅当渲染帧间隔超过 22ms 未触发时才由主进程兜底推进。
  movementTimer = setInterval(() => {
    if (!activeMovement) return;
    if (performance.now() - activeMovement.lastTickAt >= 22) {
      stepActiveMovement();
    }
  }, MOVEMENT_INTERVAL_MS);

  return {
    accepted: true,
    status: "moving",
    requestId,
    targetPosition,
    position: startPosition,
    speed,
  };
}

/**
 * 单步推进当前窗口移动（支持由渲染端 requestAnimationFrame 按原生刷新率驱动）：
 * 1. 仅在整数像素坐标真正改变时才调用 Win32 setPosition，消除高刷屏下的冗余系统调用；
 * 2. 使用三次平滑曲线的解析导数计算瞬时速度，彻底消除整数像素差分带来的速度抖动和步伐卡顿。
 */
function stepActiveMovement() {
  const movement = activeMovement;
  if (!movement) return;
  if (!petWindow || petWindow.isDestroyed()) {
    finishMovement("cancelled");
    return;
  }

  try {
    const now = performance.now();
    movement.lastTickAt = now;
    const t = clamp((now - movement.startedAt) / movement.durationMs, 0, 1);
    const ease = t * t * (3 - 2 * t);
    const requestedX = Math.round(movement.startPosition.x + movement.deltaX * ease);
    const requestedY = Math.round(movement.startPosition.y + movement.deltaY * ease);

    if (requestedX !== movement.lastSetX || requestedY !== movement.lastSetY) {
      movement.lastSetX = requestedX;
      movement.lastSetY = requestedY;
      petWindow.setPosition(requestedX, requestedY, false);
      if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
        positionBubbleWindow();
      }
    }

    const durationSec = movement.durationMs / 1000;
    // smoothstep 导数 6*t*(1-t)，首尾保留微弱初速度让起步转身更果断顺滑
    const derivativeFactor = Math.max(6 * t * (1 - t), t < 0.96 ? 0.2 : 0);
    const velocity = {
      x: (movement.deltaX / durationSec) * derivativeFactor,
      y: (movement.deltaY / durationSec) * derivativeFactor,
    };

    const position = { x: movement.lastSetX, y: movement.lastSetY };
    publishMovement(movementTelemetry(movement, "moving", position, velocity));

    if (t >= 1) finishMovement("arrived");
  } catch (error) {
    console.error("桌宠移动失败：", error);
    finishMovement("error");
  }
}

function moveToScreen(x, y, options = {}) {
  return startMovement(x, y, options);
}

function moveToPreset(preset, options = {}) {
  if (!petWindow || petWindow.isDestroyed()) throw new Error("桌宠窗口不可用");
  const presets = [
    "left",
    "right",
    "center",
    "up",
    "down",
    "up-left",
    "up-right",
    "down-left",
    "down-right",
    "home",
  ];
  if (!presets.includes(preset)) throw new Error("未知位置");

  const bounds = petWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const minX = area.x + WINDOW_MARGIN;
  const minY = area.y + WINDOW_MARGIN;
  const maxX = Math.max(
    minX,
    area.x + area.width - bounds.width - WINDOW_MARGIN,
  );
  const maxY = Math.max(
    minY,
    area.y + area.height - bounds.height - WINDOW_MARGIN,
  );

  const positions = {
    left: { x: minX, y: bounds.y },
    right: { x: maxX, y: bounds.y },
    center: { x: (minX + maxX) / 2, y: bounds.y },
    up: { x: bounds.x, y: minY },
    down: { x: bounds.x, y: maxY },
    "up-left": { x: minX, y: minY },
    "up-right": { x: maxX, y: minY },
    "down-left": { x: minX, y: maxY },
    "down-right": { x: maxX, y: maxY },
    home: homePosition,
  };
  const target = positions[preset];
  return startMovement(target.x, target.y, options);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = PET_WINDOW_BASE_SIZE;
  const x = Math.max(area.x, area.x + area.width - width - 24);
  const y = Math.max(area.y, area.y + area.height - height - 24);
  homePosition = { x, y };
  homePositionCenter = { x: x + width / 2, y: y + height / 2 };

  petWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  windowInteraction = createWindowInteraction(petWindow);
  petWindow.on("will-move", stopMovement);
  petWindow.on("moved", () => {
    if (activeMovement) return;
    setDockPreview(null);
    void checkAndEnterEdgeDock().then((docked) => {
      if (!docked) publishIdlePosition();
    });
  });

  petWindow.loadURL("http://127.0.0.1:5173");
  petWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("页面加载失败：", code, description, "请先启动 npm run dev");
  });
  petWindow.webContents.on("did-finish-load", () => {
    publishIdlePosition();
  });
  petWindow.on("move", () => {
    if (activeMovement || dockedState) return;
    const hit = detectEdgeDockSide(petWindow.getBounds(), screen.getAllDisplays());
    setDockPreview(hit?.side ?? null);
    scheduleBubbleWindowPosition();
  });
  petWindow.on("resize", () => {
    scheduleBubbleWindowPosition();
  });
  petWindow.on("closed", () => {
    if (movementTimer) clearInterval(movementTimer);
    windowInteraction?.dispose();
    windowInteraction = null;
    if (bubblePositionTimer) clearTimeout(bubblePositionTimer);
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.destroy();
    }
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.destroy();
    }
    if (dockWindow && !dockWindow.isDestroyed()) {
      dockWindow.destroy();
    }
    bubbleWindow = null;
    historyWindow = null;
    dockWindow = null;
    bubbleReadyPromise = null;
    dockReadyPromise = null;
    dockedState = null;
    movementTimer = null;
    bubblePositionTimer = null;
    activeMovement = null;
    petWindow = null;
  });
}

/**
 * 计算并更新独立透明回答气泡窗口的位置：
 * 默认锚定在模型头部右上角；当模型靠近屏幕右边缘空间不足时，自动翻转到左上角并通知气泡翻转尾巴朝向。
 */
function positionBubbleWindow() {
  if (
    !petWindow ||
    petWindow.isDestroyed() ||
    !bubbleWindow ||
    bubbleWindow.isDestroyed()
  ) {
    return currentBubbleSide;
  }

  const petBounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const { width: bubbleWidth, height: bubbleHeight } = BUBBLE_WINDOW_SIZE;
  const rightEdge = workArea.x + workArea.width;

  // 默认贴近模型头部右上侧（适度进入主窗口右上透明留白区，视觉上紧挨角色头部）
  const rightCandidateX = petBounds.x + Math.round(petBounds.width * 0.72);
  const leftCandidateX = petBounds.x + Math.round(petBounds.width * 0.28) - bubbleWidth;

  let x;
  let side;
  if (rightCandidateX + bubbleWidth <= rightEdge - 8) {
    x = rightCandidateX;
    side = "right";
  } else {
    x = Math.max(workArea.x + 8, leftCandidateX);
    side = "left";
  }

  const preferredY = petBounds.y - 10;
  const y = clamp(
    preferredY,
    workArea.y + 8,
    workArea.y + workArea.height - bubbleHeight - 8,
  );

  bubbleWindow.setPosition(Math.round(x), Math.round(y), false);
  if (side !== currentBubbleSide) {
    currentBubbleSide = side;
    if (!bubbleWindow.webContents.isDestroyed()) {
      bubbleWindow.webContents.send("pet:bubble-side", side);
    }
  }
  return side;
}

function scheduleBubbleWindowPosition() {
  if (!bubbleWindow || bubbleWindow.isDestroyed() || !bubbleWindow.isVisible() || bubblePositionTimer) {
    return;
  }
  bubblePositionTimer = setTimeout(() => {
    bubblePositionTimer = null;
    positionBubbleWindow();
  }, 16);
}

/** 懒创建并复用常驻透明穿透的气泡子窗口，避免每次回答重新加载页面造成延迟。 */
function ensureBubbleWindow() {
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleReadyPromise) {
    return bubbleReadyPromise;
  }

  bubbleWindow = new BrowserWindow({
    width: BUBBLE_WINDOW_SIZE.width,
    height: BUBBLE_WINDOW_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "bubble-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 气泡窗口全程鼠标穿透，不抢焦点、不遮挡桌面点击
  bubbleWindow.setIgnoreMouseEvents(true, { forward: true });
  bubbleWindow.on("closed", () => {
    bubbleWindow = null;
    bubbleReadyPromise = null;
  });

  bubbleReadyPromise = new Promise((resolve) => {
    bubbleWindow.webContents.once("did-finish-load", () => resolve(bubbleWindow));
    void bubbleWindow.loadURL("http://127.0.0.1:5173/bubble.html");
  });
  return bubbleReadyPromise;
}

async function showSpeechBubble(payload) {
  if (!petWindow || petWindow.isDestroyed() || !payload || typeof payload !== "object") {
    return { shown: false };
  }
  const win = await ensureBubbleWindow();
  if (!win || win.isDestroyed() || !petWindow || petWindow.isDestroyed()) {
    return { shown: false };
  }

  const side = positionBubbleWindow();
  // showInactive 展示气泡但不夺取用户当前输入焦点
  win.showInactive();
  win.webContents.send("pet:bubble-update", { ...payload, side });
  return { shown: true, side };
}

/** 在桌宠不重叠的一侧打开独立历史聊天记录窗口（不挂载 parent 以免拖累透明主窗口 DWM 移动帧率）。 */
function openHistoryWindow() {
  if (!petWindow || petWindow.isDestroyed()) throw new Error("桌宠窗口不可用");

  const winWidth = 360;
  const winHeight = 490;
  const petBounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const gap = 14;
  const leftX = petBounds.x - winWidth - gap;
  const rightX = petBounds.x + petBounds.width + gap;
  const x = leftX >= workArea.x
    ? leftX
    : Math.min(rightX, workArea.x + workArea.width - winWidth - gap);
  const y = clamp(
    petBounds.y + Math.round((petBounds.height - winHeight) / 2),
    workArea.y + gap,
    workArea.y + workArea.height - winHeight - gap,
  );

  if (historyWindow && !historyWindow.isDestroyed()) {
    if (historyWindow.isMinimized()) historyWindow.restore();
    historyWindow.setPosition(Math.round(x), Math.round(y), false);
    historyWindow.show();
    historyWindow.focus();
    return { opened: true, reused: true };
  }

  historyWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round(x),
    y: Math.round(y),
    title: "小鲸娘 · 历史聊天对话",
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#f4f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  historyWindow.once("ready-to-show", () => {
    historyWindow?.show();
  });
  historyWindow.on("closed", () => {
    historyWindow = null;
  });
  void historyWindow.loadURL("http://127.0.0.1:5173/history.html");
  return { opened: true, reused: false };
}

/** 更新主窗口拖拽过半时的吸附视觉提示。 */
function setDockPreview(side) {
  const next = side === "left" || side === "right" ? side : null;
  if (next === lastDockPreviewSide) return;
  lastDockPreviewSide = next;
  if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isDestroyed()) {
    petWindow.webContents.send("pet:dock-preview", next);
  }
}

/** 懒创建并常驻复用侧边悬浮按钮窗口。 */
function ensureDockWindow() {
  if (dockWindow && !dockWindow.isDestroyed() && dockReadyPromise) {
    return dockReadyPromise;
  }

  dockWindow = new BrowserWindow({
    width: DOCK_WINDOW_SIZE.width,
    height: DOCK_WINDOW_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: petWindow ? petWindow.isAlwaysOnTop() : true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "dock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  dockWindow.on("closed", () => {
    dockWindow = null;
    dockReadyPromise = null;
  });

  dockReadyPromise = new Promise((resolve) => {
    dockWindow.webContents.once("did-finish-load", () => resolve(dockWindow));
    void dockWindow.loadURL("http://127.0.0.1:5173/dock.html");
  });
  return dockReadyPromise;
}

/** 将桌宠折叠到指定的屏幕左/右侧边小按钮。 */
async function enterEdgeDock(side, display) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const normalizedSide = side === "left" ? "left" : "right";
  const petBounds = petWindow.getBounds();
  const targetDisplay = display ?? screen.getDisplayMatching(petBounds);

  stopMovement();
  setDockPreview(null);

  const win = await ensureDockWindow();
  if (!win || win.isDestroyed() || !petWindow || petWindow.isDestroyed()) return false;

  const dockBounds = computeDockButtonBounds({
    side: normalizedSide,
    display: targetDisplay,
    petBounds,
    dockSize: DOCK_WINDOW_SIZE,
  });

  dockedState = {
    side: normalizedSide,
    displayId: targetDisplay.id,
  };

  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.hide();
  }
  win.setAlwaysOnTop(petWindow.isAlwaysOnTop());
  win.setBounds(dockBounds, false);
  win.webContents.send("pet:dock-side", normalizedSide);
  win.showInactive();

  petWindow.hide();
  if (!petWindow.webContents.isDestroyed()) {
    petWindow.webContents.send("pet:docked-changed", true);
  }
  return true;
}

/** 检查当前桌宠窗口是否超出左右屏幕边缘过半，若是则立即折叠为侧边浮窗按钮。 */
async function checkAndEnterEdgeDock() {
  if (!petWindow || petWindow.isDestroyed() || dockedState) return false;
  const hit = detectEdgeDockSide(petWindow.getBounds(), screen.getAllDisplays());
  if (!hit) return false;
  return enterEdgeDock(hit.side, hit.display);
}

/** 同步唤醒（供内部在折叠状态下发起新移动时立即恢复窗口）。 */
function awaitRestoreFromDockSync() {
  if (!petWindow || petWindow.isDestroyed() || !dockedState) {
    return { restored: false };
  }

  const { side, displayId } = dockedState;
  const displays = screen.getAllDisplays();
  const targetDisplay =
    displays.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const petBounds = petWindow.getBounds();
  const dockBounds =
    dockWindow && !dockWindow.isDestroyed() ? dockWindow.getBounds() : null;

  const restoredPos = computeRestoredPetPosition({
    side,
    display: targetDisplay,
    petSize: { width: petBounds.width, height: petBounds.height },
    dockBounds,
    margin: WINDOW_MARGIN,
  });

  dockedState = null;
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.hide();
  }

  petWindow.setPosition(restoredPos.x, restoredPos.y, false);
  petWindow.show();
  if (!petWindow.webContents.isDestroyed()) {
    petWindow.webContents.send("pet:docked-changed", false);
  }
  publishIdlePosition();
  return { restored: true, side, position: restoredPos };
}

function isTrustedSender(event) {
  return Boolean(petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents);
}

function assertOwner(event) {
  if (!petWindow || event.sender !== petWindow.webContents) {
    throw new Error("无权控制桌宠窗口");
  }
}

app.whenReady().then(() => {
  // 允许本地开发源访问麦克风，供右下角语音输入与声波纹采集音频使用
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  ipcMain.handle("pet:move-to-screen", (event, x, y, options) => {
    assertOwner(event);
    return moveToScreen(x, y, options);
  });
  ipcMain.handle("pet:move-to-preset", (event, preset, options) => {
    assertOwner(event);
    return moveToPreset(preset, options);
  });
  ipcMain.handle("pet:stop-movement", (event) => {
    assertOwner(event);
    return stopMovement();
  });
  ipcMain.on("pet:vsync-tick", (event) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    stepActiveMovement();
  });
  ipcMain.handle("pet:set-always-on-top", (event, flag) => {
    assertOwner(event);
    if (!petWindow || petWindow.isDestroyed()) return { alwaysOnTop: true };
    const nextFlag = Boolean(flag);
    petWindow.setAlwaysOnTop(nextFlag);
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
      bubbleWindow.setAlwaysOnTop(nextFlag);
    }
    if (dockWindow && !dockWindow.isDestroyed()) {
      dockWindow.setAlwaysOnTop(nextFlag);
    }
    return { alwaysOnTop: petWindow.isAlwaysOnTop() };
  });
  ipcMain.handle("pet:get-always-on-top", (event) => {
    assertOwner(event);
    if (!petWindow || petWindow.isDestroyed()) return { alwaysOnTop: true };
    return { alwaysOnTop: petWindow.isAlwaysOnTop() };
  });
  ipcMain.handle("pet:dock-to-edge", async (event, side) => {
    assertOwner(event);
    if (!petWindow || petWindow.isDestroyed()) return { docked: false };
    const normalized = side === "left" ? "left" : "right";
    const display = screen.getDisplayMatching(petWindow.getBounds());
    const docked = await enterEdgeDock(normalized, display);
    return { docked, side: normalized };
  });
  ipcMain.handle("pet:restore-from-dock", (event) => {
    const isFromDock = dockWindow && !dockWindow.isDestroyed() && event.sender === dockWindow.webContents;
    const isFromPet = petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents;
    if (!isFromDock && !isFromPet) {
      throw new Error("无权恢复桌宠窗口");
    }
    return awaitRestoreFromDockSync();
  });
  ipcMain.handle("pet:open-history-window", (event) => {
    assertOwner(event);
    return openHistoryWindow();
  });
  ipcMain.handle("pet:show-speech-bubble", (event, payload) => {
    if (!isTrustedSender(event)) {
      throw new Error("无权显示桌宠回答气泡");
    }
    return showSpeechBubble(payload);
  });
  ipcMain.on("pet:hide-speech-bubble", (event) => {
    if (bubbleWindow && !bubbleWindow.isDestroyed() && event.sender === bubbleWindow.webContents) {
      bubbleWindow.hide();
    }
  });
  // 接收智能体动作指令并转发给 3D 桌宠渲染进程执行。
  ipcMain.handle("pet:dispatch-agent-action", (event, action) => {
    if (!isTrustedSender(event)) {
      throw new Error("无权向桌宠发送智能体动作指令");
    }
    if (
      !action ||
      typeof action !== "object" ||
      !petWindow ||
      petWindow.isDestroyed() ||
      petWindow.webContents.isDestroyed()
    ) {
      return { forwarded: false };
    }
    petWindow.webContents.send("pet:agent-action", action);
    return { forwarded: true };
  });
  ipcMain.on("pet:set-interaction-regions", (event, regions) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    windowInteraction?.setRegions(regions);
  });
  ipcMain.on("pet:set-window-scale", (event, scale) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    setWindowScale(scale);
  });

  createWindow();
});

app.on("before-quit", stopMovement);
app.on("window-all-closed", () => app.quit());
