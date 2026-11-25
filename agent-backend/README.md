# agent-backend

`DS-Body` 的后端智能体服务，基于 **Python 3.11+ / FastAPI**，负责处理桌宠对话请求、大模型编排，并向前端下发伴随动作、表情与移动指令（对接前端 `window.character`）。

## 目录结构

```text
agent-backend/
├── app/
│   ├── config.py                  # 环境变量与服务配置
│   ├── main.py                    # FastAPI 应用入口与路由
│   ├── schemas.py                 # 对话消息与桌宠动作指令模型
│   └── services/
│       └── agent_service.py       # 智能体对话与动作编排逻辑
├── tests/
│   └── test_api.py                # 接口自动化测试
├── .env.example                   # 环境变量模板
├── pyproject.toml                 # 项目元数据与 uv 依赖定义
└── requirements.txt               # pip 依赖清单
```

## 本地开发

```bash
cp .env.example .env

# 方式一：使用 uv（推荐）
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 方式二：使用 venv + pip
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

启动后可访问：
- 健康检查：`http://127.0.0.1:8000/health`
- Swagger 接口文档：`http://127.0.0.1:8000/docs`

## 运行测试

```bash
uv run pytest
# 或激活虚拟环境后运行：
pytest
```
