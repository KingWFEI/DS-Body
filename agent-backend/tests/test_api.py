"""后端智能体接口与动作解析单元测试。"""

import json
import pytest
from fastapi.testclient import TestClient

from app.config import API_KEY_PLACEHOLDER, Settings
from app.main import app
from app.schemas import ChatRequest
from app.services.agent_service import AgentService

client = TestClient(app)


def test_health_check_placeholder_key() -> None:
    """默认占位符状态下，健康检查应正常返回且标记 api_key_configured 为 False。"""
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["model"] == "deepseek-chat"
    assert isinstance(payload["api_key_configured"], bool)


def test_demo_mode_keyword_actions() -> None:
    """未填入真实密钥时，演示模式应正常响应并根据关键词触发对应动作或移动指令。"""
    service = AgentService(Settings(deepseek_api_key=API_KEY_PLACEHOLDER))

    import asyncio

    dance_res = asyncio.run(
        service.chat(ChatRequest(message="给我跳支舞吧", session_id="demo-1"))
    )
    assert dance_res.using_mock is True
    assert dance_res.action is not None
    assert dance_res.action.motion == "dance/dance1"

    move_res = asyncio.run(
        service.chat(ChatRequest(message="去左边待一会儿", session_id="demo-1"))
    )
    assert move_res.using_mock is True
    assert move_res.action is not None
    assert move_res.action.move_preset == "left"


@pytest.mark.anyio
async def test_deepseek_json_parsing_and_multi_turn_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    """填入有效密钥后，应正确解析 DeepSeek 返回的 JSON、过滤非法动作并维护多轮历史。"""
    service = AgentService(Settings(deepseek_api_key="sk-unit-test-valid-key", max_history_rounds=3))

    async def fake_call_deepseek(messages: list[dict[str, str]]) -> str:
        # 验证历史消息按轮次递增传入
        assert messages[0]["role"] == "system"
        return (
            "```json\n"
            + json.dumps(
                {
                    "reply": "好呀，向你挥挥手！",
                    "action": {
                        "motion": "attention/wave hand 1.vrma",
                        "expression": "happy",
                        "expression_weight": 0.9,
                        "move_preset": "invalid-direction",  # 非法预设方向应被安全过滤为 None
                    },
                },
                ensure_ascii=False,
            )
            + "\n```"
        )

    monkeypatch.setattr(service, "_call_deepseek", fake_call_deepseek)

    result = await service.chat(ChatRequest(message="你好小鲸娘", session_id="s-real"))
    assert result.using_mock is False
    assert result.reply == "好呀，向你挥挥手！"
    assert result.action is not None
    assert result.action.motion == "attention/wave hand 1"
    assert result.action.expression == "happy"
    assert result.action.expression_weight == 0.9
    assert result.action.move_preset is None

    history = service.get_history("s-real")
    assert len(history) == 2
    assert history[0] == {"role": "user", "content": "你好小鲸娘"}
    assert history[1] == {"role": "assistant", "content": "好呀，向你挥挥手！"}

    assert service.clear_session("s-real") is True
    assert service.get_history("s-real") == []


def test_clear_endpoint() -> None:
    """清空会话接口应正常返回。"""
    response = client.post("/api/v1/chat/clear", json={"session_id": "test-clear"})
    assert response.status_code == 200
    assert response.json()["session_id"] == "test-clear"
