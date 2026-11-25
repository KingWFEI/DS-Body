"""
前后端通信的数据契约定义（Pydantic Schemas）。

这里定义的动作、表情、移动预设均与前端 `desktop-pet` 中的 `window.character` 控制接口严格对齐。
"""

from typing import Any, Literal
from pydantic import BaseModel, Field

# 前端支持的屏幕移动预设方向
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

# BlueFatFish.vrm 模型内置支持的主要情绪表情
EmotionName = Literal[
    "neutral",
    "happy",
    "angry",
    "sad",
    "relaxed",
    "surprised",
]


class PetAction(BaseModel):
    """伴随对话回复下发给前端 3D 桌宠的角色控制指令。"""

    motion: str | None = Field(
        default=None,
        description="VRMA 动作路径（例如 'attention/wave hand 1'、'dance/dance1'），不切换动作时为 null",
    )
    expression: EmotionName | None = Field(
        default=None,
        description="VRM 情绪表情名称（如 'happy'、'surprised'、'neutral'）",
    )
    expression_weight: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        description="表情强度权重，取值范围 0.0 ~ 1.0",
    )
    move_preset: MovePreset | None = Field(
        default=None,
        description="屏幕预设位置移动指令（仅在用户要求桌宠移动位置时填写）",
    )


class ChatRequest(BaseModel):
    """来自桌宠对话窗口的聊天请求体。"""

    message: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="用户输入的聊天文本",
    )
    session_id: str = Field(
        default="default",
        min_length=1,
        max_length=64,
        description="会话唯一标识，用于隔离多轮对话上下文记忆",
    )
    pet_state: dict[str, Any] | None = Field(
        default=None,
        description="可选的桌宠当前状态快照（如当前位置、正在播放的动作等）",
    )


class ChatResponse(BaseModel):
    """后端智能体返回给桌宠客户端的对话结果。"""

    session_id: str = Field(description="当前会话 ID")
    reply: str = Field(description="小鲸娘展示在对话框中的文字回复")
    action: PetAction | None = Field(
        default=None,
        description="需要前端桌宠同步执行的动作、表情或移动指令",
    )
    using_mock: bool = Field(
        default=False,
        description="是否为未配置 DeepSeek 密钥时的本地演示回复",
    )


class ClearSessionRequest(BaseModel):
    """清空指定会话上下文历史的请求体。"""

    session_id: str = Field(default="default", min_length=1, max_length=64, description="要清空的会话 ID")


class ClearSessionResponse(BaseModel):
    """清空会话历史的响应结果。"""

    session_id: str = Field(description="已清空的会话 ID")
    cleared: bool = Field(description="是否成功清空")


class HealthResponse(BaseModel):
    """后端服务健康检查与配置状态响应（不会暴露密钥明文）。"""

    status: str = Field(description="服务运行状态，正常为 'ok'")
    service: str = Field(description="服务名称")
    model: str = Field(description="当前配置的 DeepSeek 模型名称")
    api_key_configured: bool = Field(description="是否已配置有效的 DeepSeek API 密钥")
