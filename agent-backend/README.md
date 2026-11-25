# agent-backend

`DS-Body` 的后端智能体服务，基于 **Python 3.11+ / FastAPI / LangGraph / DeepSeek / 本地 SQLite**，负责管理小鲸娘的多轮对话持久化记忆、情绪连续状态、外部工具调用以及 3D 动作与表情编排。

## 核心架构 (`app/graph/`)

```text
START ──▶ [agent 节点]（注入延续心情 mood + 安全裁剪历史窗口 + 调用 DeepSeek）
              │
              ├── 调用外部感知工具（如 get_current_time）──▶ [tools 节点] ──▶ 回到 [agent 节点]
              │
              └── 调用 submit_pet_reply ──────────────────▶ [finalize 节点]（闭合消息链 + 白名单清洗 + 更新心情）──▶ END
                                                                    │
                                                     自动由 AsyncSqliteSaver 持久化至
                                                       data/pet_memory.sqlite
```

- **彻底告别多轮空返回**：通过 LangChain / DeepSeek 原生 Tool Calling（`submit_pet_reply`）输出结构化回复与动作，并在 `finalize` 节点自动补齐配对 `ToolMessage` 与断电自愈校验。
- **本地 SQLite 记忆持久化**：默认保存在 `agent-backend/data/pet_memory.sqlite`（已在 `.gitignore` 忽略），重启后端服务依然保留之前的聊天上下文与小鲸娘的心情状态；前端点击“清空”按钮会直接从 SQLite 删除对应 `session_id`（`thread_id`）。
- **易扩展工具箱**：在 `app/graph/tools.py` 的 `EXTERNAL_TOOLS` 列表中注册 `@tool` 函数（目前已内置本地日期/时间/星期/时段感知工具 `get_current_time`），Agent 即可自动按需调用。

## 1. 填入你的 DeepSeek 密钥

打开本目录下的 **`agent-backend/.env`** 文件（本地忽略文件，不会提交到 GitHub），填入你的密钥：

```dotenv
DEEPSEEK_API_KEY=sk-在这里填入你的真实DeepSeek密钥
```

## 2. 启动服务

```bash
cd agent-backend
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## 3. 运行测试

```bash
uv run pytest
```
