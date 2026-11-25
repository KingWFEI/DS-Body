const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const { createWindowInteraction } = require("./WindowInteraction.cjs");

const MOVEMENT_INTERVAL_MS = 16;
const WINDOW_MARGIN = 16;
const SPEED_PRESETS = { slow: 180, normal: 300, fast: 500 };
const PET_WINDOW_BASE_SIZE = { width: 280, height: 480 };

let petWindow = null;
let chatWindow = null;
let chatPositionTimer = null;
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

  const position = getPosition();
  publishMovement(movementTelemetry(movement, status, position));
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
  const bounds = petWindow.getBounds();
  const windowSize = { width: bounds.width, height: bounds.height };
  const startPosition = { x: bounds.x, y: bounds.y };
  const display = screen.getDisplayNearestPoint({
    x: x + windowSize.width / 2,
    y: y + windowSize.height / 2,
  });
  const workArea = display.workArea;
  const targetPosition = clampToWorkArea({ x, y }, windowSize, workArea);
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
  movement.startedAt = performance.now();
  movement.durationMs = durationMs;
  activeMovement = movement;

  publishMovement(movementTelemetry(movement, "moving", startPosition));

  movementTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      finishMovement("cancelled");
      return;
    }

    try {
      const now = performance.now();
      const t = clamp((now - movement.startedAt) / movement.durationMs, 0, 1);
      const ease = t * t * (3 - 2 * t);
      const requestedX = Math.round(
        startPosition.x + (targetPosition.x - startPosition.x) * ease,
      );
      const requestedY = Math.round(
        startPosition.y + (targetPosition.y - startPosition.y) * ease,
      );
      petWindow.setPosition(requestedX, requestedY);

      const actualBounds = petWindow.getBounds();
      const position = { x: actualBounds.x, y: actualBounds.y };
      const dt = Math.max((now - movement.lastSampleTime) / 1000, 1 / 240);
      const instantX = (position.x - movement.lastSamplePosition.x) / dt;
      const instantY = (position.y - movement.lastSamplePosition.y) / dt;
      const blend = 1 - Math.exp(-9 * dt);
      movement.smoothedVelocity.x +=
        (instantX - movement.smoothedVelocity.x) * blend;
      movement.smoothedVelocity.y +=
        (instantY - movement.smoothedVelocity.y) * blend;
      const sampleSpeed = Math.hypot(
        movement.smoothedVelocity.x,
        movement.smoothedVelocity.y,
      );
      if (sampleSpeed >= 24) {
        movement.lastDirection = {
          x: movement.smoothedVelocity.x / sampleSpeed,
          y: movement.smoothedVelocity.y / sampleSpeed,
        };
      }
      movement.lastSampleTime = now;
      movement.lastSamplePosition = position;
      publishMovement(
        movementTelemetry(
          movement,
          "moving",
          position,
          movement.smoothedVelocity,
        ),
      );

      if (t >= 1) finishMovement("arrived");
    } catch (error) {
      console.error("桌宠移动失败：", error);
      finishMovement("error");
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
    },
  });
  windowInteraction = createWindowInteraction(petWindow);
  petWindow.on("will-move", stopMovement);
  petWindow.on("moved", publishIdlePosition);

  petWindow.loadURL("http://127.0.0.1:5173");
  petWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("页面加载失败：", code, description, "请先启动 npm run dev");
  });
  petWindow.webContents.on("did-finish-load", () => {
    publishIdlePosition();
  });
  petWindow.on("move", scheduleChatWindowPosition);
  petWindow.on("resize", scheduleChatWindowPosition);
  petWindow.on("closed", () => {
    if (movementTimer) clearInterval(movementTimer);
    windowInteraction?.dispose();
    windowInteraction = null;
    if (chatPositionTimer) clearTimeout(chatPositionTimer);
    movementTimer = null;
    chatPositionTimer = null;
    activeMovement = null;
    petWindow = null;
  });
}

function positionChatWindow() {
  if (
    !petWindow ||
    petWindow.isDestroyed() ||
    !chatWindow ||
    chatWindow.isDestroyed()
  )
    return;

  const petBounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const chatBounds = chatWindow.getBounds();
  const gap = 12;
  const leftX = petBounds.x - chatBounds.width - gap;
  const rightX = petBounds.x + petBounds.width + gap;
  const rightEdge = workArea.x + workArea.width;
  let x;

  // 优先放在模型左侧；左侧空间不足时放到右侧，保持两个窗口不重叠。
  if (leftX >= workArea.x) x = leftX;
  else if (rightX + chatBounds.width <= rightEdge) x = rightX;
  else {
    const leftSpace = petBounds.x - workArea.x - gap;
    const rightSpace = rightEdge - petBounds.x - petBounds.width - gap;
    x =
      leftSpace >= rightSpace
        ? petBounds.x - chatBounds.width - gap
        : petBounds.x + petBounds.width + gap;
  }

  const y = Math.max(
    workArea.y + gap,
    Math.min(
      petBounds.y + Math.round((petBounds.height - chatBounds.height) / 2),
      workArea.y + workArea.height - chatBounds.height - gap,
    ),
  );
  chatWindow.setPosition(x, y, false);
}

function scheduleChatWindowPosition() {
  if (!chatWindow || chatWindow.isDestroyed() || chatPositionTimer) return;
  chatPositionTimer = setTimeout(() => {
    chatPositionTimer = null;
    positionChatWindow();
  }, 32);
}

function openChatWindow() {
  if (!petWindow || petWindow.isDestroyed()) throw new Error("桌宠窗口不可用");

  if (chatWindow && !chatWindow.isDestroyed()) {
    positionChatWindow();
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return { opened: true, reused: true };
  }

  chatWindow = new BrowserWindow({
    width: 320,
    height: 460,
    title: "小鲸娘对话",
    parent: petWindow,
    show: false,
    resizable: false,
    backgroundColor: "#f4f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatWindow.once("ready-to-show", () => {
    positionChatWindow();
    chatWindow?.show();
  });
  chatWindow.on("closed", () => {
    chatWindow = null;
  });
  void chatWindow.loadURL("http://127.0.0.1:5173/chat.html");
  return { opened: true, reused: false };
}

function assertOwner(event) {
  if (!petWindow || event.sender !== petWindow.webContents) {
    throw new Error("无权控制桌宠窗口");
  }
}

app.whenReady().then(() => {
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
  ipcMain.handle("pet:open-chat-window", (event) => {
    assertOwner(event);
    return openChatWindow();
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
