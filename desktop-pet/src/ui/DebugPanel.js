import { createWindowInteraction } from "./WindowInteraction.js";
import { DEFAULT_MOTION } from "../animation/motionCatalog.js";

/** 创建动作调试面板，并将所有操作路由到统一的 window.character 接口。 */
export function createDebugPanel({ motionOptions }) {
  const app = document.querySelector("#app");
  if (!app) throw new Error("页面缺少 #app 容器");

  app.innerHTML = `
    <div id="viewport"></div>
    <aside id="panel" data-mouse-interactive hidden>
      <div id="dragBar">🐳 小鲸娘 · 动作调试台（拖动此栏移动窗口）</div>
      <label for="motion">VRMA 动作</label>
      <select id="motion"></select>
      <div class="actions">
        <button id="play">播放动作</button>
        <button id="happy">开心表情</button>
        <button id="rotate">旋转 180°</button>
        <button id="camera">重置镜头</button>
      </div>
      <div class="scale-controls" aria-label="模型大小比例">
        <span>模型比例</span>
        <button id="scaleDown" type="button" aria-label="缩小模型">−</button>
        <output id="scaleValue">100%</output>
        <button id="scaleUp" type="button" aria-label="放大模型">+</button>
        <button id="scaleReset" type="button">重置</button>
      </div>
      <div class="move-actions">
        <button data-move="up-left" aria-label="左上">↖</button>
        <button data-move="up" aria-label="上">↑</button>
        <button data-move="up-right" aria-label="右上">↗</button>
        <button data-move="left" aria-label="左">←</button>
        <button data-move="center" aria-label="水平居中">中</button>
        <button data-move="right" aria-label="右">→</button>
        <button data-move="down-left" aria-label="左下">↙</button>
        <button data-move="down" aria-label="下">↓</button>
        <button data-move="down-right" aria-label="右下">↘</button>
      </div>
      <div class="move-actions move-utilities">
        <button data-move="home">返回原位</button>
        <button id="stopMove">停止</button>
      </div>
      <div id="status">正在准备场景…</div>
      <pre id="movementDebug"></pre>
    </aside>
    <nav id="controlRail" data-mouse-interactive aria-label="桌宠快捷操作">
      <button id="toggleDebug" class="rail-button" type="button" aria-label="打开调试窗口" aria-expanded="false" title="调试窗口">⚙</button>
      <button id="openChat" class="rail-button" type="button" aria-label="打开对话窗口" title="对话">💬</button>
    </nav>
  `;

  const viewport = app.querySelector("#viewport");
  const statusElement = app.querySelector("#status");
  const movementDebug = app.querySelector("#movementDebug");
  const motionSelect = app.querySelector("#motion");

  for (const motion of motionOptions) {
    let group = motionSelect.querySelector(`optgroup[label="${motion.group}"]`);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = motion.group;
      motionSelect.appendChild(group);
    }
    const option = document.createElement("option");
    option.value = motion.name;
    option.textContent = motion.label;
    group.appendChild(option);
  }
  motionSelect.value = DEFAULT_MOTION;

  function setStatus(message) {
    statusElement.textContent = message;
    console.log("[DesktopPet]", message);
  }

  function setActiveMotion(name) {
    if (typeof name === "string" && motionSelect.value !== name) {
      motionSelect.value = name;
    }
  }

  let lastDebugUpdate = 0;
  function updateMovement(state) {
    if (app.querySelector("#panel").hidden) return;
    const now = performance.now();
    if (now - lastDebugUpdate < 100) return;
    lastDebugUpdate = now;
    const pointText = (point) => point
      ? `(${Math.round(point.x)}, ${Math.round(point.y)})`
      : "—";
    const directionLabel = state.speed < 24
      ? "—"
      : getDirectionLabel(state.direction);
    movementDebug.textContent = [
      `Movement Mode: ${state.mode}`,
      `Position: ${pointText(state.position)}`,
      `Target: ${pointText(state.targetPosition)}`,
      `Speed: ${Math.round(state.speed)} px/s`,
      `Direction: ${directionLabel}`,
      `Yaw: ${Math.round(state.yawDegrees)}°`,
      `Animation: ${state.animation}`,
    ].join("\n");
  }

  const interaction = createWindowInteraction({ app, viewport });

  function bindCharacterApi(character) {
    const debugButton = app.querySelector("#toggleDebug");
    const panel = app.querySelector("#panel");
    panel.setAttribute("data-mouse-interactive", "");
    debugButton.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      interaction.refresh();
      debugButton.setAttribute("aria-expanded", String(!panel.hidden));
      debugButton.setAttribute("aria-label", panel.hidden ? "打开调试窗口" : "关闭调试窗口");
    });

    app.querySelector("#openChat").addEventListener("click", () => {
      void character.openChatWindow().catch((error) => setStatus(`打开对话窗口失败：${error.message}`));
    });

    const scaleValue = app.querySelector("#scaleValue");
    const updateScale = (scale) => { scaleValue.value = `${Math.round(scale * 100)}%`; };
    app.querySelector("#scaleDown").addEventListener("click", () => {
      character.setModelScale(character.getModelScale() - 0.1);
    });
    app.querySelector("#scaleUp").addEventListener("click", () => {
      character.setModelScale(character.getModelScale() + 0.1);
    });
    app.querySelector("#scaleReset").addEventListener("click", () => {
      character.setModelScale(1);
    });

    for (const button of app.querySelectorAll("[data-move]")) {
      button.addEventListener("click", async () => {
        try {
          const result = await character.moveToPreset(button.dataset.move);
          if (result.status === "cancelled") setStatus("移动已取消");
        } catch (error) {
          setStatus(`移动失败：${error.message}`);
        }
      });
    }

    app.querySelector("#stopMove").addEventListener("click", () => {
      void character.stopMovement().catch((error) => setStatus(`停止移动失败：${error.message}`));
    });
    app.querySelector("#play").addEventListener("click", () => {
      void character.playMotion(motionSelect.value).catch((error) => setStatus(`动作失败：${error.message}`));
    });
    motionSelect.addEventListener("change", () => {
      void character.playMotion(motionSelect.value).catch((error) => setStatus(`动作失败：${error.message}`));
    });
    app.querySelector("#rotate").addEventListener("click", () => {
      character.rotateFacing180();
    });
    app.querySelector("#camera").addEventListener("click", () => {
      character.resetCamera();
    });
    app.querySelector("#happy").addEventListener("click", () => {
      character.toggleExpression("happy");
    });

    const unsubscribeMovement = character.onMovementChanged(updateMovement);
    const unsubscribeMotion = character.onMotionChanged(setActiveMotion);
    const unsubscribeScale = character.onModelScaleChanged(updateScale);
    return () => {
      unsubscribeMovement();
      unsubscribeMotion();
      unsubscribeScale();
      interaction.dispose();
    };
  }

  return Object.freeze({
    viewport,
    setModelRegion: interaction.setModelRegion,
    setStatus,
    updateMovement,
    setActiveMotion,
    bindCharacterApi,
  });
}

function getDirectionLabel(direction) {
  const horizontal = Math.abs(direction.x) > 0.35
    ? (direction.x > 0 ? "right" : "left")
    : "";
  const vertical = Math.abs(direction.y) > 0.35
    ? (direction.y > 0 ? "down" : "up")
    : "";
  if (horizontal && vertical) return `${vertical}-${horizontal}`;
  return horizontal || vertical || "—";
}
