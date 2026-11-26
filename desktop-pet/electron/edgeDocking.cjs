/**
 * 屏幕左右边缘过半折叠（Edge Docking）几何计算模块。
 *
 * 判定规则：
 * - 当桌宠窗口中心点 X 越过所属显示器的左边界（`x + width / 2 <= display.bounds.x`）或右边界
 *   （`x + width / 2 >= display.bounds.x + display.bounds.width`），且未落入相邻扩展显示器内部时，
 *   即表示桌宠窗口已有至少一半（>= 50%）超出屏幕左右外边缘，触发侧边折叠。
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function findNearestDisplay(point, displays) {
  let nearest = displays[0] ?? null;
  let minDistance = Infinity;
  for (const display of displays) {
    const b = display.bounds;
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height));
    const dist = Math.hypot(dx, dy);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = display;
    }
  }
  return nearest;
}

/**
 * 检测桌宠窗口是否已有至少一半超出屏幕最左侧或最右侧边缘。
 * 多屏拼接场景下，穿过两块相邻屏幕中间接缝不会误判为贴边折叠。
 * @param {{x:number,y:number,width:number,height:number}} windowBounds
 * @param {Array<{id?:number,bounds:{x:number,y:number,width:number,height:number},workArea:{x:number,y:number,width:number,height:number}}>} displays
 * @returns {{side:"left"|"right",display:object}|null}
 */
function detectEdgeDockSide(windowBounds, displays) {
  if (!windowBounds || !Array.isArray(displays) || displays.length === 0) {
    return null;
  }

  const centerX = windowBounds.x + windowBounds.width / 2;
  const centerY = windowBounds.y + windowBounds.height / 2;

  // 若窗口中心点仍位于任意一块显示器的水平可视范围内（严格在边界内），说明未超出屏幕外边缘一半
  const insideAnyDisplayHorizontally = displays.some((display) => {
    const b = display.bounds;
    const verticalOverlap =
      windowBounds.y + windowBounds.height > b.y && windowBounds.y < b.y + b.height;
    return verticalOverlap && centerX > b.x && centerX < b.x + b.width;
  });
  if (insideAnyDisplayHorizontally) {
    return null;
  }

  const targetDisplay = findNearestDisplay({ x: centerX, y: centerY }, displays);
  if (!targetDisplay) return null;

  const { bounds } = targetDisplay;
  const overlapsVertically = (other) =>
    windowBounds.y + windowBounds.height > other.bounds.y &&
    windowBounds.y < other.bounds.y + other.bounds.height;

  if (centerX <= bounds.x) {
    // 若该左边缘紧邻另一块左置扩展屏，则属于双屏接缝而非桌面外边缘，不触发折叠
    const hasLeftNeighbor = displays.some(
      (d) =>
        d !== targetDisplay &&
        overlapsVertically(d) &&
        d.bounds.x < bounds.x &&
        d.bounds.x + d.bounds.width >= bounds.x - 2,
    );
    return hasLeftNeighbor ? null : { side: "left", display: targetDisplay };
  }

  if (centerX >= bounds.x + bounds.width) {
    const rightEdge = bounds.x + bounds.width;
    const hasRightNeighbor = displays.some(
      (d) =>
        d !== targetDisplay &&
        overlapsVertically(d) &&
        d.bounds.x + d.bounds.width > rightEdge &&
        d.bounds.x <= rightEdge + 2,
    );
    return hasRightNeighbor ? null : { side: "right", display: targetDisplay };
  }

  return null;
}

/**
 * 计算折叠后贴靠在屏幕左/右边缘的悬浮小按钮窗口坐标。
 */
function computeDockButtonBounds({ side, display, petBounds, dockSize }) {
  const area = display.workArea ?? display.bounds;
  const x = side === "left" ? area.x : area.x + area.width - dockSize.width;
  const petVisualCenterY = petBounds.y + petBounds.height * 0.48;
  const minY = area.y + 12;
  const maxY = Math.max(minY, area.y + area.height - dockSize.height - 12);
  const y = Math.round(clamp(petVisualCenterY - dockSize.height / 2, minY, maxY));

  return {
    x: Math.round(x),
    y,
    width: dockSize.width,
    height: dockSize.height,
  };
}

/**
 * 计算点击侧边悬浮按钮后，桌宠恢复回屏幕内侧的目标坐标（保持同一垂直高度并留出安全边距）。
 */
function computeRestoredPetPosition({ side, display, petSize, dockBounds, margin = 16 }) {
  const area = display.workArea ?? display.bounds;
  const minX = area.x + margin;
  const maxX = Math.max(minX, area.x + area.width - petSize.width - margin);
  const x = side === "left" ? minX : maxX;

  const anchorCenterY = dockBounds
    ? dockBounds.y + dockBounds.height / 2
    : area.y + area.height / 2;
  const minY = area.y + margin;
  const maxY = Math.max(minY, area.y + area.height - petSize.height - margin);
  const y = Math.round(clamp(anchorCenterY - petSize.height * 0.48, minY, maxY));

  return {
    x: Math.round(x),
    y,
  };
}

module.exports = {
  detectEdgeDockSide,
  computeDockButtonBounds,
  computeRestoredPetPosition,
};
