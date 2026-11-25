# desktop-pet

Windows 桌面 3D 桌宠，基于 Electron、Vite、Three.js、VRM 与 VRMA。

## 启动

终端一启动 Vite：

```bash
npm run dev
```

终端二启动 Electron：

```bash
npm run electron
```

## 代码结构

```text
src/
├─ main.js                         应用入口，只创建并启动应用
├─ app/createDesktopPetApp.js      模型生命周期、渲染循环和模块组装
├─ api/CharacterApi.js             对外控制接口，挂载为 window.character
├─ animation/
│  ├─ MotionController.js          VRMA 动作与 VRM 表情
│  └─ motionCatalog.js              动作目录和动作路径校验
├─ character/
│  ├─ LocomotionController.js       运动状态、速度和运动模式
│  ├─ CharacterOrientationController.js 角色朝向校准与平滑转向
│  ├─ ModelScaleController.js    模型显示比例控制
│  └─ WalkController.js             程序化步态和骨骼偏移恢复
├─ scene/CharacterScene.js         Three.js 场景、相机和渲染器
└─ ui/
   ├─ DebugPanel.js                调试面板与界面事件绑定
   └─ WindowInteraction.js         模型原生拖动区域和控件区域上报
```

`window.character` 是业务控制入口；`electron/preload.cjs` 暴露的内部桥负责安全转发窗口移动、缩放、鼠标穿透和对话窗口 IPC。

桌宠窗口右下方提供竖排快捷按钮：调试窗口默认关闭，可按齿轮按钮打开；对话按钮会在模型旁边打开独立的对话预览窗口，不遮住 3D 模型。对话输入暂未连接后端。透明空白区域的鼠标事件会穿透到桌面；模型本体可按住拖动桌宠，调试面板和快捷按钮仍可交互。缩放模型会同步调整透明桌宠窗口尺寸，快捷按钮按窗口比例锚定在模型右下侧。

窗口拖动使用 Electron 原生 `app-region: drag`。模型区域采用加载时计算的包围矩形，矩形内的小块透明空隙也属于拖动区域；区域外开启穿透。主进程 `electron/WindowInteraction.cjs` 每 16ms 检查鼠标所在区域，只在进入/离开区域时切换穿透，不通过鼠标事件逐次移动窗口，也不再检测模型三角面。控件区域在布局改变时更新，缩放后自动保持一致。

## 外部控制接口

所有角色动作和行为都统一挂载在 `window.character` 上。可从 Electron 渲染页面的 DevTools 或宿主脚本调用；运动坐标使用 Windows 逻辑像素（DIP）。

```js
// 移动 Promise 在到达、取消或失败后结束，不会在仅接受命令时报告到达。
const result = await window.character.moveToScreen(850, 320, {
  mode: "auto", // auto | ground | air
  speed: "normal", // auto | slow | normal | fast，或指定 px/s 数字
  faceTarget: true,
});

await window.character.moveToPreset("up-right");
window.character.setMovementMode("auto");
window.character.stopMovement();
await window.character.openChatWindow(); // 在模型旁打开对话窗口
window.character.setModelScale(1.2); // 比例范围 0.5 到 1.4，1 为原始大小
window.character.getModelScale();

await window.character.playMotion("attention/wave hand 1");
window.character.setExpression("happy", 1); // 表情强度范围 0 到 1
window.character.toggleExpression("happy");

window.character.rotateFacing180();
window.character.resetCamera();

console.log(window.character.getMovementState());
console.log(window.character.getState());
console.log(window.character.getAvailableMotions());
console.log(window.character.getAvailableExpressions());

const unsubscribe = window.character.onMovementChanged((state) => {
  console.log("运动状态变化", state.mode, state.position, state.speed);
});
unsubscribe(); // 不再监听时取消订阅

const unsubscribeMotion = window.character.onMotionChanged((motion) => {
  console.log("当前动作", motion);
});
unsubscribeMotion();
```

| 方法 | 用途 | 返回值 |
| --- | --- | --- |
| `moveToScreen(x, y, options)` | 移动到屏幕逻辑坐标 | Promise，最终状态为 `arrived`、`cancelled` 或 `error`；不可用或参数错误时 reject |
| `moveToPreset(name, options)` | 移动到 `left`、`right`、`up`、`down`、四个对角线、`center`、`home` | 与 `moveToScreen` 相同 |
| `stopMovement()` | 取消当前移动 | Promise，返回停止结果 |
| `setModelScale(scale)` / `getModelScale()` | 设置或读取模型显示比例 | 比例范围 0.5 到 1.4，1 为原始大小 |
| `onModelScaleChanged(callback)` | 订阅模型比例变化 | 取消订阅函数 |
| `setMovementMode(mode)` | 设置 `auto`、`ground` 或 `air` 策略 | 当前策略名；非法值会抛错 |
| `playMotion(name)` | 播放 VRMA 动作 | Promise，成功返回 `playing`；新动作覆盖旧加载时返回 `superseded` |
| `setExpression(name, value)` | 设置表情权重 | 支持时返回 `true`，不支持时返回 `false` |
| `toggleExpression(name)` | 在 0 和 1 之间切换表情 | 返回 `{ success, name, value }` |
| `getExpression(name)` | 读取表情当前权重 | 权重或 `null` |
| `getAvailableExpressions()` | 列出模型支持的表情 | 表情名称数组 |
| `rotateFacing180()` | 平滑旋转角色朝向 180° | 目标角度；模型尚未加载时返回 `null` |
| `getCameraState()` / `resetCamera()` | 读取相机状态或恢复固定视角 | 相机状态对象 |
| `getMovementState()` | 读取运动状态快照 | `LocomotionState` 对象 |
| `onMovementChanged(callback)` | 订阅状态变化 | 取消订阅函数；注册时立即收到一次当前状态 |
| `onMotionChanged(callback)` | 订阅当前 VRMA 动作变化 | 取消订阅函数；注册时立即收到一次当前动作 |
| `getState()` | 读取模型、比例、动作、表情、相机和运动状态 | 完整状态对象 |
| `getAvailableMotions()` | 列出动作资源 | 动作路径、分组与标签数组 |

### 状态订阅示例

```js
const unsubscribe = window.character.onMovementChanged((state) => {
  if (state.terminalStatus === "arrived") console.log("移动完成");
  console.log(state.animation, state.yawDegrees, state.position);
});

// 页面或任务结束时释放监听器。
unsubscribe();
```

## 检查

```bash
npm test
npm run lint
npm run build
```
