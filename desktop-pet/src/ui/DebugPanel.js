import { createWindowInteraction } from "./WindowInteraction.js";
import { createQuickTextController } from "./QuickTextController.js";
import { getSharedSessionId } from "../utils/wavEncoder.js";
import { createVoiceInputController } from "../voice/VoiceInputController.js";

const API_BASE_URL = (import.meta.env.VITE_AGENT_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");

/**
 * 创建桌宠主界面浮层（极简设置卡片、右下角快捷操作栏、语音波纹胶囊、底部单行文字输入框），
 * 并将角色控制操作统一路由到 `window.character` 接口。
 */
export function createDebugPanel() {
  const app = document.querySelector("#app");
  if (!app) throw new Error("页面缺少 #app 容器");

  app.innerHTML = `
    <div id="viewport"></div>

    <aside id="panel" class="settings-card" data-mouse-interactive hidden aria-label="桌宠设置">
      <header class="settings-header">
        <div id="dragBar" class="settings-title">🐳 小鲸娘设置</div>
        <button id="closeSettings" class="icon-close" type="button" aria-label="关闭设置" title="关闭">✕</button>
      </header>

      <div id="agentHealthBadge" class="agent-status status-checking">正在检测智能体状态…</div>

      <div class="setting-row" aria-label="模型大小比例">
        <span class="setting-label">模型大小</span>
        <div class="scale-stepper">
          <button id="scaleDown" type="button" aria-label="缩小模型">−</button>
          <output id="scaleValue">100%</output>
          <button id="scaleUp" type="button" aria-label="放大模型">+</button>
          <button id="scaleReset" class="subtle-btn" type="button" title="恢复 100%">重置</button>
        </div>
      </div>

      <div class="setting-row">
        <span class="setting-label">窗口始终置顶</span>
        <button id="toggleAlwaysOnTop" class="switch-btn is-on" type="button" role="switch" aria-checked="true">已开启</button>
      </div>

      <button id="openHistory" class="history-entry-btn" type="button">📜 查看历史对话</button>

      <div class="setting-actions">
        <button id="goHome" type="button">🏠 回到原位</button>
        <button id="clearMemory" class="danger-subtle" type="button">🧹 清空记忆</button>
      </div>
    </aside>

    <div id="voiceWaveCapsule" class="voice-capsule" data-mouse-interactive hidden aria-live="polite">
      <span class="voice-dot" aria-hidden="true"></span>
      <div class="wave-bars" aria-hidden="true">
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
      </div>
      <span id="voiceStateLabel" class="voice-label">请说话…</span>
      <button id="cancelVoice" class="voice-cancel" type="button" aria-label="取消语音输入" title="取消">✕</button>
    </div>

    <form id="quickTextComposer" class="quick-composer" data-mouse-interactive hidden aria-label="文字输入">
      <input
        id="quickTextInput"
        type="text"
        maxlength="2000"
        placeholder="说点什么…（Enter 发送）"
        autocomplete="off"
      />
      <button id="quickTextSend" type="submit" aria-label="发送消息" title="发送">➤</button>
    </form>

    <nav id="controlRail" data-mouse-interactive aria-label="桌宠快捷操作">
      <button id="toggleDebug" class="rail-button" type="button" aria-label="打开设置面板" aria-expanded="false" title="设置">⚙</button>
      <button id="toggleChatInput" class="rail-button" type="button" aria-label="文字输入" aria-expanded="false" title="文字对话">💬</button>
      <button id="toggleVoice" class="rail-button" type="button" aria-label="开启语音输入" aria-pressed="false" title="语音对话">🎙️</button>
    </nav>
  `;

  const viewport = app.querySelector("#viewport");
  const panel = app.querySelector("#panel");
  const healthBadge = app.querySelector("#agentHealthBadge");
  const interaction = createWindowInteraction({ app, viewport });

  /** 保留状态回调签名供加载器与动画控制器输出控制台调试日志。 */
  function setStatus(message) {
    console.debug("[DesktopPet]", message);
  }

  /** 检测后端智能体在线及密钥配置状态，展示在设置面板顶部。 */
  async function refreshAgentHealth() {
    try {
      const response = await fetch(`${API_BASE_URL}/health`, { method: "GET" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.api_key_configured) {
        healthBadge.className = "agent-status status-online";
        healthBadge.textContent = `DeepSeek 已就绪 (${data.model})`;
      } else {
        healthBadge.className = "agent-status status-demo";
        healthBadge.textContent = "演示模式（待在 .env 填入密钥）";
      }
    } catch {
      healthBadge.className = "agent-status status-offline";
      healthBadge.textContent = "后端未连接（请启动 agent-backend）";
    }
  }

  function bindCharacterApi(character) {
    const debugButton = app.querySelector("#toggleDebug");
    const closeSettingsBtn = app.querySelector("#closeSettings");
    const alwaysOnTopBtn = app.querySelector("#toggleAlwaysOnTop");
    let alwaysOnTop = true;

    function setSettingsOpen(open) {
      panel.hidden = !open;
      debugButton.classList.toggle("active", open);
      debugButton.setAttribute("aria-expanded", String(open));
      interaction.refresh();
      if (open) {
        void refreshAgentHealth();
      }
    }

    debugButton.addEventListener("click", () => setSettingsOpen(panel.hidden));
    closeSettingsBtn.addEventListener("click", () => setSettingsOpen(false));

    // 初始化同步窗口置顶开关状态
    void character.getAlwaysOnTop?.().then((res) => {
      if (typeof res?.alwaysOnTop === "boolean") {
        alwaysOnTop = res.alwaysOnTop;
        syncAlwaysOnTopUi();
      }
    });

    function syncAlwaysOnTopUi() {
      alwaysOnTopBtn.classList.toggle("is-on", alwaysOnTop);
      alwaysOnTopBtn.setAttribute("aria-checked", String(alwaysOnTop));
      alwaysOnTopBtn.textContent = alwaysOnTop ? "已开启" : "已关闭";
    }

    alwaysOnTopBtn.addEventListener("click", async () => {
      const res = await character.setAlwaysOnTop(!alwaysOnTop);
      alwaysOnTop = Boolean(res?.alwaysOnTop ?? !alwaysOnTop);
      syncAlwaysOnTopUi();
    });

    // 模型缩放比例控制
    const scaleValue = app.querySelector("#scaleValue");
    const updateScale = (scale) => {
      scaleValue.value = `${Math.round(scale * 100)}%`;
    };
    app.querySelector("#scaleDown").addEventListener("click", () => {
      character.setModelScale(character.getModelScale() - 0.1);
    });
    app.querySelector("#scaleUp").addEventListener("click", () => {
      character.setModelScale(character.getModelScale() + 0.1);
    });
    app.querySelector("#scaleReset").addEventListener("click", () => {
      character.setModelScale(1);
    });

    // 打开独立 SQLite 历史聊天对话查看窗口
    app.querySelector("#openHistory").addEventListener("click", () => {
      setSettingsOpen(false);
      void character.openHistoryWindow?.().catch((error) => setStatus(`打开历史窗口失败：${error.message}`));
    });

    // 一键回到桌面初始原位
    app.querySelector("#goHome").addEventListener("click", () => {
      setSettingsOpen(false);
      void character.moveToPreset("home").catch((error) => setStatus(`返回原位失败：${error.message}`));
    });

    // 一键清空本地 SQLite 当前会话记忆，并通过右上角气泡给出温柔反馈
    app.querySelector("#clearMemory").addEventListener("click", async () => {
      setSettingsOpen(false);
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/chat/clear`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: getSharedSessionId() }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (typeof globalThis.BroadcastChannel === "function") {
          const ch = new globalThis.BroadcastChannel("ds-body:history-updated");
          ch.postMessage({ type: "cleared" });
          ch.close();
        }
        void character.showSpeechBubble?.({
          text: "好哒，之前的聊天记忆已经清空啦，我们重新开始聊吧～🐳",
          mode: "reply",
        });
        void character.applyAgentAction?.({
          motion: "attention/wave hand 1",
          expression: "happy",
        });
      } catch {
        void character.showSpeechBubble?.({
          text: "暂时连不上后端，等后端启动后再清空记忆吧～",
          mode: "reply",
        });
      }
    });

    // 底部单行文字输入控制器（发送后立即自动隐藏，走右上角气泡回答）
    const quickTextController = createQuickTextController({
      toggleButton: app.querySelector("#toggleChatInput"),
      composerForm: app.querySelector("#quickTextComposer"),
      inputElement: app.querySelector("#quickTextInput"),
      character,
      onLayoutChanged: () => interaction.refresh(),
      setStatus,
    });

    // 右下角实时声波纹语音输入控制器
    const voiceController = createVoiceInputController({
      voiceButton: app.querySelector("#toggleVoice"),
      capsuleElement: app.querySelector("#voiceWaveCapsule"),
      waveBars: [...app.querySelectorAll("#voiceWaveCapsule .wave-bar")],
      labelElement: app.querySelector("#voiceStateLabel"),
      cancelButton: app.querySelector("#cancelVoice"),
      character,
      onLayoutChanged: () => interaction.refresh(),
      setStatus,
    });

    const unsubscribeScale = character.onModelScaleChanged(updateScale);
    const unsubscribeDockPreview = globalThis.__desktopPetBridge?.onDockPreviewChanged?.((side) => {
      app.classList.toggle("dock-preview", Boolean(side));
      if (side) {
        setSettingsOpen(false);
        quickTextController.hide();
      }
    });
    return () => {
      unsubscribeScale();
      unsubscribeDockPreview?.();
      quickTextController.dispose();
      voiceController.dispose();
      interaction.dispose();
    };
  }

  return Object.freeze({
    viewport,
    setModelRegion: interaction.setModelRegion,
    setStatus,
    bindCharacterApi,
  });
}
