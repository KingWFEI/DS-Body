# 小鲸娘 Three.js + Electron 启动版

你当前已有的目录（保留不动）：
- public/models/BlueFatFish.vrm
- public/motions/<分类>/<文件名>.vrma

此压缩包**不含版权受限模型和动作资源**；只提供示例代码。

## 在现有 desktop-pet 项目中使用

1. 先备份你现有的 `index.html`、`src/main.js` 和 `src/style.css`。
2. 解压本包后将 `src/`、`electron/` 和 `index.html` 合并到现有项目的对应路径。**不要覆盖你的 package.json、vite.config.js、node_modules 或 public 资产。**
3. 在项目根目录运行：

```powershell
npm install three @pixiv/three-vrm @pixiv/three-vrm-animation
npm install -D electron
npm pkg set "scripts.electron=electron electron/main.cjs"
```

4. 终端 A 运行 `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`，浏览器先打开 `http://127.0.0.1:5173`。
5. 等小鲸娘可以加载并切换动作后，在终端 B 运行 `npm run electron`。可拖动调试面板标题栏移动桌面窗口。

## 注意

- 本包的 Electron 入口**仅用于开发阶段**，依赖本地 Vite 服务。独立打包需要额外处理静态资源的加载路径及安全协议。
- 透明窗口不等于自动鼠标穿透；桌面自动化、自由走动、角色命中区域要在下一阶段做。
- 若浏览器显示 404，检查拼写及路径：`/models/BlueFatFish.vrm`、`/motions/idle/idle.vrma`。
- 如果 `npm run electron` 打开空白窗口，先确认 Vite 真的在 5173 端口（必要时退出占用端口的其他进程）。
- 角色方向错误可以先点“旋转 180°”。
- BlueFatFish 模型版权归木子恶魔，原插件的模型分发授权不等于你的独立程序自动获得再分发授权。
