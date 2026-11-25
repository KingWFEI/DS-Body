"""
后端全局配置模块。

密钥填写方式（任选其一，强烈推荐方式一）：
1. 【推荐】直接打开 `agent-backend/.env` 文件，修改 `DEEPSEEK_API_KEY=sk-...`
   （`.env` 已被 Git 忽略，不会把你的真实密钥意外推送到公开 GitHub 仓库）。
2. 若仅在本地临时调试，也可修改下方 `FALLBACK_DEEPSEEK_API_KEY` 常量，但切勿提交到公开仓库！
"""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# 定位 agent-backend 目录，确保从任意工作目录启动都能正确定位 .env 和本地 SQLite 数据库
BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE_PATH = BASE_DIR / ".env"

# 默认占位符文本，用于检测用户是否尚未填入真实密钥
API_KEY_PLACEHOLDER = "sk-请在这里填入你的DeepSeek密钥"

# 备用代码内密钥占位（优先使用 .env 中的 DEEPSEEK_API_KEY；注意不要将真实密钥提交至公开仓库）
FALLBACK_DEEPSEEK_API_KEY = "sk-请在这里填入你的DeepSeek密钥"


class Settings(BaseSettings):
    """应用运行参数、DeepSeek 模型参数与本地 SQLite 记忆库配置。"""

    # 服务基础信息
    app_name: str = "DS-Body Agent Backend"
    app_version: str = "0.3.0"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    # DeepSeek 大模型配置（自动映射同名大写环境变量，如 DEEPSEEK_API_KEY）
    deepseek_api_key: str = API_KEY_PLACEHOLDER
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    deepseek_temperature: float = 0.8
    deepseek_timeout_seconds: float = 45.0

    # 会话上下文裁剪与本地 SQLite 持久化路径
    max_history_rounds: int = 10
    sqlite_db_path: str = "data/pet_memory.sqlite"

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        """将逗号分隔的跨域白名单解析为字符串列表。"""
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def effective_api_key(self) -> str:
        """获取实际生效的 DeepSeek API Key（优先读取环境变量/.env，其次读取代码备用占位）。"""
        env_key = self.deepseek_api_key.strip()
        if env_key and env_key != API_KEY_PLACEHOLDER:
            return env_key
        return FALLBACK_DEEPSEEK_API_KEY.strip()

    @property
    def has_valid_api_key(self) -> bool:
        """判断当前是否已填入非占位的有效密钥格式。"""
        key = self.effective_api_key
        if not key:
            return False
        invalid_placeholders = {
            API_KEY_PLACEHOLDER,
            "your_deepseek_api_key_here",
            "sk-your-api-key",
        }
        return key not in invalid_placeholders and not key.startswith("sk-请在这里")

    @property
    def effective_base_url(self) -> str:
        """规范化 DeepSeek API 基础 URL，兼容 OpenAI SDK 协议。"""
        return self.deepseek_base_url.rstrip("/")

    @property
    def resolved_sqlite_path(self) -> str:
        """
        解析本地 SQLite 数据库连接路径：
        - `:memory:` 原样返回（供单元测试使用内存库）；
        - 相对路径自动相对于 `agent-backend/` 目录解析，并确保父目录存在。
        """
        raw = self.sqlite_db_path.strip()
        if raw == ":memory:":
            return ":memory:"
        path = Path(raw)
        if not path.is_absolute():
            path = (BASE_DIR / path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return str(path)


settings = Settings()
