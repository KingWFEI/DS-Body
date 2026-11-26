"""
DS-Body 后端智能体 FastAPI 入口模块（LangGraph + 本地 SQLite 记忆持久化 + faster-whisper 离线语音输入）。

提供接口：
- GET  /health              ：检查服务在线状态、引擎类型、ASR 模型及 DeepSeek 密钥是否已配置
- POST /api/v1/chat         ：发送文字聊天消息，返回小鲸娘回复及伴随的 3D 动作/表情/移动指令
- POST /api/v1/voice/chat   ：上传麦克风录音音频，经离线 ASR 转写后送入同一 LangGraph 会话并返回回复与动作
- POST /api/v1/chat/clear   ：从本地 SQLite 数据库清空指定会话的多轮对话记忆
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import (
    ChatRequest,
    ChatResponse,
    ClearSessionRequest,
    ClearSessionResponse,
    HealthResponse,
    PetAction,
    VoiceChatResponse,
)
from app.services.agent_service import agent_service
from app.services.asr_service import asr_service

logger = logging.getLogger(__name__)

# 单次语音上传允许的最大体积（15 MB，足够数分钟 16kHz 单声道 WAV）
MAX_AUDIO_BYTES = 15 * 1024 * 1024


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """在服务启动时初始化 SQLite 记忆库与 LangGraph，退出时安全关闭数据库连接。"""
    await agent_service.initialize()
    try:
        yield
    finally:
        await agent_service.shutdown()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="DS-Body 桌面宠物智能体后端服务（LangGraph + DeepSeek + SQLite + faster-whisper）",
    lifespan=lifespan,
)

# 配置跨域中间件，允许桌宠主窗口与对话窗口直接请求后端接口
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse, summary="健康检查与配置状态")
async def health_check() -> HealthResponse:
    """返回后端服务健康状态、编排引擎、语音模型规格及 DeepSeek 密钥是否已配置。"""
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        engine="langgraph+sqlite",
        model=settings.deepseek_model,
        asr_model=f"faster-whisper-{settings.whisper_model_size}",
        api_key_configured=settings.has_valid_api_key,
    )


@app.post("/api/v1/chat", response_model=ChatResponse, summary="文字与桌宠小鲸娘对话")
async def chat(request: ChatRequest) -> ChatResponse:
    """接收用户文字输入，运行 LangGraph 状态图持久化上下文并返回文字回复与桌宠动作指令。"""
    return await agent_service.chat(request)


@app.post("/api/v1/voice/chat", response_model=VoiceChatResponse, summary="语音与桌宠小鲸娘对话")
async def voice_chat(
    audio: UploadFile = File(..., description="前端录制的音频文件（推荐 16kHz 16-bit 单声道 WAV）"),
    session_id: str = Form(default="default", description="会话 ID，与文字聊天窗口共享记忆"),
) -> VoiceChatResponse:
    """
    接收前端语音录制片段：
    1. 调用本地离线 `faster-whisper` 转写为简体中文；
    2. 若未检测到有效人声，直接返回温柔提示而不消耗大模型 Token；
    3. 若识别成功，复用与文字聊天完全一致的 LangGraph + SQLite 会话生成回复与桌宠动作。
    """
    audio_bytes = await audio.read()
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="上传音频文件过大（上限 15MB）")

    try:
        recognized_text = await asr_service.transcribe(audio_bytes)
    except Exception as exc:
        logger.exception("离线语音转写失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"本地语音识别失败：{exc}") from exc

    if not recognized_text:
        return VoiceChatResponse(
            session_id=session_id,
            recognized_text="",
            reply="唔，刚刚好像没听清你说什么，可以再说一遍吗？🎤",
            action=PetAction(
                motion="idle/idle lookaround1",
                expression="surprised",
                expression_weight=0.8,
            ),
            using_mock=False,
        )

    chat_result = await agent_service.chat(
        ChatRequest(
            message=recognized_text,
            session_id=session_id,
        )
    )
    return VoiceChatResponse(
        session_id=chat_result.session_id,
        recognized_text=recognized_text,
        reply=chat_result.reply,
        action=chat_result.action,
        using_mock=chat_result.using_mock,
    )


@app.post("/api/v1/chat/clear", response_model=ClearSessionResponse, summary="清空会话记忆")
async def clear_chat_session(request: ClearSessionRequest) -> ClearSessionResponse:
    """从本地 SQLite 数据库清空指定 session_id 的多轮上下文记忆。"""
    cleared = await agent_service.clear_session(request.session_id)
    return ClearSessionResponse(session_id=request.session_id, cleared=cleared)
