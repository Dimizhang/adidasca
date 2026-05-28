const state = {
  monitors: [],
  settings: null,
  toastTimer: null
};

const els = {
  activeCount: document.querySelector("#activeCount"),
  telegramState: document.querySelector("#telegramState"),
  totalCount: document.querySelector("#totalCount"),
  latestPrice: document.querySelector("#latestPrice"),
  nextCheck: document.querySelector("#nextCheck"),
  monitorList: document.querySelector("#monitorList"),
  refreshButton: document.querySelector("#refreshButton"),
  addForm: document.querySelector("#addForm"),
  settingsForm: document.querySelector("#settingsForm"),
  testTelegramButton: document.querySelector("#testTelegramButton"),
  toast: document.querySelector("#toast")
};

await loadAll();

els.refreshButton.addEventListener("click", () => loadAll("已刷新"));
els.addForm.addEventListener("submit", addMonitor);
els.settingsForm.addEventListener("submit", saveSettings);
els.testTelegramButton.addEventListener("click", testTelegram);

setInterval(() => loadAll(), 30_000);

async function loadAll(message) {
  const [monitors, settings] = await Promise.all([
    api("/api/monitors"),
    api("/api/settings")
  ]);
  state.monitors = monitors.monitors;
  state.settings = settings;
  render();
  if (message) showToast(message);
}

function render() {
  const active = state.monitors.filter((monitor) => monitor.isActive);
  els.activeCount.textContent = `${active.length} 个运行中`;
  els.totalCount.textContent = state.monitors.length;

  els.telegramState.textContent = state.settings?.telegram?.connected
    ? `Telegram ${state.settings.telegram.chatId}`
    : "Telegram 未配置";
  els.telegramState.classList.toggle("connected", Boolean(state.settings?.telegram?.connected));

  const latest = [...state.monitors]
    .filter((monitor) => monitor.lastCheckedAt && Number.isFinite(Number(monitor.lastPrice)))
    .sort((a, b) => new Date(b.lastCheckedAt) - new Date(a.lastCheckedAt))[0];
  els.latestPrice.textContent = latest ? formatPrice(latest.lastPrice, latest.currency) : "-";

  const next = active
    .filter((monitor) => monitor.nextCheckAt)
    .sort((a, b) => new Date(a.nextCheckAt) - new Date(b.nextCheckAt))[0];
  els.nextCheck.textContent = next ? relativeTime(next.nextCheckAt) : "-";

  const chatIdInput = els.settingsForm.elements.telegramChatId;
  if (state.settings?.telegram?.chatId && document.activeElement !== chatIdInput) {
    chatIdInput.value = state.settings.telegram.chatId;
  }

  if (!state.monitors.length) {
    els.monitorList.innerHTML = `<div class="empty-state">还没有价格监控</div>`;
    return;
  }

  els.monitorList.innerHTML = state.monitors.map(renderMonitor).join("");
  els.monitorList.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleMonitorAction);
  });
}

function renderMonitor(monitor) {
  const statusClass = monitor.isActive ? "active" : "paused";
  const statusText = monitor.isActive ? "运行中" : "已暂停";
  const price = formatPrice(monitor.lastPrice, monitor.currency);
  const baseline = monitor.baselinePrice === null ? "无基准价" : `基准 ${formatPrice(monitor.baselinePrice, monitor.currency)}`;
  const target = monitor.targetPrice === null ? "无提醒价" : `提醒 ${formatPrice(monitor.targetPrice, monitor.currency)}`;
  const checked = monitor.lastCheckedAt ? `上次 ${formatDateTime(monitor.lastCheckedAt)}` : "尚未检查";
  const next = monitor.nextCheckAt ? `下次 ${relativeTime(monitor.nextCheckAt)}` : "无计划";
  const sku = monitor.sku ? `货号 ${escapeHtml(monitor.sku)}` : "无货号";
  const site = monitor.site ? `站点 ${escapeHtml(monitor.site)}` : "";
  const error = monitor.lastError ? `<div class="monitor-status error">${escapeHtml(monitor.lastError)}</div>` : "";

  return `
    <article class="monitor-item">
      <div class="monitor-main">
        <div class="monitor-title">
          <a href="${escapeAttr(monitor.url)}" target="_blank" rel="noreferrer">${escapeHtml(monitor.name)}</a>
          <span class="tag ${statusClass}">${statusText}</span>
        </div>
        <div class="monitor-meta">
          <span>${site}</span>
          <span>${sku}</span>
          <span>${baseline}</span>
          <span>${target}</span>
          <span>${monitor.intervalMinutes} 分钟</span>
        </div>
        <div class="monitor-status">${escapeHtml(monitor.lastStatus || "等待检查")} · ${checked} · ${next}</div>
        ${error}
      </div>
      <div>
        <div class="price">
          <strong>${price}</strong>
          <span>${monitor.lastSaleDetected ? "可能促销" : "常规"}</span>
        </div>
        <div class="actions">
          <button class="icon-button" type="button" title="立即检查" aria-label="立即检查" data-action="check" data-id="${monitor.id}">↻</button>
          <button class="icon-button" type="button" title="${monitor.isActive ? "暂停" : "恢复"}" aria-label="${monitor.isActive ? "暂停" : "恢复"}" data-action="toggle" data-id="${monitor.id}">
            ${monitor.isActive ? "Ⅱ" : "▶"}
          </button>
          <button class="danger-button" type="button" data-action="delete" data-id="${monitor.id}">删除</button>
        </div>
      </div>
    </article>
  `;
}

async function addMonitor(event) {
  event.preventDefault();
  const form = new FormData(els.addForm);
  const payload = {
    input: form.get("input"),
    name: form.get("name"),
    site: form.get("site"),
    intervalMinutes: form.get("intervalMinutes"),
    baselinePrice: form.get("baselinePrice"),
    targetPrice: form.get("targetPrice"),
    notifyOnAnyChange: form.get("notifyOnAnyChange") === "on",
    notifyOnDrop: form.get("notifyOnDrop") === "on"
  };

  await api("/api/monitors", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  els.addForm.reset();
  els.addForm.elements.intervalMinutes.value = "60";
  els.addForm.elements.site.value = "adidas.ca";
  els.addForm.elements.notifyOnAnyChange.checked = true;
  els.addForm.elements.notifyOnDrop.checked = true;
  await loadAll("已添加监控，后台正在做首次检查");
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(els.settingsForm);
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      telegramToken: form.get("telegramToken"),
      telegramChatId: form.get("telegramChatId")
    })
  });
  els.settingsForm.elements.telegramToken.value = "";
  await loadAll("Telegram 设置已保存");
}

async function testTelegram() {
  await api("/api/telegram/test", { method: "POST" });
  showToast("测试消息已发送");
}

async function handleMonitorAction(event) {
  const button = event.currentTarget;
  const id = button.dataset.id;
  const action = button.dataset.action;
  const monitor = state.monitors.find((item) => item.id === id);
  if (!monitor) return;

  if (action === "check") {
    button.disabled = true;
    await api(`/api/monitors/${id}/check`, { method: "POST" });
    await loadAll("检查完成");
  }

  if (action === "toggle") {
    await api(`/api/monitors/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !monitor.isActive })
    });
    await loadAll(monitor.isActive ? "已暂停" : "已恢复");
  }

  if (action === "delete") {
    if (button.dataset.confirmed !== "true") {
      button.dataset.confirmed = "true";
      button.textContent = "确认删除";
      showToast(`再点一次删除「${monitor.name}」`);
      window.setTimeout(() => {
        button.dataset.confirmed = "false";
        button.textContent = "删除";
      }, 3500);
      return;
    }
    await api(`/api/monitors/${id}`, { method: "DELETE" });
    await loadAll("已删除");
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(payload.error || "操作失败");
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function formatPrice(value, currency = "CAD") {
  if (value === null || value === undefined || value === "") return "-";
  const symbol = currency === "CAD" ? "C$" : currency === "USD" ? "$" : `${currency} `;
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${symbol}${number.toFixed(Number.isInteger(number) ? 0 : 2)}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function relativeTime(value) {
  const diffMs = new Date(value).getTime() - Date.now();
  const absMinutes = Math.max(0, Math.round(Math.abs(diffMs) / 60_000));
  if (diffMs <= 0) return "现在";
  if (absMinutes < 60) return `${absMinutes} 分钟后`;
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟后` : `${hours} 小时后`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
