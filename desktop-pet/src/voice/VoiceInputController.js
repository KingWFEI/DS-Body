/**
 * 桌宠右下角语音输入、实时声波纹动画与自动静音发送控制器。
 *
 * 交互流程：
 * 1. 点击右下角 🎙️ 按钮开启麦克风，展开声波纹胶囊，9 根音柱随真实说话音量与频谱跳动。
 * 2. 内置轻量 VAD（语音活动检测）：检测到开口说话后，连续停顿约 1.3 秒自动结束录音并上传；
 *    再次点击 🎙️ 按钮也可立即提前结束并发送；点击胶囊上的 ✕ 则取消本次录音。
 * 3. 上传至后端 `POST /api/v1/voice/chat`（离线 faster-whisper + LangGraph），
 *    在模型右上角弹出思考气泡与打字机回答气泡，同时驱动 3D 模型做出对应动作和表情。
 */

import {
  downsampleTo16kMono,
  encodeWav16kMono,
  getSharedSessionId,
  mergeFloat32Chunks,
} from "../utils/wavEncoder.js";

const API_BASE_URL = (import.meta.env.VITE_AGENT_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");
const historyChannel =
  typeof globalThis.BroadcastChannel === "function"
    ? new globalThis.BroadcastChannel("ds-body:history-updated")
    : null;

// 语音检测阈值与时间参数
const SPEECH_START_RMS = 0.02; // 判定开始说话的音量均方根阈值
const SPEECH_HOLD_RMS = 0.013; // 说话延续阈值（双阈值滞回防抖）
const SILENCE_AUTO_SEND_MS = 1300; // 说完停顿 1.3s 自动发送
const INITIAL_NO_SPEECH_TIMEOUT_MS = 8500; // 打开麦克风 8.5s 完全未说话则自动收起
const MAX_RECORD_DURATION_MS = 30000; // 单条语音最长 30s 自动截断发送

export function createVoiceInputController({
  voiceButton,
  capsuleElement,
  waveBars,
  labelElement,
  cancelButton,
  character,
  onLayoutChanged,
  setStatus,
}) {
  let mode = "idle"; // "idle" | "listening" | "processing"
  let mediaStream = null;
  let audioContext = null;
  let sourceNode = null;
  let analyserNode = null;
  let processorNode = null;
  let muteGainNode = null;
  let waveAnimFrame = null;

  let pcmChunks = [];
  let inputSampleRate = 48000;
  let latestRms = 0;
  let startedAt = 0;
  let hasDetectedSpeech = false;
  let speechOnsetFrames = 0;
  let lastVoiceActivityAt = 0;

  /** 更新按钮与声波纹胶囊的视觉状态并通知窗口穿透区域刷新。 */
  function updateUiState(nextMode, labelText = "") {
    mode = nextMode;
    const isListening = nextMode === "listening";
    const isProcessing = nextMode === "processing";
    const showCapsule = isListening || isProcessing;

    voiceButton.classList.toggle("recording", isListening);
    voiceButton.classList.toggle("processing", isProcessing);
    voiceButton.disabled = isProcessing;
    voiceButton.setAttribute("aria-pressed", String(isListening));
    voiceButton.title = isListening ? "点击立即发送语音" : "语音对话";

    capsuleElement.hidden = !showCapsule;
    capsuleElement.classList.toggle("is-processing", isProcessing);
    cancelButton.hidden = !isListening;
    if (labelText) {
      labelElement.textContent = labelText;
    }
    onLayoutChanged?.();
  }

  /** 释放麦克风流与 Web Audio 节点资源。 */
  function cleanupAudioResources() {
    if (waveAnimFrame !== null) {
      cancelAnimationFrame(waveAnimFrame);
      waveAnimFrame = null;
    }
    try {
      processorNode?.disconnect();
      analyserNode?.disconnect();
      sourceNode?.disconnect();
      muteGainNode?.disconnect();
    } catch {
      // 忽略已断开节点的异常
    }
    processorNode = null;
    analyserNode = null;
    sourceNode = null;
    muteGainNode = null;

    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {});
    }
    audioContext = null;

    // 重置音柱高度
    for (const bar of waveBars) {
      bar.style.transform = "scaleY(0.18)";
    }
  }

  /** 60fps 驱动声波纹跳动并检查静音自动发送条件。 */
  function tickWaveform() {
    if (mode !== "listening" || !analyserNode) return;
    waveAnimFrame = requestAnimationFrame(tickWaveform);

    const freqData = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(freqData);

    const barCount = waveBars.length;
    for (let i = 0; i < barCount; i += 1) {
      // 取人声核心频段（低中频为主）并做对称波峰分布，视觉更灵动
      const mirrorIndex = Math.abs(i - Math.floor(barCount / 2));
      const binIndex = Math.min(freqData.length - 1, mirrorIndex * 2 + 1);
      const energy = freqData[binIndex] / 255;
      const rmsBoost = Math.min(1, latestRms * 9);
      const scale = Math.max(0.18, Math.min(1, energy * 0.72 + rmsBoost * 0.45));
      waveBars[i].style.transform = `scaleY(${scale.toFixed(3)})`;
    }

    const now = performance.now();
    const elapsedSec = Math.floor((now - startedAt) / 1000);

    if (hasDetectedSpeech) {
      labelElement.textContent = `聆听中 ${String(elapsedSec).padStart(2, "0")}s`;
      if (now - lastVoiceActivityAt >= SILENCE_AUTO_SEND_MS) {
        void finishAndSendRecording();
        return;
      }
    } else {
      labelElement.textContent = "请说话…";
      if (now - startedAt >= INITIAL_NO_SPEECH_TIMEOUT_MS) {
        cancelRecording("未检测到说话声，已自动收起麦克风");
        void character.showSpeechBubble?.({
          text: "没听到声音哦，想聊天随时再点麦克风叫我～🎤",
          mode: "reply",
        });
        return;
      }
    }

    if (now - startedAt >= MAX_RECORD_DURATION_MS) {
      void finishAndSendRecording();
    }
  }

  /** 启动麦克风采集与实时声波纹。 */
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("当前环境不支持麦克风语音采集");
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx();
      inputSampleRate = audioContext.sampleRate || 48000;

      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 64;
      analyserNode.smoothingTimeConstant = 0.72;

      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      muteGainNode = audioContext.createGain();
      muteGainNode.gain.value = 0;

      pcmChunks = [];
      latestRms = 0;
      startedAt = performance.now();
      hasDetectedSpeech = false;
      speechOnsetFrames = 0;
      lastVoiceActivityAt = startedAt;

      processorNode.onaudioprocess = (audioEvent) => {
        if (mode !== "listening") return;
        const channelData = audioEvent.inputBuffer.getChannelData(0);
        const copy = new Float32Array(channelData.length);
        copy.set(channelData);
        pcmChunks.push(copy);

        let sumSquares = 0;
        for (let i = 0; i < copy.length; i += 1) {
          sumSquares += copy[i] * copy[i];
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, copy.length));
        latestRms = rms;

        const now = performance.now();
        if (!hasDetectedSpeech) {
          if (rms >= SPEECH_START_RMS) {
            speechOnsetFrames += 1;
            if (speechOnsetFrames >= 2) {
              hasDetectedSpeech = true;
              lastVoiceActivityAt = now;
            }
          } else {
            speechOnsetFrames = 0;
          }
        } else if (rms >= SPEECH_HOLD_RMS) {
          lastVoiceActivityAt = now;
        }
      };

      sourceNode.connect(analyserNode);
      analyserNode.connect(processorNode);
      processorNode.connect(muteGainNode);
      muteGainNode.connect(audioContext.destination);

      updateUiState("listening", "请说话…");
      setStatus("麦克风已开启，说完停顿约 1.3 秒自动发送…");
      tickWaveform();
    } catch (error) {
      cleanupAudioResources();
      updateUiState("idle");
      const msg = `无法打开麦克风：${error.message}`;
      setStatus(msg);
      void character.showSpeechBubble?.({
        text: "打不开麦克风权限呢，请检查系统麦克风设置哦～",
        mode: "reply",
      });
    }
  }

  /** 取消当前录音，不上传后端。 */
  function cancelRecording(reason = "已取消语音输入") {
    pcmChunks = [];
    cleanupAudioResources();
    updateUiState("idle");
    setStatus(reason);
  }

  /** 结束采集、编码为 16kHz WAV 并发送给后端智能体。 */
  async function finishAndSendRecording() {
    if (mode !== "listening") return;

    const recordedChunks = pcmChunks;
    const sampleRate = inputSampleRate;
    pcmChunks = [];
    cleanupAudioResources();

    const merged = mergeFloat32Chunks(recordedChunks);
    const durationSeconds = merged.length / Math.max(1, sampleRate);
    if (durationSeconds < 0.28) {
      updateUiState("idle");
      setStatus("录音时间太短，已忽略");
      return;
    }

    updateUiState("processing", "识别思考中…");
    void character.showSpeechBubble?.({
      text: "正在努力听写思考中…",
      mode: "thinking",
    });

    try {
      const samples16k = downsampleTo16kMono(merged, sampleRate);
      const wavBuffer = encodeWav16kMono(samples16k);
      const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });

      const formData = new FormData();
      formData.append("audio", wavBlob, "voice.wav");
      formData.append("session_id", getSharedSessionId());

      const response = await fetch(`${API_BASE_URL}/api/v1/voice/chat`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson?.detail) detail = errJson.detail;
        } catch {
          // 保持状态码提示
        }
        throw new Error(detail);
      }

      const data = await response.json();
      const replyText = data.reply || "收到啦～";
      const recognizedText = data.recognized_text || "";

      // 1. 在模型右上角弹出回答气泡（附带识别到的用户语音原文小字）
      await character.showSpeechBubble?.({
        text: replyText,
        userText: recognizedText,
        mode: "reply",
      });

      // 2. 驱动 3D 模型执行单次动作、表情与移动
      if (data.action) {
        await character.applyAgentAction(data.action);
      }
      if (recognizedText) {
        historyChannel?.postMessage({ type: "updated" });
      }

      setStatus(recognizedText ? `语音识别：「${recognizedText}」` : "未识别到清晰语音");
    } catch (error) {
      setStatus(`语音对话失败：${error.message}`);
      await character.showSpeechBubble?.({
        text: `连接语音后端失败啦（${error.message}），请确认 agent-backend 已启动哦～`,
        mode: "reply",
      });
    } finally {
      updateUiState("idle");
    }
  }

  /** 处理右下角麦克风按钮点击：空闲时开启，录音中再次点击立即发送。 */
  function handleToggleClick() {
    if (mode === "idle") {
      void startRecording();
    } else if (mode === "listening") {
      void finishAndSendRecording();
    }
  }

  voiceButton.addEventListener("click", handleToggleClick);
  cancelButton.addEventListener("click", () => cancelRecording());

  return {
    dispose() {
      voiceButton.removeEventListener("click", handleToggleClick);
      cleanupAudioResources();
    },
  };
}
