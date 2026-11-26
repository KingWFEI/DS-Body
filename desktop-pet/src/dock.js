/**
 * 屏幕左右边缘折叠悬浮小按钮交互逻辑。
 * 根据贴靠方向切换扒边探头朝向，点击后立即通知 Electron 主进程恢复 3D 桌宠窗口。
 */

const stageEl = document.querySelector("#dockStage");
const restoreBtn = document.querySelector("#restoreBtn");

function applyDockSide(side) {
  const isLeft = side === "left";
  stageEl.className = `dock-stage side-${isLeft ? "left" : "right"}`;
}

restoreBtn.addEventListener("click", () => {
  void globalThis.__dockWindowBridge?.restorePet?.();
});

globalThis.__dockWindowBridge?.onDockSideChanged?.(applyDockSide);
