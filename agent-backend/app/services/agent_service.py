from app.schemas import ChatRequest, ChatResponse, PetAction


class AgentService:
    """智能体核心编排服务骨架，后续在此接入 LLM、记忆与工具调用。"""

    async def chat(self, request: ChatRequest) -> ChatResponse:
        text = request.message.strip()
        return ChatResponse(
            session_id=request.session_id,
            reply=f"收到你的消息啦：「{text}」（后端智能体骨架已就绪，待接入大模型）",
            action=PetAction(
                motion="attention/wave hand 1",
                expression="happy",
                expression_weight=1.0,
            ),
        )


agent_service = AgentService()
