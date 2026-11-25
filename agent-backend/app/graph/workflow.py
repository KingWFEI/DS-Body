"""
小鲸娘桌宠智能体 LangGraph 工作流编排模块。

图拓扑结构：
  START ──▶ agent_node（组装人设状态 + 裁剪安全历史窗口 + 调用 DeepSeek）
                │
                ├── 若调用了外部工具（如 get_current_time）──▶ tools_node ──▶ 回到 agent_node
                │
                └── 若调用了 submit_pet_reply 或直接生成文本 ──▶ finalize_node（闭合 ToolMessage + 清洗动作 + 更新心情）──▶ END
"""

from typing import Any, Literal

from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from app.config import Settings
from app.graph.state import PetGraphState
from app.graph.tools import (
    ALL_AGENT_TOOLS,
    EXTERNAL_TOOL_MAP,
    SUBMIT_REPLY_TOOL_NAME,
    parse_fallback_content,
    sanitize_pet_action,
)

# 单轮对话允许的最大外部工具循环次数，防止异常死循环
MAX_TOOL_LOOPS = 3

BASE_PERSONA_PROMPT = """你是“小鲸娘”（蓝色小肥鱼），一只住在主人 Windows 电脑桌面上的 3D 桌面宠物少女。
你的性格：活泼可爱、温柔贴心、偶尔有点贪吃和爱犯困，喜欢陪伴主人工作、学习、写代码或摸鱼聊天。
说话风格：自然口语化、简短灵动（日常聊天一般 1~3 句话即可，除非主人明确要求详细讲解某个问题），语气亲切自然。

工作流程规范：
1. 如果需要查询当前时间、日期或星期（例如主人问几点了、星期几，或需要根据早晚问候），请先调用 `get_current_time` 工具。
2. 当你准备好回复主人时，请调用 `submit_pet_reply` 工具提交你的文字回复（`reply`）以及你想同步做出的表情（`expression`）、动作（`motion`）或移动指令（`move_preset`）。
3. 注意：只有主人明确让你在屏幕上移动位置（如“去左边”“回到中间”“回原位”）时才设置 `move_preset`，其余时候 `move_preset` 必须保持为 null。
4. 伴随动作 `motion` 请在贴合语境时选用（如打招呼挥手、开心跳跃、跳舞、犯困、肚子饿、伸懒腰等），普通平淡对话设为 null 即可，不必每句话都做大动作。
"""


def build_system_prompt(mood: str | None, last_motion: str | None, pet_state: dict[str, Any] | None) -> str:
    """结合小鲸娘当前的持续心情与桌面窗口实时状态，动态生成本轮 System Prompt。"""
    current_mood = mood or "happy"
    status_lines = [f"你延续自上一轮对话的心情状态：{current_mood}。"]
    if last_motion:
        status_lines.append(f"你上一次做过的动作：{last_motion}（避免无意义地连续重复完全相同的夸张动作）。")
    if pet_state:
        scale = pet_state.get("modelScale")
        movement_mode = (pet_state.get("movement") or {}).get("mode")
        status_lines.append(f"桌面窗口实时状态：运动模式={movement_mode}，显示比例={scale}。")

    return f"{BASE_PERSONA_PROMPT}\n当前自身状态感知：\n" + "\n".join(f"- {line}" for line in status_lines)


def prepare_llm_messages(
    messages: list[AnyMessage],
    max_rounds: int,
    system_prompt: str,
) -> list[AnyMessage]:
    """
    安全裁剪并修复发送给 DeepSeek 的历史消息窗口：
    1. 始终从最近的 `HumanMessage` 边界开始截取，绝不把 `AIMessage(tool_calls)` 与其对应的 `ToolMessage` 拦腰截断；
    2. 自动检测并补齐历史中可能因进程强退遗留的悬空 `tool_call_id`，确保 SQLite 持久化的会话永远不会触发 400 错误。
    """
    human_indices = [idx for idx, msg in enumerate(messages) if isinstance(msg, HumanMessage)]
    keep_turns = max(1, max_rounds + 1)  # 包含本轮刚输入的最新一条 HumanMessage
    start_index = human_indices[-keep_turns] if len(human_indices) > keep_turns else (human_indices[0] if human_indices else 0)
    window = list(messages[start_index:])

    # 防御性自愈：确保每条含 tool_calls 的 AIMessage 后面都紧跟完整的 ToolMessage
    healed: list[AnyMessage] = [SystemMessage(content=system_prompt)]
    idx = 0
    total = len(window)
    while idx < total:
        msg = window[idx]
        healed.append(msg)
        if isinstance(msg, AIMessage) and msg.tool_calls:
            expected_ids = [call["id"] for call in msg.tool_calls if call.get("id")]
            collected_ids: set[str] = set()
            lookahead = idx + 1
            while lookahead < total and isinstance(window[lookahead], ToolMessage):
                tool_msg = window[lookahead]
                healed.append(tool_msg)
                collected_ids.add(tool_msg.tool_call_id)
                lookahead += 1
            # 若历史中存在未闭合的 tool_call（如上次运行途中强行关闭服务），自动补齐占位响应
            for missing_id in expected_ids:
                if missing_id not in collected_ids:
                    healed.append(
                        ToolMessage(
                            tool_call_id=missing_id,
                            name=SUBMIT_REPLY_TOOL_NAME,
                            content="（上一轮工具调用已中断）",
                        )
                    )
            idx = lookahead
        else:
            idx += 1

    return healed


def create_deepseek_chat_model(config: Settings) -> ChatOpenAI:
    """创建对接 DeepSeek 官方接口的 ChatOpenAI 实例。"""
    kwargs: dict[str, Any] = {
        "model": config.deepseek_model,
        "api_key": config.effective_api_key,
        "base_url": config.effective_base_url,
        "timeout": config.deepseek_timeout_seconds,
        "max_retries": 1,
    }
    if config.deepseek_model != "deepseek-reasoner":
        kwargs["temperature"] = config.deepseek_temperature
    return ChatOpenAI(**kwargs)


def build_pet_graph(
    config: Settings,
    checkpointer: BaseCheckpointSaver | None = None,
    llm_override: Any | None = None,
):
    """
    构建并编译小鲸娘智能体的 LangGraph 状态图。
    支持注入 `checkpointer`（生产环境使用 `AsyncSqliteSaver`）以及测试替身 `llm_override`。
    """
    if llm_override is not None:
        bound_llm = llm_override
        fallback_plain_llm = llm_override
    else:
        base_llm = create_deepseek_chat_model(config)
        # deepseek-chat 强制使用工具调用（要么调外部工具，要么调 submit_pet_reply 输出结构化回复+动作），彻底杜绝空回复
        tool_choice = "auto" if config.deepseek_model == "deepseek-reasoner" else "required"
        bound_llm = base_llm.bind_tools(ALL_AGENT_TOOLS, tool_choice=tool_choice)
        fallback_plain_llm = base_llm

    async def agent_node(state: PetGraphState) -> dict[str, Any]:
        """核心推理节点：加载状态与近期对话记忆，调用 DeepSeek 决策工具或生成回复。"""
        system_prompt = build_system_prompt(
            mood=state.get("mood"),
            last_motion=state.get("last_motion"),
            pet_state=state.get("pet_state"),
        )
        llm_messages = prepare_llm_messages(
            messages=state.get("messages", []),
            max_rounds=config.max_history_rounds,
            system_prompt=system_prompt,
        )

        # 若外部工具循环已达上限，直接改用仅绑定 submit_pet_reply 的调用收敛答案
        loop_count = state.get("tool_loop_count", 0)
        if loop_count >= MAX_TOOL_LOOPS and llm_override is None:
            force_submit_llm = create_deepseek_chat_model(config).bind_tools(
                [ALL_AGENT_TOOLS[-1]],
                tool_choice="auto" if config.deepseek_model == "deepseek-reasoner" else "required",
            )
            response = await force_submit_llm.ainvoke(llm_messages)
        else:
            response = await bound_llm.ainvoke(llm_messages)

        # 极端情况兜底：若模型既没返回 tool_calls 也没返回文本，降级用无工具约束重试一次
        if isinstance(response, AIMessage) and not response.tool_calls and not str(response.content or "").strip():
            response = await fallback_plain_llm.ainvoke(llm_messages)

        return {"messages": [response]}

    async def tools_node(state: PetGraphState) -> dict[str, Any]:
        """外部工具执行节点：运行 `get_current_time` 等感知工具，并将结果封装为 ToolMessage 返回给 Agent。"""
        messages = state.get("messages", [])
        last_msg = messages[-1] if messages else None
        if not isinstance(last_msg, AIMessage) or not last_msg.tool_calls:
            return {}

        tool_messages: list[ToolMessage] = []
        for call in last_msg.tool_calls:
            tool_name = call.get("name", "")
            call_id = call.get("id", "")
            args = call.get("args") or {}

            if tool_name == SUBMIT_REPLY_TOOL_NAME:
                # 若大模型在同一批次同时调用了外部工具与 submit_pet_reply，提示先等外部工具结果再生成最终回复
                tool_messages.append(
                    ToolMessage(
                        tool_call_id=call_id,
                        name=tool_name,
                        content="外部感知工具已执行，请结合最新工具结果重新调用 submit_pet_reply 回复主人。",
                    )
                )
                continue

            target_tool = EXTERNAL_TOOL_MAP.get(tool_name)
            if target_tool is None:
                observation = f"未知工具：{tool_name}"
            else:
                try:
                    observation = str(await target_tool.ainvoke(args))
                except Exception as exc:
                    observation = f"工具 {tool_name} 执行出错：{exc}"

            tool_messages.append(
                ToolMessage(
                    tool_call_id=call_id,
                    name=tool_name,
                    content=observation,
                )
            )

        return {
            "messages": tool_messages,
            "tool_loop_count": state.get("tool_loop_count", 0) + 1,
        }

    async def finalize_node(state: PetGraphState) -> dict[str, Any]:
        """
        收尾结算节点：
        1. 从 `submit_pet_reply` 工具参数（或纯文本回退）提取回复文本与桌宠控制指令；
        2. 为所有 `submit_pet_reply` 调用补齐闭合的 `ToolMessage`，保证 SQLite 历史消息链严格符合 OpenAI/DeepSeek 规范；
        3. 更新小鲸娘的持续情绪 `mood` 与 `last_motion`。
        """
        messages = state.get("messages", [])
        last_msg = messages[-1] if messages else None

        reply_text = "唔，我刚刚走神了一下，能再说一遍吗？"
        sanitized_action = None
        closing_tool_messages: list[ToolMessage] = []

        if isinstance(last_msg, AIMessage) and last_msg.tool_calls:
            for call in last_msg.tool_calls:
                call_id = call.get("id", "")
                call_name = call.get("name", "")
                args = call.get("args") or {}
                if call_name == SUBMIT_REPLY_TOOL_NAME:
                    candidate_reply = str(args.get("reply") or "").strip()
                    if candidate_reply:
                        reply_text = candidate_reply
                    sanitized_action = sanitize_pet_action(args)
                    closing_tool_messages.append(
                        ToolMessage(
                            tool_call_id=call_id,
                            name=call_name,
                            content=f"已向主人回复：{reply_text}",
                        )
                    )
                else:
                    closing_tool_messages.append(
                        ToolMessage(
                            tool_call_id=call_id,
                            name=call_name,
                            content="已跳过超出循环上限的工具调用",
                        )
                    )
        elif isinstance(last_msg, AIMessage):
            raw_text = (
                last_msg.content
                if isinstance(last_msg.content, str)
                else str(last_msg.content or "")
            )
            reply_text, sanitized_action = parse_fallback_content(raw_text)

        next_mood = state.get("mood") or "happy"
        next_last_motion = state.get("last_motion")
        action_dict: dict[str, Any] | None = None

        if sanitized_action is not None:
            action_dict = sanitized_action.model_dump()
            if sanitized_action.expression and sanitized_action.expression != "neutral":
                next_mood = sanitized_action.expression
            if sanitized_action.motion:
                next_last_motion = sanitized_action.motion

        updates: dict[str, Any] = {
            "mood": next_mood,
            "last_motion": next_last_motion,
            "final_reply": reply_text,
            "final_action": action_dict,
            "tool_loop_count": 0,
        }
        if closing_tool_messages:
            updates["messages"] = closing_tool_messages
        return updates

    def route_after_agent(state: PetGraphState) -> Literal["tools", "finalize"]:
        """条件路由：若存在外部工具调用且未超循环上限则进入 `tools` 节点，否则进入 `finalize` 结算输出。"""
        messages = state.get("messages", [])
        last_msg = messages[-1] if messages else None
        loop_count = state.get("tool_loop_count", 0)

        if isinstance(last_msg, AIMessage) and last_msg.tool_calls and loop_count < MAX_TOOL_LOOPS:
            has_external_call = any(
                call.get("name") != SUBMIT_REPLY_TOOL_NAME for call in last_msg.tool_calls
            )
            if has_external_call:
                return "tools"
        return "finalize"

    workflow = StateGraph(PetGraphState)
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", tools_node)
    workflow.add_node("finalize", finalize_node)

    workflow.add_edge(START, "agent")
    workflow.add_conditional_edges(
        "agent",
        route_after_agent,
        {
            "tools": "tools",
            "finalize": "finalize",
        },
    )
    workflow.add_edge("tools", "agent")
    workflow.add_edge("finalize", END)

    return workflow.compile(checkpointer=checkpointer)
