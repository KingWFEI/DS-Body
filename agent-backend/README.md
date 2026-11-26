# agent-backend

`DS-Body` 的后端智能体服务，基于 **Python 3.11+ / FastAPI / LangGraph / DeepSeek / 本地 SQLite / faster-whisper**，负责离线中文语音转写、多轮对话持久化记忆、情绪连续状态、外部工具调用以及 3D 动作与表情编排。

## 核心接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 检查服务状态、编排引擎、ASR 模型规格及 `DEEPSEEK_API_KEY` 是否就绪 |
| `POST` | `/api/v1/chat` | 文字对话接口，返回 `reply` 与 `action`（`motion` / `expression` / `move_preset`） |
| `POST` | `/api/v1/voice/chat` | 语音对话接口（`multipart/form-data` 上传 `audio` + `session_id`），离线转写后复用同一 LangGraph 会话返回 `recognized_text`、`reply` 与 `action` |
| `POST` | `/api/v1/chat/clear` | 从本地 SQLite 删除指定 `session_id` 的历史对话记忆 |

## 启动与测试

```bash
cd agent-backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 运行单元测试
uv run pytest
```
