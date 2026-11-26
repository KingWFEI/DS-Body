# DS-Body

**DS-Body** 是桌面 3D 宠物与 **LangGraph + DeepSeek + 离线语音识别** 智能体后端的一体化仓库，包含两个子项目：

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| [`desktop-pet/`](./desktop-pet) | Windows 桌面 3D 桌宠客户端（透明置顶窗口、VRM 模型、VRMA 动作、右下角实时语音波纹输入、右上角独立透明气泡回复与文字聊天窗口） | Electron、Vite、Three.js、`@pixiv/three-vrm`、Web Audio API |
| [`agent-backend/`](./agent-backend) | 智能体后端服务（LangGraph 状态图编排、本地 SQLite 记忆持久化、`faster-whisper` 本地离线语音转写、情绪延续与动作下发） | Python 3.11+、FastAPI、LangGraph、`faster-whisper`、`aiosqlite` |

## 快速体验

### 第一步：填入 DeepSeek 密钥

打开 `agent-backend/.env`（本地忽略文件，不会上传到 GitHub；首次克隆仓库可执行 `cp agent-backend/.env.example agent-backend/.env`），填入你的密钥：

```dotenv
DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
```

### 第二步：启动智能体后端 (`agent-backend`)

```bash
cd agent-backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

> - 对话记忆与小鲸娘心情自动持久化到 `agent-backend/data/pet_memory.sqlite`。
> - 离线语音识别模型权重缓存在 `agent-backend/data/whisper_models`（免费离线可用，无需额外语音密钥）。

### 第三步：启动 3D 桌宠客户端 (`desktop-pet`)

```bash
cd desktop-pet
npm install

# 终端 1：启动 Vite 开发服务器 (http://127.0.0.1:5173)
npm run dev

# 终端 2：启动 Electron 桌面宠物窗口
npm run electron
```

### 交互方式一览
- **🎙️ 语音对话**：点击桌宠右下角的 `🎙️` 按钮展开实时声波纹胶囊，开口说话后停顿约 `1.3 秒` 自动发送（再次点击 `🎙️` 可立即发送，点 `✕` 取消）。
- **💭 右上角回答气泡**：小鲸娘回答时会在模型头部右上角（贴靠屏幕右边缘时自动翻到左上角）弹出透明穿透打字机气泡，同时做出表情与单次动作，阅读完毕后自动平滑恢复待机。
- **💬 文字聊天窗**：点击 `💬` 打开独立聊天记录面板，与语音输入共享同一个会话上下文记忆。

## 资源署名与许可说明

- `desktop-pet/public/models/BlueFatFish.vrm`（蓝色小肥鱼 Deepseek）模型作者为 **木子恶魔**。
- 模型元数据要求署名（Credit Required），且禁止修改与未授权再分发（`allowRedistribution: false`、`modification: prohibited`），仅供个人非商业学习研究使用，请严格遵守原作者模型许可协议。
