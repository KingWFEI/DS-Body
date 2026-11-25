/** 动作资源按调试面板分组维护，API 和界面共用这份清单。 */
export const MOTION_GROUPS = Object.freeze({
  idle: [
    "idle",
    "idle2",
    "idle3",
    "idle4",
    "hungry1",
    "hungry2",
    "idle lookaround1",
    "idle lookaround2",
    "idle stretch1",
    "idle stretch2",
    "idle stretch3",
    "idle stretch4",
    "touch hair1",
    "touch hair2",
  ],
  attention: ["wave hand 1", "wave hand 2", "wave hand 3"],
  success: ["jump 1", "jump 2", "jump 3"],
  fail: ["fall down1", "fall down2"],
  offline: ["sleeping"],
  dance: ["dance1", "dance2"],
  working: ["dance1"],
});

export const DEFAULT_MOTION = "idle/idle.vrma";

/** 提供给界面下拉框和外部 API 查询的标准动作目录。 */
export const MOTION_OPTIONS = Object.freeze(
  Object.entries(MOTION_GROUPS).flatMap(([group, names]) =>
    names.map((name) => ({
      name: `${group}/${name}.vrma`,
      label: `${group} / ${name}`,
      group,
    })),
  ),
);

/** 允许外部传入短名称或完整资源路径，并确保它属于当前动作目录。 */
export function normalizeMotionPath(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("动作名称必须是非空字符串");
  }

  const path = name === "idle"
    ? DEFAULT_MOTION
    : name.endsWith(".vrma") ? name : `${name}.vrma`;
  if (!MOTION_OPTIONS.some((motion) => motion.name === path)) {
    throw new Error(`未知 VRMA 动作：${name}`);
  }
  return path;
}

/** 判断需要播放一次后返回待机的 VRMA 动作。 */
export function isOneShotMotion(name) {
  return /^idle\/(hungry|idle lookaround|idle stretch|touch hair)/.test(name) ||
    /^success\/jump/.test(name) ||
    /^fail\//.test(name) ||
    /^dance\//.test(name);
}
