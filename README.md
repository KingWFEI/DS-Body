# DS-Body

**DS-Body** 是桌面 3D 宠物与智能体后端的一体化仓库，包含两个子项目：

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| [`desktop-pet/`](./desktop-pet) | Windows 桌面 3D 桌宠客户端（透明置顶窗口、VRM 模型、VRMA 动作、程序化步态与对话窗口） | Electron、Vite、Three.js、`@pixiv/three-vrm` |
| [`agent-backend/`](./agent-backend) | 智能体后端服务（对话理解、LLM 编排、桌宠动作/表情/移动指令下发） | Python 3.11+、FastAPI、Pydantic |

## 目录结构

```text
DS-Body/
├── desktop-pet/        # 桌面宠物前端与 Electron 宿主进程
│   ├── electron/       # 主进程窗口控制、穿透检测、IPC 桥
│   ├── public/         # VRM 模型与 VRMA 动作资源
│   ├── src/            # Three.js 场景、运动控制、动作控制与 window.character API
│   └── tests/          # 前端单元测试
└── agent-backend/      # 智能体逻辑后端
    ├── app/            # FastAPI 路由、配置、数据模型与智能体服务
    └── tests/          # 后端接口测试
```

## 快速启动

### 1. 启动桌宠客户端 (`desktop-pet`)

```bash
cd desktop-pet
npm install

# 终端 1：启动 Vite 开发服务器 (http://127.0.0.1:5173)
npm run dev

# 终端 2：启动 Electron 桌面宠物窗口
npm run electron
```

详细控制接口与架构说明见 [`desktop-pet/README.md`](./desktop-pet/README.md)。

### 2. 启动智能体后端 (`agent-backend`)

```bash
cd agent-backend
cp .env.example .env

# 使用 uv（推荐）
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 或使用标准 venv + pip
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

详细接口说明见 [`agent-backend/README.md`](./agent-backend/README.md)。

## 资源署名与许可说明

- `desktop-pet/public/models/BlueFatFish.vrm`（蓝色小肥鱼 Deepseek）模型作者为 **木子恶魔**。
- 模型元数据要求署名（Credit Required），且禁止修改与未授权再分发（`allowRedistribution: false`、`modification: prohibited`），仅供个人非商业学习研究使用，请严格遵守原作者模型许可协议。
