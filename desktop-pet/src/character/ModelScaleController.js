/** 管理模型显示比例，并通知桌面主进程同步调整透明窗口尺寸。 */
export class ModelScaleController {
  constructor({ onScaleChange = () => {}, initialScale = 1, minScale = 0.5, maxScale = 1.4 } = {}) {
    this.onScaleChange = onScaleChange;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.scale = initialScale;
    this.listeners = new Set();
  }

  /** 设置桌宠窗口及模型显示比例；有效范围为 0.5 到 1.4。 */
  setScale(scale) {
    if (!Number.isFinite(scale)) throw new TypeError("模型比例必须是有限数字");
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    const nextScale = Math.round(clamped * 100) / 100;
    if (nextScale === this.scale) return this.scale;

    this.scale = nextScale;
    this.onScaleChange(this.scale);
    for (const listener of this.listeners) {
      try {
        listener(this.scale);
      } catch (error) {
        this.listeners.delete(listener);
        console.error("模型比例订阅回调失败：", error);
      }
    }
    return this.scale;
  }

  /** 获取当前模型比例。 */
  getScale() {
    return this.scale;
  }

  /** 订阅模型比例变化；注册后立即收到当前比例。 */
  onChange(callback) {
    if (typeof callback !== "function") throw new TypeError("比例订阅参数必须是函数");
    this.listeners.add(callback);
    callback(this.scale);
    return () => this.listeners.delete(callback);
  }

}
