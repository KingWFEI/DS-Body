"""
智能体业务门面服务（对接 FastAPI 路由与底层 LangGraph + SQLite 记忆引擎）。

核心能力：
1. 管理本地 SQLite 异步连接与 `AsyncSqliteSaver` Checkpointer 生命周期，重启后端不丢失对话记忆与小鲸娘心情状态。
2. 按 `session_id`（映射为 LangGraph 的 `thread_id`）隔离并持久化多轮对话。
3. 支持一键从 SQLite 数据库彻底清理指定 `session_id` 的历史记录，并支持查询已持久化的消息快照。
4. 当尚未填入真实 DeepSeek 密钥时，自动走本地关键词演示模式；异常状态码（401/402/429/网络超时）转为友好的中文提示。
"""

import asyncio
from datetime import datetime
import logging
from typing import Any

import aiosqlite
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
import openai

from app.config import Settings, settings as default_settings
from app.graph.workflow import build_pet_graph
from app.schemas import ChatHistoryItem, ChatRequest, ChatResponse, PetAction

logger = logging.getLogger(__name__)


class AgentService:
    """管理小鲸娘 LangGraph 实例与本地 SQLite 记忆库的服务类。"""

    def __init__(
        self,
        config: Settings = default_settings,
        llm_override: Any | None = None,
    ) -> None:
        self.settings = config
        self._llm_override = llm_override
        self._conn: aiosqlite.Connection | None = None
        self._checkpointer: AsyncSqliteSaver | None = None
        self._graph: Any | None = None
        self._bound_loop: asyncio.AbstractEventLoop | None = None
        self._init_lock: asyncio.Lock | None = None

    async def initialize(self) -> None:
        """初始化异步 SQLite 连接、创建持久化表结构并编译 LangGraph 状态图。"""
        current_loop = asyncio.get_running_loop()

        # 若已经初始化且绑定在当前活跃的事件循环上，直接复用
        if (
            self._graph is not None
            and self._conn is not None
            and self._bound_loop is current_loop
            and not current_loop.is_closed()
        ):
            return

        if self._init_lock is None or self._bound_loop is not current_loop:
            self._init_lock = asyncio.Lock()

        async with self._init_lock:
            if (
                self._graph is not None
                and self._conn is not None
                and self._bound_loop is current_loop
            ):
                return

            # 若切换了事件循环（例如单元测试多次调用 asyncio.run），先安全释放旧引用
            if self._conn is not None:
                try:
                    await self._conn.close()
                except Exception:
                    pass
                self._conn = None

            db_path = self.settings.resolved_sqlite_path
            self._conn = await aiosqlite.connect(db_path)
            # 开启 WAL 日志模式提升本地并发读写稳定性（内存库除外）
            if db_path != ":memory:":
                await self._conn.execute("PRAGMA journal_mode=WAL;")
            self._checkpointer = AsyncSqliteSaver(self._conn)
            await self._checkpointer.setup()

            # 创建业务级历史聊天对话明细表，持久化每条问答的内容、输入方式（文字/语音）、动作与时间戳
            await self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'text',
                    motion TEXT,
                    expression TEXT,
                    created_at TEXT NOT NULL
                );
                """
            )
            await self._conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
                ON chat_messages (session_id, id);
                """
            )
            await self._conn.commit()

            self._graph = build_pet_graph(
                config=self.settings,
                checkpointer=self._checkpointer,
                llm_override=self._llm_override,
            )
            self._bound_loop = current_loop
            logger.info("LangGraph + SQLite 记忆引擎已就绪，数据库路径：%s", db_path)

    async def shutdown(self) -> None:
        """关闭底层 SQLite 异步连接，在 FastAPI 服务退出时调用。"""
        if self._conn is not None:
            try:
                await self._conn.close()
            except Exception as exc:
                logger.warning("关闭 SQLite 连接时出现异常: %s", exc)
            finally:
                self._conn = None
                self._checkpointer = None
                self._graph = None
                self._bound_loop = None

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """执行一轮桌宠对话：写入用户消息 -> 运行 LangGraph -> SQLite 双写入库 -> 返回回复与动作。"""
        user_text = request.message.strip()
        session_id = request.session_id
        source = request.source

        await self.initialize()

        # 未配置真实密钥且无测试替身时，走本地零配置演示模式，同样将对话记录写入 SQLite 历史表
        if not self.settings.has_valid_api_key and self._llm_override is None:
            demo_res = self._build_placeholder_response(session_id=session_id, user_text=user_text)
            await self._save_turn_to_sqlite(
                session_id=session_id,
                user_text=user_text,
                reply_text=demo_res.reply,
                source=source,
                action=demo_res.action,
            )
            return demo_res

        assert self._graph is not None

        runnable_config = {"configurable": {"thread_id": session_id}}

        try:
            final_state = await self._graph.ainvoke(
                {
                    "messages": [HumanMessage(content=user_text)],
                    "pet_state": request.pet_state,
                    "tool_loop_count": 0,
                    "final_reply": "",
                    "final_action": None,
                },
                config=runnable_config,
            )
        except openai.AuthenticationError:
            logger.error("DeepSeek API 密钥认证失败 (401)")
            return self._build_api_error_response(session_id=session_id, status_code=401)
        except openai.PermissionDeniedError:
            logger.error("DeepSeek API 权限拒绝 (403)")
            return self._build_api_error_response(session_id=session_id, status_code=403)
        except openai.RateLimitError:
            logger.error("DeepSeek API 触发限流 (429)")
            return self._build_api_error_response(session_id=session_id, status_code=429)
        except openai.APIStatusError as exc:
            logger.error("DeepSeek API 状态异常 (%s): %s", exc.status_code, exc.message)
            return self._build_api_error_response(session_id=session_id, status_code=exc.status_code)
        except openai.APITimeoutError:
            logger.error("请求 DeepSeek API 超时")
            return ChatResponse(
                session_id=session_id,
                reply="呜……连接大脑超时啦，请检查网络或稍后再试一次吧～",
                action=PetAction(expression="sad", expression_weight=0.8),
                using_mock=False,
            )
        except openai.APIConnectionError as exc:
            logger.error("请求 DeepSeek API 网络连接失败: %s", exc)
            return ChatResponse(
                session_id=session_id,
                reply="网络连接好像出了一点小状况，暂时连不上 DeepSeek 服务呢。",
                action=PetAction(expression="surprised", expression_weight=0.8),
                using_mock=False,
            )

        reply_text = str(final_state.get("final_reply") or "").strip() or "收到啦～"
        raw_action = final_state.get("final_action")
        pet_action = PetAction.model_validate(raw_action) if isinstance(raw_action, dict) else None

        # 将本轮用户消息与小鲸娘回复正式写入 SQLite `chat_messages` 历史记录表
        await self._save_turn_to_sqlite(
            session_id=session_id,
            user_text=user_text,
            reply_text=reply_text,
            source=source,
            action=pet_action,
        )

        return ChatResponse(
            session_id=session_id,
            reply=reply_text,
            action=pet_action,
            using_mock=False,
        )

    async def _save_turn_to_sqlite(
        self,
        session_id: str,
        user_text: str,
        reply_text: str,
        source: str,
        action: PetAction | None,
    ) -> None:
        """将一问一答原子写入 SQLite `chat_messages` 明细表。"""
        if self._conn is None:
            return
        now_str = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
        await self._conn.executemany(
            """
            INSERT INTO chat_messages (session_id, role, content, source, motion, expression, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?);
            """,
            [
                (session_id, "user", user_text, source, None, None, now_str),
                (
                    session_id,
                    "assistant",
                    reply_text,
                    source,
                    action.motion if action else None,
                    action.expression if action else None,
                    now_str,
                ),
            ],
        )
        await self._conn.commit()

    async def clear_session(self, session_id: str) -> bool:
        """从本地 SQLite 数据库中彻底删除指定 `session_id` 的 LangGraph 检查点与历史聊天记录表数据。"""
        await self.initialize()
        if self._checkpointer is None or self._conn is None:
            return False
        await self._checkpointer.adelete_thread(session_id)
        await self._conn.execute("DELETE FROM chat_messages WHERE session_id = ?;", (session_id,))
        await self._conn.commit()
        return True

    async def get_chat_history_items(
        self,
        session_id: str,
        limit: int = 200,
    ) -> list[ChatHistoryItem]:
        """从 SQLite `chat_messages` 表按时间顺序读取最近的 `limit` 条历史对话记录。"""
        await self.initialize()
        if self._conn is None:
            return []

        safe_limit = max(1, min(limit, 1000))
        cursor = await self._conn.execute(
            """
            SELECT id, session_id, role, content, source, motion, expression, created_at
            FROM (
                SELECT id, session_id, role, content, source, motion, expression, created_at
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC;
            """,
            (session_id, safe_limit),
        )
        rows = await cursor.fetchall()
        await cursor.close()

        return [
            ChatHistoryItem(
                id=row[0],
                session_id=row[1],
                role=row[2],
                content=row[3],
                source=row[4] if row[4] in ("text", "voice") else "text",
                motion=row[5],
                expression=row[6],
                created_at=row[7],
            )
            for row in rows
        ]

    async def get_history(self, session_id: str) -> list[dict[str, str]]:
        """获取简化的 `[{"role": ..., "content": ...}]` 历史对话列表，供快速调试与单元测试断言。"""
        items = await self.get_chat_history_items(session_id=session_id)
        return [{"role": item.role, "content": item.content} for item in items]

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
