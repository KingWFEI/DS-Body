# agent-backend

`DS-Body` 的后端智能体服务，基于 **Python 3.11+ / FastAPI / LangGraph / DeepSeek / 本地 SQLite / faster-whisper**，负责离线中文语音转写、LangGraph 状态图编排，以及历史聊天记录的本地 SQLite 数据库持久化。

## 核心接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 检查服务状态、编排引擎、ASR 模型规格及 `DEEPSEEK_API_KEY` 是否就绪 |
| `POST` | `/api/v1/chat` | 文字对话接口，将问答写入 SQLite `chat_messages` 表并返回 `reply` 与 `action` |
| `POST` | `/api/v1/voice/chat` | 语音对话接口，离线转写后复用同一会话入库并返回 `recognized_text`、`reply` 与 `action` |
| `GET` | `/api/v1/chat/history` | 按 `session_id` 查询本地 SQLite `chat_messages` 历史聊天明细（含文字/语音来源、动作与时间戳） |
| `POST` | `/api/v1/chat/clear` | 从本地 SQLite 同步清除指定 `session_id` 的 LangGraph 检查点与 `chat_messages` 历史记录 |

## 启动与测试

```bash
cd agent-backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 运行单元测试
uv run pytest
```
