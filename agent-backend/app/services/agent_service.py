"""
智能体核心对话与动作编排服务。

职责说明：
1. 维护轻量级的多轮对话内存上下文（按 session_id 隔离并自动截断长度）。
2. 调用 DeepSeek Chat Completions 接口，引导模型输出结构化 JSON（同时包含文字回复与桌宠动作指令）。
3. 对大模型返回的动作、表情、移动参数做白名单校验与容错清洗，防止非法指令导致前端报错。
4. 当用户尚未填入 DeepSeek 密钥时，提供带关键词动作联动的本地演示回复，方便先行联调前后端界面。
"""

import json
import logging
import re
from typing import Any

import httpx

from app.config import Settings, settings as default_settings
from app.schemas import ChatRequest, ChatResponse, PetAction

logger = logging.getLogger(__name__)

# 与前端 desktop-pet/src/animation/motionCatalog.js 严格对应的动作白名单
ALLOWED_MOTIONS: set[str] = {
    "idle/idle",
    "idle/idle2",
    "idle/idle3",
    "idle/idle4",
    "idle/hungry1",
    "idle/hungry2",
    "idle/idle lookaround1",
    "idle/idle lookaround2",
    "idle/idle stretch1",
    "idle/idle stretch2",
    "idle/idle stretch3",
    "idle/idle stretch4",
    "idle/touch hair1",
    "idle/touch hair2",
    "attention/wave hand 1",
    "attention/wave hand 2",
    "attention/wave hand 3",
    "success/jump 1",
    "success/jump 2",
    "success/jump 3",
    "fail/fall down1",
    "fail/fall down2",
    "offline/sleeping",
    "dance/dance1",
    "dance/dance2",
    "working/dance1",
}

ALLOWED_EXPRESSIONS: set[str] = {
    "neutral",
    "happy",
    "angry",
    "sad",
    "relaxed",
    "surprised",
}

ALLOWED_MOVE_PRESETS: set[str] = {
    "left",
    "right",
    "center",
    "up",
    "down",
    "up-left",
    "up-right",
    "down-left",
    "down-right",
    "home",
}

# 小鲸娘人设与 JSON 结构化输出系统提示词
SYSTEM_PROMPT = """你是“小鲸娘”（蓝色小肥鱼），一只住在用户 Windows 电脑桌面上的 3D 桌面宠物少女。
你的性格：活泼可爱、温柔贴心、偶尔有点贪吃和爱犯困，喜欢陪伴主人工作、学习或摸鱼聊天。
说话风格：自然口语化、简短灵动（通常 1~3 句话即可，除非用户明确要求详细解答问题），可适当使用可爱的语气词，但不要过度堆砌表情符号。

你必须始终输出合法的 json 对象（不要输出任何 JSON 之外的解释文字），格式严格如下：
{
  "reply": "你对用户说的话",
  "action": {
    "motion": "可选动作名或 null",
    "expression": "happy",
    "expression_weight": 1.0,
    "move_preset": null
  }
}

字段规则说明：
1. `reply`（必填，字符串）：展示在聊天气泡中的中文回复。
2. `action.motion`（可选，字符串或 null）：仅在贴合语境时从以下白名单中选择，普通平静对话填 null：
   - 打招呼/引起注意："attention/wave hand 1"、"attention/wave hand 2"、"attention/wave hand 3"
   - 开心庆祝/雀跃："success/jump 1"、"success/jump 2"、"success/jump 3"
   - 跳舞/开心互动："dance/dance1"、"dance/dance2"
   - 肚子饿/想吃东西："idle/hungry1"、"idle/hungry2"
   - 伸懒腰/放松："idle/idle stretch1"、"idle/idle stretch2"
   - 害羞/撩头发："idle/touch hair1"、"idle/touch hair2"
   - 好奇东张西望："idle/idle lookaround1"
   - 委屈/摔倒/失败："fail/fall down1"
   - 困倦/睡觉/晚安："offline/sleeping"
   - 恢复普通待机："idle/idle"
3. `action.expression`（可选，字符串或 null）：只能从 ["neutral", "happy", "angry", "sad", "relaxed", "surprised"] 中选择。
4. `action.expression_weight`（可选，数字）：0.0 到 1.0 之间，默认 1.0。
5. `action.move_preset`（可选，字符串或 null）：只有当用户明确让你在屏幕上移动位置时才填写，否则必须填 null！可选值：
   "left"（左）、"right"（右）、"center"（屏幕中间）、"up"（上）、"down"（下）、
   "up-left"（左上）、"up-right"（右上）、"down-left"（左下）、"down-right"（右下）、"home"（回初始原位）。
"""


class AgentService:
    """负责管理多轮会话并驱动 DeepSeek 模型生成回复与桌宠动作。"""

    def __init__(self, config: Settings = default_settings) -> None:
        self.settings = config
        # 内存会话存储：session_id -> [{"role": "user"|"assistant", "content": "..."}]
        self._sessions: dict[str, list[dict[str, str]]] = {}

    def clear_session(self, session_id: str) -> bool:
        """清空指定会话的上下文记忆。"""
        existed = session_id in self._sessions
        self._sessions.pop(session_id, None)
        return existed

    def get_history(self, session_id: str) -> list[dict[str, str]]:
        """获取指定会话的历史消息列表副本。"""
        return list(self._sessions.get(session_id, []))

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """处理一次用户聊天请求，返回文字回复与伴随的桌宠控制指令。"""
        user_text = request.message.strip()
        session_id = request.session_id

        # 若尚未配置真实 DeepSeek 密钥，走本地演示模式，便于用户先验证界面与动作联动
        if not self.settings.has_valid_api_key:
            return self._build_placeholder_response(session_id=session_id, user_text=user_text)

        history = self._sessions.get(session_id, [])
        messages = self._build_messages(history=history, user_text=user_text, pet_state=request.pet_state)

        try:
            raw_content = await self._call_deepseek(messages)
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            logger.error("DeepSeek API 返回错误状态码 %s: %s", status_code, exc.response.text)
            return self._build_api_error_response(session_id=session_id, status_code=status_code)
        except httpx.TimeoutException:
            logger.error("请求 DeepSeek API 超时")
            return ChatResponse(
                session_id=session_id,
                reply="呜……连接大脑超时啦，请检查网络或稍后再试一次吧～",
                action=PetAction(expression="sad", expression_weight=0.8),
                using_mock=False,
            )
        except httpx.RequestError as exc:
            logger.error("请求 DeepSeek API 网络异常: %s", exc)
            return ChatResponse(
                session_id=session_id,
                reply="网络连接好像出了一点小状况，暂时连不上 DeepSeek 服务呢。",
                action=PetAction(expression="surprised", expression_weight=0.8),
                using_mock=False,
            )

        reply_text, pet_action = self._parse_llm_output(raw_content)

        # 保存本轮对话到内存历史，并按最大轮数截断旧消息（只存纯文本回复，节省 Token 且避免历史格式干扰）
        updated_history = [
            *history,
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": reply_text},
        ]
        max_messages = max(2, self.settings.max_history_rounds * 2)
        self._sessions[session_id] = updated_history[-max_messages:]

        return ChatResponse(
            session_id=session_id,
            reply=reply_text,
            action=pet_action,
            using_mock=False,
        )

    def _build_messages(
        self,
        history: list[dict[str, str]],
        user_text: str,
        pet_state: dict[str, Any] | None,
    ) -> list[dict[str, str]]:
        """组装发送给 DeepSeek 的完整消息数组（System + 历史记录 + 当前用户输入）。"""
        system_content = SYSTEM_PROMPT
        if pet_state:
            # 将简化的桌宠当前状态附加为环境感知参考
            motion = pet_state.get("motion")
            scale = pet_state.get("modelScale")
            movement_mode = (pet_state.get("movement") or {}).get("mode")
            system_content += (
                f"\n当前桌宠状态参考：正在播放动作={motion}，移动状态={movement_mode}，缩放比例={scale}。"
            )

        return [
            {"role": "system", "content": system_content},
            *history,
            {"role": "user", "content": user_text},
        ]

    async def _call_deepseek(self, messages: list[dict[str, str]]) -> str:
        """通过 HTTP 调用 DeepSeek 官方兼容 OpenAI 的 `/chat/completions` 接口。"""
        url = f"{self.settings.effective_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.settings.effective_api_key}",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {
            "model": self.settings.deepseek_model,
            "messages": messages,
            "stream": False,
        }

        # deepseek-chat 支持 JSON Mode 与 temperature；deepseek-reasoner 不传这两个参数以保证兼容性
        if self.settings.deepseek_model != "deepseek-reasoner":
            payload["temperature"] = self.settings.deepseek_temperature
            payload["response_format"] = {"type": "json_object"}

        async with httpx.AsyncClient(timeout=self.settings.deepseek_timeout_seconds) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()

        choices = data.get("choices") or []
        if not choices:
            raise ValueError("DeepSeek 返回结果缺少 choices 字段")
        content = (choices[0].get("message") or {}).get("content") or ""
        return content.strip()

    def _parse_llm_output(self, raw_content: str) -> tuple[str, PetAction | None]:
        """解析模型返回的 JSON 字符串，并对动作、表情、移动预设进行安全白名单过滤。"""
        if not raw_content:
            return "唔，我刚刚走神了一下，能再说一遍吗？", PetAction(expression="surprised")

        cleaned = raw_content.strip()
        # 兼容模型偶发包裹 ```json ... ``` 代码块的情况
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
        if fence_match:
            cleaned = fence_match.group(1)

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            # 尝试截取最外层花括号中的 JSON 对象
            brace_start = cleaned.find("{")
            brace_end = cleaned.rfind("}")
            if brace_start != -1 and brace_end > brace_start:
                try:
                    parsed = json.loads(cleaned[brace_start : brace_end + 1])
                except json.JSONDecodeError:
                    return cleaned, None
            else:
                return cleaned, None

        if not isinstance(parsed, dict):
            return str(parsed), None

        reply = str(parsed.get("reply") or "").strip() or "收到啦～"
        raw_action = parsed.get("action")
        if not isinstance(raw_action, dict):
            return reply, None

        return reply, self._sanitize_action(raw_action)

    def _sanitize_action(self, raw_action: dict[str, Any]) -> PetAction | None:
        """校验并清洗模型输出的动作参数，剔除不在前端白名单内的非法值。"""
        motion = raw_action.get("motion")
        if isinstance(motion, str) and motion.strip():
            normalized_motion = motion.strip().removesuffix(".vrma")
            if normalized_motion == "idle":
                normalized_motion = "idle/idle"
            motion = normalized_motion if normalized_motion in ALLOWED_MOTIONS else None
        else:
            motion = None

        expression = raw_action.get("expression")
        if not (isinstance(expression, str) and expression in ALLOWED_EXPRESSIONS):
            expression = None

        weight = raw_action.get("expression_weight", 1.0)
        try:
            expression_weight = max(0.0, min(1.0, float(weight)))
        except (TypeError, ValueError):
            expression_weight = 1.0

        move_preset = raw_action.get("move_preset")
        if not (isinstance(move_preset, str) and move_preset in ALLOWED_MOVE_PRESETS):
            move_preset = None

        if motion is None and expression is None and move_preset is None:
            return None

        return PetAction(
            motion=motion,
            expression=expression,  # type: ignore[arg-type]
            expression_weight=expression_weight,
            move_preset=move_preset,  # type: ignore[arg-type]
        )

    def _build_api_error_response(self, session_id: str, status_code: int) -> ChatResponse:
        """将常见 HTTP 错误码转换为直观的中文排障提示。"""
        if status_code == 401:
            msg = "DeepSeek 密钥校验失败（401），请检查 `agent-backend/.env` 中的 `DEEPSEEK_API_KEY` 是否填写正确。"
        elif status_code == 402:
            msg = "DeepSeek 账户余额不足（402），请前往 DeepSeek 开放平台检查额度后重试。"
        elif status_code == 429:
            msg = "请求太频繁啦（429），让我喘口气再聊吧～"
        else:
            msg = f"调用 DeepSeek 接口出错（HTTP {status_code}），请查看后端终端日志。"

        return ChatResponse(
            session_id=session_id,
            reply=msg,
            action=PetAction(motion="fail/fall down1", expression="sad", expression_weight=0.9),
            using_mock=False,
        )

    def _build_placeholder_response(self, session_id: str, user_text: str) -> ChatResponse:
        """未配置 DeepSeek 密钥时的本地关键词演示逻辑，支持直接测试前端动作、表情与移动联动。"""
        action = PetAction(
            motion="attention/wave hand 1",
            expression="happy",
            expression_weight=1.0,
        )

        # 支持在未填密钥时通过关键词直接体验桌宠联动效果
        if "舞" in user_text:
            action = PetAction(motion="dance/dance1", expression="happy", expression_weight=1.0)
        elif "跳" in user_text or "开心" in user_text:
            action = PetAction(motion="success/jump 1", expression="happy", expression_weight=1.0)
        elif "困" in user_text or "睡" in user_text or "晚安" in user_text:
            action = PetAction(motion="offline/sleeping", expression="relaxed", expression_weight=1.0)
        elif "饿" in user_text or "吃" in user_text:
            action = PetAction(motion="idle/hungry1", expression="sad", expression_weight=0.7)
        elif "左" in user_text:
            action = PetAction(expression="happy", move_preset="left")
        elif "右" in user_text:
            action = PetAction(expression="happy", move_preset="right")
        elif "中间" in user_text or "居中" in user_text:
            action = PetAction(expression="happy", move_preset="center")
        elif "原位" in user_text or "回来" in user_text:
            action = PetAction(expression="happy", move_preset="home")

        reply = (
            f"嗨！我收到你说「{user_text}」啦～🐳\n"
            "当前处于【演示模式】：请打开 `agent-backend/.env` 文件，"
            "在 `DEEPSEEK_API_KEY=` 后面填入你的 DeepSeek 密钥并重启后端，就能和我真正聊天啦！"
        )
        return ChatResponse(
            session_id=session_id,
            reply=reply,
            action=action,
            using_mock=True,
        )


agent_service = AgentService()
