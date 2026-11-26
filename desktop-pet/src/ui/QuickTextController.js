/**
 * 桌宠底部单行悬浮文字输入框控制器。
 *
 * 交互设计：
 * 1. 点击右下角 💬 按钮，在桌宠脚底弹出轻巧的单行圆角输入框并自动聚焦；再次点击 💬 或按 Esc 收起。
 * 2. 输入完成后按 Enter 或点击 ➤ 发送，**立即自动隐藏输入框**，不留多余界面遮挡桌面。
 * 3. 与语音输入一样，统一通过模型右上角的透明气泡展示思考态与打字机回答，并同步触发角色动作/表情。
 */

import { getSharedSessionId } from "../utils/wavEncoder.js";

const API_BASE_URL = (import.meta.env.VITE_AGENT_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");
const historyChannel =
  typeof globalThis.BroadcastChannel === "function"
    ? new globalThis.BroadcastChannel("ds-body:history-updated")
    : null;

export function createQuickTextController({
  toggleButton,
  composerForm,
  inputElement,
  character,
  onLayoutChanged,
  setStatus,
}) {
  let isComposing = false;
  let isSending = false;

  /** 切换底部单行输入框显示/隐藏，并同步通知 Electron 刷新鼠标穿透矩形。 */
  function setVisible(visible) {
    composerForm.hidden = !visible;
    toggleButton.classList.toggle("active", visible);
    toggleButton.setAttribute("aria-expanded", String(visible));
    onLayoutChanged?.();

    if (visible) {
      requestAnimationFrame(() => {
        inputElement.focus();
      });
    }
  }

  function handleToggleClick() {
    setVisible(composerForm.hidden);
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && !isComposing) {
      event.preventDefault();
      setVisible(false);
    }
  }

  /** 提交单行消息：立即收起输入框 -> 弹出右上角气泡回复 -> 触发桌宠动作。 */
  async function handleSubmit(event) {
    event.preventDefault();
    if (isComposing || isSending) return;

    const text = inputElement.value.trim();
    if (!text) {
      setVisible(false);
      return;
    }

    // 发送瞬间立即清空并隐藏输入框，保持桌面干净清爽
    inputElement.value = "";
    setVisible(false);

    isSending = true;
    void character.showSpeechBubble?.({
      text: "正在思考中…",
      mode: "thinking",
    });

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: getSharedSessionId(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const replyText = data.reply || "收到啦～";

      await character.showSpeechBubble?.({
        text: replyText,
        mode: "reply",
      });

      if (data.action) {
        await character.applyAgentAction(data.action);
      }
      historyChannel?.postMessage({ type: "updated" });
    } catch (error) {
      setStatus(`文字发送失败：${error.message}`);
      await character.showSpeechBubble?.({
        text: `连接智能体后端失败啦（${error.message}），请确认 agent-backend 已启动哦～`,
        mode: "reply",
      });
    } finally {
      isSending = false;
    }
  }

  const onCompositionStart = () => { isComposing = true; };
  const onCompositionEnd = () => { isComposing = false; };

  toggleButton.addEventListener("click", handleToggleClick);
  composerForm.addEventListener("submit", handleSubmit);
  inputElement.addEventListener("keydown", handleKeyDown);
  inputElement.addEventListener("compositionstart", onCompositionStart);
  inputElement.addEventListener("compositionend", onCompositionEnd);

  return {
    hide: () => setVisible(false),
    dispose() {
      toggleButton.removeEventListener("click", handleToggleClick);
      composerForm.removeEventListener("submit", handleSubmit);
      inputElement.removeEventListener("keydown", handleKeyDown);
      inputElement.removeEventListener("compositionstart", onCompositionStart);
      inputElement.removeEventListener("compositionend", onCompositionEnd);
    },
  };
}
