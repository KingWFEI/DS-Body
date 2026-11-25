# DS-Body

**DS-Body** 是桌面 3D 宠物与 DeepSeek 智能体后端的一体化仓库，包含两个子项目：

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| [`desktop-pet/`](./desktop-pet) | Windows 桌面 3D 桌宠客户端（透明置顶窗口、VRM 模型、VRMA 动作、程序化步态、独立对话窗口与角色联动） | Electron、Vite、Three.js、`@pixiv/three-vrm` |
| [`agent-backend/`](./agent-backend) | 智能体后端服务（DeepSeek 多轮对话、小鲸娘人设提示词、结构化动作/表情/移动指令下发） | Python 3.11+、FastAPI、Pydantic、httpx |

## 快速体验（三步跑通对话 + 动作联动）

### 第一步：填入 DeepSeek 密钥

打开 `agent-backend/.env`（本地忽略文件，不会提交到 GitHub；首次克隆仓库可执行 `cp agent-backend/.env.example agent-backend/.env`），填入你的密钥：

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

点击桌宠右下角的 **💬 对话按钮** 即可打开吸附在模型旁边的聊天窗口，发送消息时小鲸娘会一边回复一边自动做出对应的挥手、跳跃、跳舞、换表情或移动动作！

## 资源署名与许可说明

- `desktop-pet/public/models/BlueFatFish.vrm`（蓝色小肥鱼 Deepseek）模型作者为 **木子恶魔**。
- 模型元数据要求署名（Credit Required），且禁止修改与未授权再分发（`allowRedistribution: false`、`modification: prohibited`），仅供个人非商业学习研究使用，请严格遵守原作者模型许可协议。
