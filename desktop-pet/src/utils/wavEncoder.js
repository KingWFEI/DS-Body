/**
 * 语音录制 PCM 降采样与 16kHz 单声道 WAV 编码工具，以及跨窗口共享会话 ID 工具。
 *
 * 直接在前端输出标准 16kHz / 16-bit / Mono PCM WAV，可让后端 `faster-whisper` 零转码直接读取波形数组。
 */

const SHARED_SESSION_KEY = "ds-body:shared-session-id";
const TARGET_SAMPLE_RATE = 16000;

/**
 * 获取或创建主窗口（语音输入）与对话子窗口（文字输入）共享的会话 ID，
 * 确保两边共用同一个本地 SQLite 持久化记忆线程。
 */
export function getSharedSessionId(storage = globalThis.localStorage) {
  try {
    const existing = storage?.getItem(SHARED_SESSION_KEY);
    if (existing) return existing;
    const created = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    storage?.setItem(SHARED_SESSION_KEY, created);
    return created;
  } catch {
    return "default";
  }
}

/** 将多段 Float32Array 录音分片拼接为连续单声道数组。 */
export function mergeFloat32Chunks(chunks) {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** 将浏览器原始采样率（通常为 48000Hz 或 44100Hz）均值降采样至 16000Hz 单声道。 */
export function downsampleTo16kMono(samples, inputSampleRate) {
  if (!samples || samples.length === 0) return new Float32Array(0);
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || inputSampleRate === TARGET_SAMPLE_RATE) {
    return samples;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const result = new Float32Array(outputLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < outputLength) {
    const nextOffsetBuffer = Math.min(samples.length, Math.round((offsetResult + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      sum += samples[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? sum / count : samples[Math.min(offsetBuffer, samples.length - 1)];
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

/** 将 16kHz Float32 单声道波形编码为标准 44 字节 RIFF 头 + 16-bit PCM 的 WAV ArrayBuffer。 */
export function encodeWav16kMono(samples16k) {
  const numSamples = samples16k.length;
  const bytesPerSample = 2;
  const dataByteLength = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk 长度
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (单声道)
  view.setUint32(24, TARGET_SAMPLE_RATE, true); // SampleRate = 16000
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true); // ByteRate
  view.setUint16(32, bytesPerSample, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeAscii(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples16k[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }
  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
