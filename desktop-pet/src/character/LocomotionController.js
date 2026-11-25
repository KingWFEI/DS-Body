const VALID_MODES = new Set(["auto", "ground", "air"]);
const GROUNDED_STATES = new Set(["idle", "turning", "walking", "running"]);

const DEFAULT_CONFIG = {
  margin: 16,
  groundBandRatio: 0.2,
  groundVerticalTolerance: 64,
  horizontalWalkVerticalTolerance: 64,
  horizontalWalkRatio: 1.5,
  horizontalWalkMinimumDistance: 24,
  directionLockSpeed: 42,
  directionReleaseSpeed: 24,
  runSpeed: 500,
  jumpDuration: 0.34,
  landingDuration: 0.28,
  landingDistance: 110,
  velocitySmoothing: 9,
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 把桌面逻辑坐标限制在指定显示器的工作区内。 */
export function clampScreenPosition(position, workArea, windowSize, margin = 16) {
  const minX = workArea.x + margin;
  const minY = workArea.y + margin;
  const maxX = Math.max(minX, workArea.x + workArea.width - windowSize.width - margin);
  const maxY = Math.max(minY, workArea.y + workArea.height - windowSize.height - margin);
  return {
    x: Math.round(clamp(position.x, minX, maxX)),
    y: Math.round(clamp(position.y, minY, maxY)),
  };
}

/** 根据屏幕移动向量计算角色绕 Y 轴的目标朝向。 */
export function screenDirectionToYaw(direction) {
  if (!direction || Math.hypot(direction.x, direction.y) < 1e-6) return null;
  // 屏幕坐标的 +Y 向下：向下为 0°，向右 90°，向上 180°，向左 -90°。
  return Math.atan2(direction.x, direction.y);
}

/** 按角色窗口中心点查找所属显示器；未命中时返回最近的工作区。 */
export function findWorkArea(position, workAreas = [], windowSize = { width: 0, height: 0 }) {
  const centerX = position.x + windowSize.width / 2;
  const centerY = position.y + windowSize.height / 2;
  const containing = workAreas.find((area) =>
    centerX >= area.x && centerX <= area.x + area.width &&
    centerY >= area.y && centerY <= area.y + area.height,
  );
  if (containing) return containing;

  let nearest = null;
  let nearestDistance = Infinity;
  for (const area of workAreas) {
    const dx = Math.max(area.x - centerX, 0, centerX - area.x - area.width);
    const dy = Math.max(area.y - centerY, 0, centerY - area.y - area.height);
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearest = area;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** 判断窗口是否处于显示器底部的可行走区域。 */
export function isInGroundBand(position, workArea, windowSize, config = DEFAULT_CONFIG) {
  if (!workArea) return false;
  const minY = workArea.y + config.margin;
  const maxY = Math.max(
    minY,
    workArea.y + workArea.height - windowSize.height - config.margin,
  );
  const groundLine = minY + (maxY - minY) * (1 - config.groundBandRatio);
  return position.y >= groundLine;
}

/** 根据起点、目标、真实速度和运动策略选择 walking、jumping 等表现状态。 */
export function chooseLocomotionMode({
  requestedMode = "auto",
  startPosition,
  targetPosition,
  position,
  speed = 0,
  elapsed = 0,
  workAreas = [],
  windowSize = { width: 0, height: 0 },
  config: overrides = {},
}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (!startPosition || !targetPosition || !position) return "idle";

  const startArea = findWorkArea(startPosition, workAreas, windowSize);
  const targetArea = findWorkArea(targetPosition, workAreas, windowSize);
  const startGrounded = isInGroundBand(startPosition, startArea, windowSize, config);
  const targetGrounded = isInGroundBand(targetPosition, targetArea, windowSize, config);
  const verticalDistance = Math.abs(targetPosition.y - startPosition.y);
  const bothInGroundBand = startGrounded && targetGrounded;
  const groundWalk = requestedMode === "ground" || (
    requestedMode === "auto" && bothInGroundBand &&
    verticalDistance <= config.groundVerticalTolerance
  );

  if (groundWalk) {
    if (speed < config.directionLockSpeed) return "turning";
    return speed >= config.runSpeed ? "running" : "walking";
  }

  const remaining = distanceBetween(position, targetPosition);
  if (targetGrounded && !startGrounded && remaining <= config.landingDistance) {
    return "landing";
  }
  if (startGrounded && elapsed < config.jumpDuration) return "jumping";
  return "floating";
}

function clonePoint(point) {
  return point ? { x: point.x, y: point.y } : null;
}

/** 汇总窗口遥测，并维护去抖后的运动、方向和动画状态。 */
export class LocomotionController {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalMode = "auto";
    this.activeMovement = null;
    this.lastSample = null;
    this.landingElapsed = 0;
    this.lockedDirection = { x: 0, y: 1 };
    this.directionLocked = false;
    this.state = {
      position: null,
      velocity: { x: 0, y: 0 },
      speed: 0,
      direction: { x: 0, y: 1 },
      directionLocked: false,
      targetPosition: null,
      mode: "idle",
      isMoving: false,
      isGrounded: true,
      progress: 0,
      requestId: null,
      isHorizontalMovement: false,
      requestedMode: "auto",
      faceTarget: true,
      airHeight: 0,
      yawDegrees: 0,
      animation: "idle",
      workAreas: [],
      windowSize: { width: 0, height: 0 },
      terminalStatus: "idle",
    };
  }

  /** 设置后续移动默认采用的策略，并立即更新当前任务策略。 */
  setMovementMode(mode) {
    if (!VALID_MODES.has(mode)) throw new Error(`未知运动模式：${mode}`);
    this.globalMode = mode;
    if (this.activeMovement) this.activeMovement.requestedMode = mode;
    this.state.requestedMode = mode;
    this.#updateMode();
    return mode;
  }

  getMovementMode() {
    return this.globalMode;
  }

  /** 处理 Electron 主进程发来的真实位置、速度采样和任务终态。 */
  updateTelemetry(sample) {
    if (!sample || !sample.position) return this.getState();

    const position = clonePoint(sample.position);
    const timestamp = Number.isFinite(sample.timestamp)
      ? sample.timestamp
      : (this.lastSample?.timestamp ?? 0) + 33;
    const isStart = sample.status === "moving" &&
      (!this.activeMovement || this.activeMovement.requestId !== sample.requestId);

    if (isStart) {
      const startPosition = clonePoint(sample.startPosition ?? this.state.position ?? position);
      const targetPosition = clonePoint(sample.targetPosition ?? position);
      const deltaX = targetPosition.x - startPosition.x;
      const deltaY = targetPosition.y - startPosition.y;
      const requestedMode = VALID_MODES.has(sample.requestedMode)
        ? sample.requestedMode
        : this.globalMode;
      this.activeMovement = {
        requestId: sample.requestId,
        startPosition,
        targetPosition,
        requestedMode,
        elapsed: 0,
      };
      this.state.requestId = sample.requestId;
      this.state.isHorizontalMovement =
        Math.abs(deltaX) >= this.config.horizontalWalkMinimumDistance &&
        Math.abs(deltaY) <= this.config.horizontalWalkVerticalTolerance &&
        Math.abs(deltaX) >= Math.abs(deltaY) * this.config.horizontalWalkRatio;
      this.state.targetPosition = targetPosition;
      this.state.requestedMode = requestedMode;
      this.state.terminalStatus = "moving";
    }

    const previous = this.lastSample;
    if (previous && timestamp > previous.timestamp) {
      const deltaSeconds = Math.max((timestamp - previous.timestamp) / 1000, 1 / 240);
      const instantX = (position.x - previous.position.x) / deltaSeconds;
      const instantY = (position.y - previous.position.y) / deltaSeconds;
      const alpha = 1 - Math.exp(-this.config.velocitySmoothing * deltaSeconds);
      this.state.velocity.x += (instantX - this.state.velocity.x) * alpha;
      this.state.velocity.y += (instantY - this.state.velocity.y) * alpha;
    }

    this.state.position = position;
    this.state.workAreas = sample.workAreas ?? this.state.workAreas;
    this.state.windowSize = sample.windowSize ?? this.state.windowSize;
    this.state.faceTarget = sample.faceTarget ?? this.state.faceTarget;
    this.state.isMoving = sample.status === "moving";
    this.state.speed = Math.hypot(this.state.velocity.x, this.state.velocity.y);

    if (this.state.speed >= this.config.directionLockSpeed) {
      this.directionLocked = true;
    } else if (this.state.speed <= this.config.directionReleaseSpeed) {
      this.directionLocked = false;
    }
    if (this.directionLocked && this.state.speed > 1e-3) {
      this.lockedDirection = {
        x: this.state.velocity.x / this.state.speed,
        y: this.state.velocity.y / this.state.speed,
      };
    }
    this.state.direction = { ...this.lockedDirection };
    this.state.directionLocked = this.directionLocked;

    if (this.activeMovement) this.#updateProgress();

    if (["arrived", "cancelled", "error"].includes(sample.status)) {
      this.state.isMoving = false;
      this.state.isHorizontalMovement = false;
      this.state.terminalStatus = sample.status;
      const previousMode = this.state.mode;
      const finalTarget = clonePoint(sample.targetPosition ?? this.state.targetPosition);
      if (finalTarget) this.state.targetPosition = finalTarget;
      const wasAirborne = ["jumping", "floating", "landing"].includes(previousMode);
      // 移动结束（到达或取消）后不再永久保持悬空姿态，统一经短暂着陆过渡恢复默认待机站姿。
      if (wasAirborne || sample.requestedMode === "air") {
        this.state.mode = "landing";
        this.state.isGrounded = false;
        this.landingElapsed = 0;
      } else {
        this.state.mode = "idle";
        this.state.isGrounded = true;
        this.state.airHeight = 0;
      }
      this.activeMovement = null;
    }

    this.lastSample = { position, timestamp };
    this.#updateMode();
    return this.getState();
  }

  /** 在渲染帧中推进平滑减速、跳跃和落地过渡。 */
  advance(dt) {
    if (this.activeMovement) {
      this.activeMovement.elapsed += dt;
      this.#updateProgress();
      this.#updateMode();
    } else {
      const decay = 1 - Math.exp(-10 * dt);
      this.state.velocity.x += (0 - this.state.velocity.x) * decay;
      this.state.velocity.y += (0 - this.state.velocity.y) * decay;
      this.state.speed = Math.hypot(this.state.velocity.x, this.state.velocity.y);
      if (this.state.mode === "landing") {
        this.landingElapsed += dt;
        const p = clamp(this.landingElapsed / this.config.landingDuration, 0, 1);
        this.state.airHeight = 1 - p;
        if (p >= 1) {
          this.state.mode = "idle";
          this.state.isGrounded = true;
          this.state.airHeight = 0;
        }
      }
    }
    this.state.animation = this.#animationName();
    return this.getState();
  }

  setYawDegrees(yawDegrees) {
    this.state.yawDegrees = yawDegrees;
  }

  /** 返回新的状态副本，避免外部调用者修改控制器内部对象。 */
  getState() {
    return {
      ...this.state,
      position: clonePoint(this.state.position),
      velocity: { ...this.state.velocity },
      direction: { ...this.state.direction },
      targetPosition: clonePoint(this.state.targetPosition),
      workAreas: this.state.workAreas.map((area) => ({ ...area })),
      windowSize: { ...this.state.windowSize },
    };
  }

  #updateProgress() {
    if (!this.activeMovement || !this.state.position) return;
    const { startPosition, targetPosition } = this.activeMovement;
    const dx = targetPosition.x - startPosition.x;
    const dy = targetPosition.y - startPosition.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1) {
      this.state.progress = 1;
      return;
    }
    const px = this.state.position.x - startPosition.x;
    const py = this.state.position.y - startPosition.y;
    this.state.progress = clamp((px * dx + py * dy) / lengthSq, 0, 1);
  }

  #updateMode() {
    if (!this.activeMovement) {
      if (this.state.mode === "floating" || this.state.mode === "jumping") {
        this.state.mode = "landing";
        this.state.isGrounded = false;
        this.landingElapsed = 0;
      }
      this.state.animation = this.#animationName();
      return;
    }

    const movement = this.activeMovement;
    const workAreas = this.state.workAreas;
    const windowSize = this.state.windowSize;
    this.state.mode = chooseLocomotionMode({
      requestedMode: movement.requestedMode,
      startPosition: movement.startPosition,
      targetPosition: movement.targetPosition,
      position: this.state.position ?? movement.startPosition,
      speed: this.state.speed,
      elapsed: movement.elapsed,
      workAreas,
      windowSize,
      config: this.config,
    });
    this.state.isGrounded = GROUNDED_STATES.has(this.state.mode);
    if (this.state.mode === "jumping") {
      const p = clamp(movement.elapsed / this.config.jumpDuration, 0, 1);
      this.state.airHeight = p * p * (3 - 2 * p);
    } else if (this.state.mode === "floating") {
      this.state.airHeight = 1;
    } else if (this.state.mode === "landing") {
      this.state.airHeight = clamp(
        distanceBetween(this.state.position ?? movement.targetPosition, movement.targetPosition) /
          this.config.landingDistance,
        0,
        1,
      );
    } else {
      this.state.airHeight = 0;
    }
    this.state.animation = this.#animationName();
  }

  #animationName() {
    if (this.state.mode === "floating" && this.state.isMoving && this.state.isHorizontalMovement) {
      return this.state.speed >= this.config.runSpeed
        ? "procedural_float_run"
        : "procedural_float_walk";
    }
    return {
      idle: "idle",
      turning: "turn",
      walking: "procedural_walk",
      running: "procedural_run",
      jumping: "vrma_jump+procedural_air",
      floating: "procedural_float",
      landing: "procedural_landing",
    }[this.state.mode] ?? "idle";
  }
}
