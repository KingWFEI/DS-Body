"""LangGraph 状态图、工具调用与本地 SQLite 记忆持久化单元测试。"""

import io
from pathlib import Path
from typing import Any
import wave

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
import numpy as np
import pytest

from app.config import API_KEY_PLACEHOLDER, Settings
from app.graph.tools import SUBMIT_REPLY_TOOL_NAME
from app.graph.workflow import prepare_llm_messages
from app.main import app, asr_service, agent_service
from app.schemas import ChatRequest, ChatResponse, PetAction
from app.services.agent_service import AgentService
from app.services.asr_service import ASRService


class ScriptedFakeLLM:
    """按预设队列依次返回 AIMessage 的轻量级测试替身，并记录每次收到的上下文消息。"""

    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = list(responses)
        self.recorded_calls: list[list[AnyMessage]] = []

    async def ainvoke(self, messages: list[AnyMessage]) -> AIMessage:
        self.recorded_calls.append(list(messages))
        if not self._responses:
            raise AssertionError("ScriptedFakeLLM 预设响应已耗尽")
        return self._responses.pop(0)


def test_health_and_clear_endpoints() -> None:
    """验证健康检查包含 langgraph+sqlite 引擎标识，且清空会话接口在生命周期内正常工作。"""
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        payload = health.json()
        assert payload["status"] == "ok"
        assert payload["engine"] == "langgraph+sqlite"

        clear_res = client.post("/api/v1/chat/clear", json={"session_id": "api-clear-test"})
        assert clear_res.status_code == 200
        assert clear_res.json()["cleared"] is True


@pytest.mark.anyio
async def test_demo_mode_without_api_key() -> None:
    """未填入真实密钥时，服务应自动降级到本地关键词演示模式。"""
    service = AgentService(Settings(deepseek_api_key=API_KEY_PLACEHOLDER, sqlite_db_path=":memory:"))
    try:
        dance_res = await service.chat(ChatRequest(message="来跳支舞吧", session_id="demo"))
        assert dance_res.using_mock is True
        assert dance_res.action is not None
        assert dance_res.action.motion == "dance/dance1"
    finally:
        await service.shutdown()


@pytest.mark.anyio
async def test_langgraph_tool_loop_and_sqlite_persistence_across_restarts(tmp_path: Path) -> None:
    """
    验证完整核心链路：
    1. 第 1 轮先调用 `get_current_time` 工具，再调用 `submit_pet_reply` 输出回复与动作，且非法方向被过滤；
    2. 关闭服务后重新实例化（模拟重启后端进程），从同一个本地 SQLite 文件恢复历史对话与心情状态；
    3. 第 2 轮发送消息时，大模型收到的历史消息链闭合完整（每条 tool_calls 均有配对 ToolMessage）；
    4. 调用 `clear_session` 后，SQLite 中该会话的持久化数据被彻底清除。
    """
    db_file = tmp_path / "pet_memory.sqlite"
    test_settings = Settings(
        deepseek_api_key="sk-unit-test-valid",
        sqlite_db_path=str(db_file),
        max_history_rounds=5,
    )

    # ---------- 进程实例 1：测试外部工具循环 + 首次持久化 ----------
    llm_round_1 = ScriptedFakeLLM(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "call_time_1",
                        "name": "get_current_time",
                        "args": {},
                    }
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "call_reply_1",
                        "name": SUBMIT_REPLY_TOOL_NAME,
                        "args": {
                            "reply": "我看了一眼时间，现在向你挥挥手问好呀！",
                            "motion": "attention/wave hand 1.vrma",
                            "expression": "relaxed",
                            "expression_weight": 0.9,
                            "move_preset": "mars",  # 非法预设方向，应被清洗为 None
                        },
                    }
                ],
            ),
        ]
    )
    service_1 = AgentService(config=test_settings, llm_override=llm_round_1)
    res_1 = await service_1.chat(ChatRequest(message="现在几点啦？", session_id="persist-thread"))
    assert res_1.using_mock is False
    assert res_1.reply == "我看了一眼时间，现在向你挥挥手问好呀！"
    assert res_1.action is not None
    assert res_1.action.motion == "attention/wave hand 1"
    assert res_1.action.expression == "relaxed"
    assert res_1.action.move_preset is None
    assert len(llm_round_1.recorded_calls) == 2  # 第 1 次调时间工具，第 2 次拿时间结果生成回复
    await service_1.shutdown()

    assert db_file.exists()

    # ---------- 进程实例 2（模拟重启后端）：验证从磁盘 SQLite 恢复记忆与情绪 ----------
    llm_round_2 = ScriptedFakeLLM(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "call_reply_2",
                        "name": SUBMIT_REPLY_TOOL_NAME,
                        "args": {
                            "reply": "当然记得呀，刚才帮你看过时间呢！",
                            "motion": None,
                            "expression": "happy",
                        },
                    }
                ],
            )
        ]
    )
    service_2 = AgentService(config=test_settings, llm_override=llm_round_2)
    try:
        restored_history = await service_2.get_history("persist-thread")
        assert restored_history == [
            {"role": "user", "content": "现在几点啦？"},
            {"role": "assistant", "content": "我看了一眼时间，现在向你挥挥手问好呀！"},
        ]

        res_2 = await service_2.chat(
            ChatRequest(message="你还记得刚才做了什么吗？", session_id="persist-thread")
        )
        assert res_2.reply == "当然记得呀，刚才帮你看过时间呢！"

        # 检查发给大模型的提示词中是否继承了上一轮的 relaxed 心情，且所有 tool_calls 均有配对 ToolMessage
        sent_messages = llm_round_2.recorded_calls[0]
        assert "relaxed" in str(sent_messages[0].content)
        tool_Msg_ids = {m.tool_call_id for m in sent_messages if isinstance(m, ToolMessage)}
        assert {"call_time_1", "call_reply_1"}.issubset(tool_Msg_ids)

        # 验证清空会话能够删除 SQLite 中的记录
        assert await service_2.clear_session("persist-thread") is True
        assert await service_2.get_history("persist-thread") == []
    finally:
        await service_2.shutdown()


def test_prepare_llm_messages_heals_dangling_tool_calls() -> None:
    """验证若上次进程在工具调用中途强退遗留了未闭合的 tool_call_id，准备消息时会自动补齐。"""
    broken_history: list[AnyMessage] = [
        HumanMessage(content="第一句话"),
        AIMessage(
            content="",
            tool_calls=[{"id": "dangling_1", "name": SUBMIT_REPLY_TOOL_NAME, "args": {"reply": "半截"}}],
        ),
        # 注意：这里故意缺失对应的 ToolMessage
        HumanMessage(content="第二句话"),
    ]
    healed = prepare_llm_messages(broken_history, max_rounds=5, system_prompt="sys")
    tool_msgs = [m for m in healed if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "dangling_1"


def _make_16k_wav_bytes(duration_sec: float = 0.5) -> bytes:
    """生成一段标准 16kHz 16-bit 单声道测试 WAV 字节流。"""
    sample_count = int(16000 * duration_sec)
    samples = (np.sin(np.linspace(0, 20 * np.pi, sample_count)) * 12000).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


def test_asr_wav_fast_decoder_and_voice_chat_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证 16kHz WAV 快速解码器及 /api/v1/voice/chat 的静音兜底与识别对话链路。"""
    wav_bytes = _make_16k_wav_bytes(0.4)
    decoded = ASRService._try_decode_16k_pcm_wav(wav_bytes)
    assert decoded is not None
    assert decoded.shape == (6400,)
    assert decoded.dtype == np.float32

    # 1. 当未识别到有效说话内容时，不消耗大模型调用并给出温柔提示
    async def fake_transcribe_empty(_data: bytes) -> str:
        return ""

    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe_empty)
    with TestClient(app) as client:
        empty_res = client.post(
            "/api/v1/voice/chat",
            files={"audio": ("voice.wav", wav_bytes, "audio/wav")},
            data={"session_id": "voice-s1"},
        )
        assert empty_res.status_code == 200
        assert empty_res.json()["recognized_text"] == ""
        assert "没听清" in empty_res.json()["reply"]

    # 2. 当识别出中文句子时，应转交智能体服务并返回转写文本、回复及动作
    async def fake_transcribe_hello(_data: bytes) -> str:
        return "你好小鲸娘"

    async def fake_agent_chat(req: ChatRequest) -> ChatResponse:
        assert req.message == "你好小鲸娘"
        assert req.session_id == "voice-s1"
        return ChatResponse(
            session_id=req.session_id,
            reply="听见你叫我啦！",
            action=PetAction(motion="attention/wave hand 1", expression="happy"),
            using_mock=False,
        )

    monkeypatch.setattr(asr_service, "transcribe", fake_transcribe_hello)
    monkeypatch.setattr(agent_service, "chat", fake_agent_chat)

    with TestClient(app) as client:
        ok_res = client.post(
            "/api/v1/voice/chat",
            files={"audio": ("voice.wav", wav_bytes, "audio/wav")},
            data={"session_id": "voice-s1"},
        )
        assert ok_res.status_code == 200
        body = ok_res.json()
        assert body["recognized_text"] == "你好小鲸娘"
        assert body["reply"] == "听见你叫我啦！"
        assert body["action"]["motion"] == "attention/wave hand 1"

