# agent-backend

`DS-Body` 的后端智能体服务，基于 **Python 3.11+ / FastAPI / DeepSeek API**，负责处理小鲸娘的多轮对话记忆、结构化大模型编排，并向前端 3D 桌宠同步下发动作、表情与屏幕移动指令。

## 1. 填入你的 DeepSeek 密钥

直接打开本目录下的 **`agent-backend/.env`** 文件（该文件已在 `.gitignore` 中忽略，不会上传到 GitHub），将占位符替换为你的真实密钥：

```dotenv
DEEPSEEK_API_KEY=sk-在这里填入你的真实DeepSeek密钥
```

> 还没有填入密钥时，后端会自动以 **演示模式** 运行，依然可以测试聊天窗口及“跳舞”“去左边”等桌宠动作联动！填入真实密钥后重启后端即可切换为 DeepSeek 智能对话。

## 2. 启动服务

```bash
cd agent-backend

# 方式一：使用 uv（推荐）
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 方式二：使用 venv + pip
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## 3. 接口说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 检查服务状态与 `DEEPSEEK_API_KEY` 是否已完成配置 |
| `POST` | `/api/v1/chat` | 发送聊天消息，返回 `reply` 文本与 `action`（`motion` / `expression` / `move_preset`） |
| `POST` | `/api/v1/chat/clear` | 清空指定 `session_id` 的多轮对话上下文 |
| `GET` | `/docs` | Swagger 交互式接口文档 |

## 4. 运行测试

```bash
uv run pytest
```
