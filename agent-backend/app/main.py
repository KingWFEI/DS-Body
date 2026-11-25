"""
DS-Body 后端智能体 FastAPI 入口模块。

提供接口：
- GET  /health              ：检查服务在线状态及 DeepSeek 密钥是否已配置
- POST /api/v1/chat         ：发送用户聊天消息，返回小鲸娘回复及伴随的 3D 动作/表情/移动指令
- POST /api/v1/chat/clear   ：清空指定会话的多轮对话历史记忆
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import (
    ChatRequest,
    ChatResponse,
    ClearSessionRequest,
    ClearSessionResponse,
    HealthResponse,
)
from app.services.agent_service import agent_service

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="DS-Body 桌面宠物智能体后端服务（基于 DeepSeek API）",
)

# 配置跨域中间件，允许桌宠对话窗口（Vite 开发服务器或本地页面）直接请求后端接口
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse, summary="健康检查与配置状态")
async def health_check() -> HealthResponse:
    """返回后端服务健康状态以及 DeepSeek 密钥是否已完成配置（不返回密钥明文）。"""
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        model=settings.deepseek_model,
        api_key_configured=settings.has_valid_api_key,
    )


@app.post("/api/v1/chat", response_model=ChatResponse, summary="与桌宠小鲸娘对话")
async def chat(request: ChatRequest) -> ChatResponse:
    """接收用户输入，调用智能体服务生成文字回复与桌宠动作指令。"""
    return await agent_service.chat(request)


@app.post("/api/v1/chat/clear", response_model=ClearSessionResponse, summary="清空会话记忆")
async def clear_chat_session(request: ClearSessionRequest) -> ClearSessionResponse:
    """清空指定 session_id 的多轮上下文记忆。"""
    cleared = agent_service.clear_session(request.session_id)
    return ClearSessionResponse(session_id=request.session_id, cleared=cleared)
