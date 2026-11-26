const { screen } = require('electron');

/** 只检测矩形区域，不查询 3D 网格；窗口拖动完全交给 Windows。 */
function createWindowInteraction(window) {
  let regions = [];
  let ignored = true;
  let dragging = false;
  let moving = false;
  window.setIgnoreMouseEvents(true);

  function refresh() {
    // 窗口拖拽或程序化平滑移动期间暂停穿透切换，避免途经鼠标指针时触发 DWM 分层表面重建造成卡顿。
    if (window.isDestroyed() || dragging || moving) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getContentBounds();
    const x = (cursor.x - bounds.x) / bounds.width;
    const y = (cursor.y - bounds.y) / bounds.height;
    const nextIgnored = !regions.some((region) =>
      x >= region.left && x <= region.right && y >= region.top && y <= region.bottom);
    if (nextIgnored === ignored) return;
    ignored = nextIgnored;
    window.setIgnoreMouseEvents(ignored);
  }

  // 原生拖动区域不发送 DOM 鼠标事件，因此在主进程直接检查区域。
  // 这里仅切换输入状态，不调用 setPosition，不参与拖动跟随。
  const timer = setInterval(refresh, 16);
  window.on('will-move', () => { dragging = true; });
  window.on('moved', () => { dragging = false; refresh(); });

  return {
    setRegions(nextRegions) {
      if (!Array.isArray(nextRegions) || nextRegions.length > 20) return;
      regions = nextRegions.filter((region) => region &&
        ['left', 'right', 'top', 'bottom'].every((key) => Number.isFinite(region[key])));
      refresh();
    },
    setMoving(nextMoving) {
      const flag = Boolean(nextMoving);
      if (moving === flag) return;
      moving = flag;
      if (!moving) refresh();
    },
    dispose() { clearInterval(timer); },
  };
}

module.exports = { createWindowInteraction };
