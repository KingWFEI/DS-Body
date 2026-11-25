"""
LangGraph 智能体工具集与结构化动作校验器。

设计思路：
1. `EXTERNAL_TOOLS`：小鲸娘可主动调用的外部感知工具（如查询系统当前时间/星期/早晚时段，后续可轻松扩展天气、日程、剪贴板等工具）。
2. `submit_pet_reply`（结构化输出工具）：通过 Function Calling / Tool Calling 一次性输出「气泡文字回复 + 身体动作 + 面部表情 + 屏幕移动」，
   彻底避免传统 `json_object` 模式在多轮对话中偶发返回空字符串（“走神”）的问题。
3. 白名单清洗函数 `sanitize_pet_action`：严格对齐前端 `motionCatalog.js` 和 VRM 表情清单，过滤任何幻觉参数。
"""

from datetime import datetime
import json
import re
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.schemas import PetAction

# 最终回复提交工具的固定名称，用于图路由判断何时结束推理循环
SUBMIT_REPLY_TOOL_NAME = "submit_pet_reply"

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

WEEKDAY_NAMES = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")


def _get_day_period(hour: int) -> str:
    """根据小时数划分中文自然时段，方便小鲸娘感知早晚作息。"""
    if 5 <= hour < 9:
        return "清晨/早上"
    if 9 <= hour < 12:
        return "上午"
    if 12 <= hour < 14:
        return "中午"
    if 14 <= hour < 18:
        return "下午"
    if 18 <= hour < 22:
        return "晚上"
    return "深夜/凌晨"


@tool
def get_current_time() -> str:
    """获取主人电脑当前的本地日期、精确时间、星期与早晚时段。当主人询问现在几点、今天星期几/几号，或需要结合早晚时间寒暄时调用。"""
    now = datetime.now().astimezone()
    weekday = WEEKDAY_NAMES[now.weekday()]
    period = _get_day_period(now.hour)
    return f"{now.strftime('%Y-%m-%d %H:%M:%S')} ({weekday}，{period})"


class SubmitPetReplyArgs(BaseModel):
    """向主人发送最终气泡回复并同步控制 3D 桌宠表情、动作与屏幕位置的参数模型。"""

    reply: str = Field(
        ...,
        description="小鲸娘对主人说的中文回复，自然口语化、灵动简短（一般 1~3 句话，除非主人要求详细解答）",
    )
    motion: str | None = Field(
        default=None,
        description=(
            "可选的伴随 VRMA 动作路径，贴合语境时从白名单选择，日常平淡对话填 null。"
            "常用值：'attention/wave hand 1'（挥手打招呼）、'success/jump 1'（开心雀跃）、"
            "'dance/dance1'（跳舞）、'idle/hungry1'（肚子饿）、'idle/idle stretch1'（伸懒腰）、"
            "'idle/touch hair1'（害羞撩头发）、'idle/idle lookaround1'（好奇张望）、"
            "'fail/fall down1'（委屈摔倒）、'offline/sleeping'（犯困睡觉）"
        ),
    )
    expression: str | None = Field(
        default="happy",
        description="面部表情名称，仅限：'neutral'、'happy'、'angry'、'sad'、'relaxed'、'surprised'",
    )
    expression_weight: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        description="面部表情强度权重（0.0 ~ 1.0，默认 1.0）",
    )
    move_preset: str | None = Field(
        default=None,
        description=(
            "屏幕预设位置移动指令。仅在主人明确要求你移动屏幕位置时填写，否则必须填 null！"
            "可选：'left'、'right'、'center'、'up'、'down'、'up-left'、'up-right'、'down-left'、'down-right'、'home'"
        ),
    )


@tool(SUBMIT_REPLY_TOOL_NAME, args_schema=SubmitPetReplyArgs)
def submit_pet_reply(
    reply: str,
    motion: str | None = None,
    expression: str | None = "happy",
    expression_weight: float = 1.0,
    move_preset: str | None = None,
) -> str:
    """当你准备好回答主人时，调用此工具提交最终聊天回复，并驱动桌宠身体同步做出表情、动作或移动。"""
    return reply


# 小鲸娘可调用的外部信息查询工具列表（后续新增工具直接注册到此列表即可）
EXTERNAL_TOOLS = [get_current_time]
EXTERNAL_TOOL_MAP = {t.name: t for t in EXTERNAL_TOOLS}

# 绑定给大模型的完整工具列表（外部工具 + 最终结构化回复工具）
ALL_AGENT_TOOLS = [*EXTERNAL_TOOLS, submit_pet_reply]


def sanitize_pet_action(raw_action: dict[str, Any] | None) -> PetAction | None:
    """校验并清洗模型产出的动作、表情与移动参数，剔除不在前端白名单内的非法值。"""
    if not isinstance(raw_action, dict):
        return None

    motion = raw_action.get("motion")
    if isinstance(motion, str) and motion.strip() and motion.strip().lower() != "null":
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


def parse_fallback_content(raw_content: str) -> tuple[str, PetAction | None]:
    """
    当模型（如推理模型 deepseek-reasoner）未走工具调用、直接在文本中输出回复或 JSON 时的兼容解析器。
    """
    cleaned = (raw_content or "").strip()
    if not cleaned:
        return "唔，我刚刚走神了一下，能再说一遍吗？", PetAction(expression="surprised")

    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    candidate = fence_match.group(1) if fence_match else cleaned

    parsed: Any = None
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        brace_start = candidate.find("{")
        brace_end = candidate.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            try:
                parsed = json.loads(candidate[brace_start : brace_end + 1])
            except json.JSONDecodeError:
                parsed = None

    if isinstance(parsed, dict):
        reply = str(parsed.get("reply") or "").strip() or "收到啦～"
        raw_action = parsed.get("action") if isinstance(parsed.get("action"), dict) else parsed
        return reply, sanitize_pet_action(raw_action)

    return cleaned, None
