/**
 * 历史聊天对话查看面板逻辑（读取后端本地 SQLite `chat_messages` 持久化数据）。
 *
 * 特性：
 * 1. 按时间顺序展示所有文字输入（⌨️）与语音输入（🎙️）的问答记录、入库时间及触发的动作表情。
 * 2. 监听跨窗口广播与窗口聚焦事件，在主窗口发送新消息后自动同步刷新列表。
 * 3. 支持在此窗口直接一键清空 SQLite 中的历史记录与对话记忆。
 */

import { getSharedSessionId } from "./utils/wavEncoder.js";

const API_BASE_URL = (import.meta.env.VITE_AGENT_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");
const sessionId = getSharedSessionId();

const summaryEl = document.querySelector("#historySummary");
const listEl = document.querySelector("#historyList");
const refreshBtn = document.querySelector("#refreshBtn");
const clearBtn = document.querySelector("#clearHistoryBtn");

function renderEmpty(message) {
  listEl.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = message;
  listEl.appendChild(div);
}

function renderItems(items) {
  listEl.innerHTML = "";
  if (!items.length) {
    renderEmpty("SQLite 中还没有聊天记录哦～\n点击桌宠右下角的 💬 或 🎙️ 和小鲸娘聊几句吧！");
    return;
  }

  for (const item of items) {
    const row = document.createElement("article");
    const isUser = item.role === "user";
    row.className = `record-item ${isUser ? "user" : "assistant"}`;

    const meta = document.createElement("div");
    meta.className = "record-meta";
    const sourceBadge = isUser ? (item.source === "voice" ? "🎙️ 语音" : "⌨️ 文字") : "🐳 小鲸娘";
    meta.textContent = `${sourceBadge} · ${item.created_at}`;
    row.appendChild(meta);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = item.content;
    row.appendChild(bubble);

    if (!isUser && (item.motion || item.expression)) {
      const parts = [];
      if (item.motion) parts.push(`动作: ${item.motion}`);
      if (item.expression) parts.push(`表情: ${item.expression}`);
      const badge = document.createElement("span");
      badge.className = "action-badge";
      badge.textContent = `✨ ${parts.join(" · ")}`;
      row.appendChild(badge);
    }

    listEl.appendChild(row);
  }

  listEl.scrollTop = listEl.scrollHeight;
}

/** 从后端 SQLite 历史接口拉取当前会话的消息记录。 */
async function loadHistory() {
  try {
    const url = `${API_BASE_URL}/api/v1/chat/history?session_id=${encodeURIComponent(sessionId)}&limit=300`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    summaryEl.textContent = `本地 SQLite 已持久化 ${items.length} 条消息`;
    renderItems(items);
  } catch (error) {
    summaryEl.textContent = "无法连接后端服务";
    renderEmpty(`读取 SQLite 历史记录失败（${error.message}）\n请确认 agent-backend 已启动（8000 端口）`);
  }
}

async function handleClearHistory() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/chat/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await loadHistory();
  } catch (error) {
    summaryEl.textContent = `清空失败：${error.message}`;
  }
}

refreshBtn.addEventListener("click", () => void loadHistory());
clearBtn.addEventListener("click", () => void handleClearHistory());
window.addEventListener("focus", () => void loadHistory());

if (typeof globalThis.BroadcastChannel === "function") {
  const channel = new globalThis.BroadcastChannel("ds-body:history-updated");
  channel.addEventListener("message", () => void loadHistory());
}

void loadHistory();
