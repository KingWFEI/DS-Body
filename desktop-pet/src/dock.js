/**
 * 屏幕左右边缘折叠悬浮小按钮交互逻辑。
 * 点击按钮后立即通知 Electron 主进程恢复 3D 桌宠窗口。
 */

const stageEl = document.querySelector("#dockStage");
const arrowEl = document.querySelector("#dockArrow");
const restoreBtn = document.querySelector("#restoreBtn");

function applyDockSide(side) {
  const isLeft = side === "left";
  stageEl.className = `dock-stage side-${isLeft ? "left" : "right"}`;
  arrowEl.textContent = isLeft ? "›" : "‹";
}

restoreBtn.addEventListener("click", () => {
  void globalThis.__dockWindowBridge?.restorePet?.();
});

globalThis.__dockWindowBridge?.onDockSideChanged?.(applyDockSide);
