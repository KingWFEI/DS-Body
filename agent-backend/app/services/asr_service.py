"""
本地离线语音转文字服务（基于 faster-whisper）。

核心设计：
1. 懒加载 + 线程锁保护：首次收到语音时才加载模型并缓存在内存中，不拖慢后端平时冷启动速度。
2. 国内网络友好：默认设置 `HF_ENDPOINT=https://hf-mirror.com`，首次自动下载权重到 `agent-backend/data/whisper_models`。
3. 硬件容错：若用户配置了 `cuda` 但本机缺少 cuBLAS 动态库，自动平滑降级到 `cpu (int8)` 运行。
4. 简体中文优化与幻觉过滤：通过 `initial_prompt` 强制引导输出简体中文标点，启用 Silero VAD 裁剪静音段，并过滤静音常见字幕幻觉词。
"""

import asyncio
import io
import logging
import os
import threading
import wave
from typing import Any

import numpy as np

from app.config import Settings, settings as default_settings

logger = logging.getLogger(__name__)

# Whisper 在纯背景底噪下常见的字幕组幻觉短语，命中时视为无效静音
HALLUCINATION_PHRASES: set[str] = {
    "字幕由Amara.org社区提供",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "谢谢观看",
    "感谢观看",
    "字幕制作",
    "优优独播剧场",
    "YoYo Television Series Exclusive",
}


class ASRService:
    """封装 faster-whisper 离线中文语音识别能力的服务类。"""

    def __init__(self, config: Settings = default_settings) -> None:
        self.settings = config
        self._model: Any | None = None
        self._load_lock = threading.Lock()

    def _ensure_model_loaded(self) -> Any:
        """在工作线程中线程安全地加载 WhisperModel，带设备降级保护。"""
        if self._model is not None:
            return self._model

        with self._load_lock:
            if self._model is not None:
                return self._model

            if self.settings.hf_endpoint and not os.environ.get("HF_ENDPOINT"):
                os.environ["HF_ENDPOINT"] = self.settings.hf_endpoint

            from faster_whisper import WhisperModel

            model_size = self.settings.whisper_model_size
            download_dir = self.settings.resolved_whisper_dir
            device = self.settings.whisper_device
            compute_type = self.settings.whisper_compute_type

            logger.info(
                "正在加载本地 faster-whisper 模型 (size=%s, device=%s, dir=%s)...",
                model_size,
                device,
                download_dir,
            )
            try:
                self._model = WhisperModel(
                    model_size,
                    device=device,
                    compute_type=compute_type,
                    download_root=download_dir,
                )
            except Exception as exc:
                if device != "cpu":
                    logger.warning("使用 %s 加载 Whisper 失败 (%s)，自动回退至 CPU int8 模式", device, exc)
                    self._model = WhisperModel(
                        model_size,
                        device="cpu",
                        compute_type="int8",
                        download_root=download_dir,
                    )
                else:
                    raise

            logger.info("faster-whisper 模型加载完成！")
            return self._model

    @staticmethod
    def _try_decode_16k_pcm_wav(audio_bytes: bytes) -> np.ndarray | None:
        """
        快速通道：若前端上传的是标准 16kHz / 16-bit / 单声道 PCM WAV，
        直接通过标准库零开销转为 float32 波形数组，无需调用 PyAV 重采样。
        """
        if len(audio_bytes) < 44 or audio_bytes[:4] != b"RIFF" or audio_bytes[8:12] != b"WAVE":
            return None
        try:
            with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
                if (
                    wf.getnchannels() == 1
                    and wf.getsampwidth() == 2
                    and wf.getframerate() == 16000
                    and wf.getcomptype() == "NONE"
                ):
                    frames = wf.readframes(wf.getnframes())
                    if not frames:
                        return np.zeros(0, dtype=np.float32)
                    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        except wave.Error:
            return None
        return None

    def _transcribe_sync(self, audio_bytes: bytes) -> str:
        """在后台线程池中执行音频解码与 faster-whisper 推理。"""
        if not audio_bytes or len(audio_bytes) < 256:
            return ""

        pcm_array = self._try_decode_16k_pcm_wav(audio_bytes)
        if pcm_array is not None:
            # 少于 0.15 秒的极短点击噪音直接忽略
            if pcm_array.size < 2400:
                return ""
            audio_input: Any = pcm_array
        else:
            audio_input = io.BytesIO(audio_bytes)

        model = self._ensure_model_loaded()
        segments, _info = model.transcribe(
            audio_input,
            language="zh",
            beam_size=3,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            condition_on_previous_text=False,
            initial_prompt="以下是普通话简体中文日常对话。",
        )

        text = "".join(segment.text for segment in segments).strip()
        if not text or text in HALLUCINATION_PHRASES:
            return ""
        return text

    async def transcribe(self, audio_bytes: bytes) -> str:
        """异步转写音频字节流为简体中文文本，不阻塞 FastAPI 主事件循环。"""
        return await asyncio.to_thread(self._transcribe_sync, audio_bytes)


asr_service = ASRService()
