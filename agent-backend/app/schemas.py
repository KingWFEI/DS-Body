from typing import Any, Literal
from pydantic import BaseModel, Field

MovePreset = Literal[
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
]


class PetAction(BaseModel):
    """对应前端 window.character 控制接口的动作与状态指令。"""

    motion: str | None = Field(default=None, description="VRMA 动作路径，如 attention/wave hand 1")
    expression: str | None = Field(default=None, description="VRM 表情名称，如 happy")
    expression_weight: float = Field(default=1.0, ge=0.0, le=1.0, description="表情权重 (0~1)")
    move_preset: MovePreset | None = Field(default=None, description="预设屏幕位置移动指令")


class ChatRequest(BaseModel):
    """来自桌宠对话窗口的聊天请求。"""

    message: str = Field(..., min_length=1, description="用户输入文本")
    session_id: str = Field(default="default", description="会话 ID")
    pet_state: dict[str, Any] | None = Field(
        default=None,
        description="可选的桌宠当前状态快照（由 window.character.getState() 提供）",
    )


class ChatResponse(BaseModel):
    """返回给桌宠客户端的文本回复及伴随角色动作。"""

    session_id: str
    reply: str
    action: PetAction | None = None
