"""
LangGraph 智能体图状态（Graph State）定义。

除了持久化多轮对话 `messages` 外，还维护小鲸娘的持续情绪 `mood` 与上次动作 `last_motion`，
使桌宠在跨轮次对话（甚至重启后端后）仍具有连贯的情绪状态。
"""

from typing import Annotated, Any, TypedDict
from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages


class PetGraphState(TypedDict, total=False):
    """小鲸娘智能体在 LangGraph 中流转与持久化的状态结构。"""

    # 对话消息历史（使用 LangGraph 官方 add_messages 归约器追加并由 SQLite Checkpointer 持久化）
    messages: Annotated[list[AnyMessage], add_messages]

    # 小鲸娘当前的持续心情（如 happy / relaxed / sad / surprised / angry），跨轮次保留
    mood: str

    # 最近一次触发的 VRMA 动作名称
    last_motion: str | None

    # 本轮前端可选传入的桌宠实时状态快照
    pet_state: dict[str, Any] | None

    # 单轮对话内的工具循环计数，防止异常情况下无限调用工具
    tool_loop_count: int

    # 本轮对话最终提炼出的气泡回复文本
    final_reply: str

    # 本轮对话最终清洗后的桌宠动作指令字典（对应 PetAction）
    final_action: dict[str, Any] | None
