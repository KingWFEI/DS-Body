# DS-Body

**DS-Body** 是桌面 3D 宠物与 **LangGraph + DeepSeek + SQLite + 离线语音识别** 智能体后端的一体化仓库，包含两个子项目：

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| [`desktop-pet/`](./desktop-pet) | Windows 桌面 3D 桌宠客户端（高刷 VSync 透明窗口、底部单行悬浮文字输入、右下角实时语音波纹输入、右上角透明穿透气泡回答、极简设置与历史对话查看） | Electron、Vite、Three.js、`@pixiv/three-vrm`、Web Audio API |
| [`agent-backend/`](./agent-backend) | 智能体后端服务（LangGraph 状态图编排、SQLite `chat_messages` 历史入库与记忆持久化、`faster-whisper` 本地离线语音转写、情绪延续与动作下发） | Python 3.11+、FastAPI、LangGraph、`faster-whisper`、`aiosqlite` |

## 快速启动

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

### 第三步：启动 3D 桌宠客户端 (`desktop-pet`)

```bash
cd desktop-pet
npm install

# 终端 1：启动 Vite 开发服务器 (http://127.0.0.1:5173)
npm run dev

# 终端 2：启动 Electron 桌面宠物窗口
npm run electron
```

## 交互说明
- **🧲 贴边过半自动折叠**：将桌宠往屏幕最左侧或最右侧拖动，当窗口有一半超出屏幕边缘时，松手即可自动收起为一个精致的侧边半圆浮窗按钮（后台自动暂停 3D 渲染零占显卡）；再次点击侧边按钮即可在原高度唤出小鲸娘并挥手问好。
- **💬 底部单行文字输入**：点击右下角 `💬` 在桌宠脚底弹出小巧的单行悬浮输入框，按 `Enter` 发送后**立即自动隐藏输入框**，不留多余界面遮挡桌面。
- **🎙️ 实时波纹语音输入**：点击右下角 `🎙️` 展开实时声波纹胶囊，开口说话后停顿约 `1.3 秒` 自动发送（再次点击 `🎙️` 可立即发送）。
- **💭 右上角透明回答气泡**：无论是文字提问还是语音提问，小鲸娘统一在头部右上角（贴靠屏幕右边缘时自动翻转到左上角）弹出鼠标穿透的打字机气泡回答，并伴随单次动作与表情，结束后平滑恢复默认待机。
- **⚙ 极简设置与 SQLite 历史记录**：点击 `⚙` 可调节模型大小、切换窗口始终置顶、一键回到原位、清空记忆，或点击 **「📜 查看历史对话」** 打开独立历史面板查看保存在本地 SQLite 数据库中的全部问答明细。

## 资源署名与许可说明

- `desktop-pet/public/models/BlueFatFish.vrm`（蓝色小肥鱼 Deepseek）模型作者为 **木子恶魔**。
- 模型元数据要求署名（Credit Required），且禁止修改与未授权再分发（`allowRedistribution: false`、`modification: prohibited`），仅供个人非商业学习研究使用，请严格遵守原作者模型许可协议。
