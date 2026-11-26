/**
 * 模型右上角独立透明回答气泡渲染控制。
 *
 * 功能说明：
 * 1. 支持左/右侧自适应尾巴朝向（模型靠屏幕右边缘时由主进程自动切为左侧展示）。
 * 2. 支持“思考识别中”过渡态与正式回复的逐字打字机动画。
 * 3. 根据回复字数自动计算阅读停留时间（4.2s ~ 9.5s），到期平滑淡出并隐藏透明子窗口。
 */

const stageEl = document.querySelector("#bubbleStage");
const bubbleEl = document.querySelector("#speechBubble");
const heardEl = document.querySelector("#heardLine");
const replyEl = document.querySelector("#replyText");

let typingTimer = null;
let autoHideTimer = null;
let finishHideTimer = null;

/** 清理上一条气泡尚未跑完的定时器，保证连续对话切换干净利落。 */
function clearAllTimers() {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
  if (finishHideTimer) {
    clearTimeout(finishHideTimer);
    finishHideTimer = null;
  }
}

/** 更新气泡在模型左侧还是右侧，切换小尾巴指向。 */
function applySide(side) {
  const normalized = side === "left" ? "left" : "right";
  stageEl.className = `bubble-stage side-${normalized}`;
}

/** 启动平滑淡出动画，并在动画结束后通知 Electron 主进程隐藏子窗口。 */
function startHideBubble() {
  clearAllTimers();
  bubbleEl.classList.remove("visible");
  bubbleEl.classList.add("hiding");

  finishHideTimer = setTimeout(() => {
    bubbleEl.hidden = true;
    bubbleEl.classList.remove("hiding", "thinking");
    globalThis.__bubbleWindowBridge?.hideBubbleWindow?.();
  }, 240);
}

/** 渲染新一轮气泡内容（思考态或回答打字机态）。 */
function renderBubble(payload = {}) {
  clearAllTimers();
  if (payload.side) {
    applySide(payload.side);
  }

  const text = String(payload.text || "").trim();
  if (!text) {
    startHideBubble();
    return;
  }

  const userText = String(payload.userText || "").trim();
  if (userText) {
    heardEl.hidden = false;
    heardEl.textContent = `🎙️ “${userText}”`;
  } else {
    heardEl.hidden = true;
    heardEl.textContent = "";
  }

  const isThinking = payload.mode === "thinking";
  bubbleEl.hidden = false;
  bubbleEl.classList.remove("hiding");
  bubbleEl.classList.toggle("thinking", isThinking);

  // 触发下一帧进入动画
  requestAnimationFrame(() => {
    bubbleEl.classList.add("visible");
  });

  if (isThinking) {
    replyEl.textContent = text;
    // 思考态最长兜底保留 25s，正常情况下会被随后到达的正式回复立即替换
    autoHideTimer = setTimeout(startHideBubble, 25000);
    return;
  }

  // 打字机逐字浮现：短句细腻（28ms/字），长句自动提速避免等待过久
  const chars = Array.from(text);
  const stepMs = chars.length > 60 ? 16 : 26;
  let index = 0;
  replyEl.textContent = "";

  typingTimer = setInterval(() => {
    index += 1;
    replyEl.textContent = chars.slice(0, index).join("");
    if (index >= chars.length) {
      clearInterval(typingTimer);
      typingTimer = null;
      const holdMs = Math.min(Math.max(chars.length * 180, 4200), 9500);
      autoHideTimer = setTimeout(startHideBubble, holdMs);
    }
  }, stepMs);
}

globalThis.__bubbleWindowBridge?.onBubbleUpdate?.(renderBubble);
globalThis.__bubbleWindowBridge?.onBubbleSideChanged?.(applySide);
