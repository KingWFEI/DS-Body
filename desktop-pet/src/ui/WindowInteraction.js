/** 用原生拖动矩形覆盖模型区域，仅在布局变化时通知主进程更新穿透区域。 */
export function createWindowInteraction({ app, viewport }) {
  const dragRegion = document.createElement('div');
  dragRegion.id = 'modelDragRegion';
  dragRegion.hidden = true;
  viewport.after(dragRegion);
  let pendingFrame = null;

  function publishRegions() {
    pendingFrame = null;
    const regions = [dragRegion, ...app.querySelectorAll('[data-mouse-interactive]')]
      .filter((element) => !element.hidden && element.getClientRects().length)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left / window.innerWidth,
          right: rect.right / window.innerWidth,
          top: rect.top / window.innerHeight,
          bottom: rect.bottom / window.innerHeight,
        };
      });
    globalThis.__desktopPetBridge?.setInteractionRegions?.(regions);
  }

  function schedulePublish() {
    if (pendingFrame === null) pendingFrame = requestAnimationFrame(publishRegions);
  }

  const observer = new ResizeObserver(schedulePublish);
  observer.observe(app);
  for (const element of app.querySelectorAll('[data-mouse-interactive]')) observer.observe(element);

  return {
    /** 输入归一化坐标，窗口缩放后拖动区域会自动同比缩放。 */
    setModelRegion(region) {
      dragRegion.hidden = !region;
      if (region) {
        Object.assign(dragRegion.style, {
          left: `${region.left * 100}%`, top: `${region.top * 100}%`,
          width: `${(region.right - region.left) * 100}%`,
          height: `${(region.bottom - region.top) * 100}%`,
        });
      }
      schedulePublish();
    },
    refresh: schedulePublish,
    dispose() {
      observer.disconnect();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      dragRegion.remove();
    },
  };
}
