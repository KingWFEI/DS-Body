# 桌面运动与角色动画

## 调试

启动 Vite：`npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`；另一个终端运行 `npm run electron`。调试面板支持八方向移动、横向居中、返回原位和停止，并显示当前位置、目标、速度、方向、偏航和动画状态。

## 模块职责

- `electron/main.cjs` 单独管理一个窗口移动任务，使用 `BrowserWindow.setPosition()` 并采样窗口实际逻辑坐标。
- `electron/preload.cjs` 通过 `contextBridge` 暴露受限移动方法及状态事件。
- `src/LocomotionController.js` 根据坐标和时间估算速度、做方向滞回，并选择地面/空中运动状态。
- `src/CharacterOrientationController.js` 校准模型朝向，把屏幕方向映射为偏航：向下正面、向上背面、左右侧面、斜向 3/4 视角；停止后保持最后朝向。
- `CharacterRoot → CharacterVisualRoot → VRM Scene` 分离整体朝向、跳浮起伏与模型骨骼动画。
- `src/WalkController.js` 在 VRMA 混合完成后叠加速度驱动的腿部步态和空中姿态，并在每帧先撤销自身上一帧偏移。

## 运动策略

`auto` 模式将工作区底部约 20% 作为地面活动带：短距离水平移动走路，速度较高时跑步；移动到上方时先起跳再漂浮，返回底部时进入着陆。OrthographicCamera 保持角色画面尺寸稳定，相机不会跟随窗口移动；空中运动不把角色横躺，也不强行模拟垂直地面。

桌面坐标使用 Electron 逻辑像素，按目标显示器工作区边界约束。窗口移动由真实位置采样驱动速度；设备像素比仅用于 WebGL 渲染，不乘进桌面坐标。

## 渲染进程 API

```js
await character.moveToScreen(850, 320, {
  mode: "auto", // auto | ground | air
  speed: "normal", // auto | slow | normal | fast
  faceTarget: true,
});
character.stopMovement();
character.setMovementMode("auto");
character.playMotion("idle");
character.setExpression("happy", 1);
character.getMovementState();
```

`moveToScreen()` 命令会在 IPC 接受后等待终态，返回 `arrived`、`cancelled` 或 `error`；被新命令取代的旧任务会以 `cancelled` 结束。高处悬停、着陆姿态及实际模型步态幅度仍需在本机 Electron 窗口中目视校准。

BlueFatFish 模型元数据要求署名且限制再分发，使用和发布时需遵守模型作者许可。
