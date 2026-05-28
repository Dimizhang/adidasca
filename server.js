import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const MONITORS_FILE = path.join(DATA_DIR, "monitors.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || ""
  }
};

const CHECK_LOOP_MS = 30_000;
const MIN_INTERVAL_MINUTES = 5;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_SITE = "adidas.ca";
const SITE_CONFIGS = {
  "adidas.ca": {
    currency: "CAD",
    baseUrl: "https://www.adidas.ca",
    searchPath: "/en/search",
    productApi: "https://www.adidas.ca/api/products/",
    acceptLanguage: "en-CA,en;q=0.9,zh-CN;q=0.7"
  },
  "adidas.com/us": {
    currency: "USD",
    baseUrl: "https://www.adidas.com",
    searchPath: "/us/search",
    productApi: "https://www.adidas.com/api/products/",
    acceptLanguage: "en-US,en;q=0.9,zh-CN;q=0.7"
  }
};

let checkInFlight = false;

await ensureDataFiles();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: statusCode === 500 ? "服务器内部错误" : error.message,
      detail: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Price monitor dashboard running at http://${HOST}:${PORT}`);
});

setInterval(() => {
  runDueChecks().catch((error) => console.error("Scheduled check failed", error));
}, CHECK_LOOP_MS);

runDueChecks({ startup: true }).catch((error) => console.error("Startup check failed", error));

async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  await ensureFile(
    SETTINGS_FILE,
    JSON.stringify(DEFAULT_SETTINGS, null, 2)
  );
  await ensureFile(
    MONITORS_FILE,
    JSON.stringify({ monitors: [] }, null, 2)
  );
}

async function ensureFile(filePath, contents) {
  try {
    await stat(filePath);
  } catch {
    await writeFile(filePath, `${contents}\n`, "utf8");
  }
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";

  if (method === "GET" && url.pathname === "/api/monitors") {
    const data = await readMonitors();
    sendJson(res, 200, { monitors: sortMonitors(data.monitors) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/monitors") {
    const body = await readJsonBody(req);
    const monitor = await createMonitor(body);
    const data = await readMonitors();
    data.monitors.push(monitor);
    await writeMonitors(data);
    checkMonitorById(monitor.id, { manual: true }).catch((error) => {
      console.error(`Initial check failed for ${monitor.id}`, error);
    });
    sendJson(res, 201, { monitor });
    return;
  }

  const monitorAction = url.pathname.match(/^\/api\/monitors\/([^/]+)(?:\/([^/]+))?$/);
  if (monitorAction) {
    const [, id, action] = monitorAction;

    if (method === "PATCH" && !action) {
      const body = await readJsonBody(req);
      const monitor = await updateMonitor(id, body);
      sendJson(res, 200, { monitor });
      return;
    }

    if (method === "DELETE" && !action) {
      await deleteMonitor(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && action === "check") {
      const monitor = await checkMonitorById(id, { manual: true });
      sendJson(res, 200, { monitor });
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/settings") {
    const settings = await readSettings();
    sendJson(res, 200, publicSettings(settings));
    return;
  }

  if (method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const settings = await readSettings();
    const token = typeof body.telegramToken === "string" ? body.telegramToken.trim() : "";
    const chatId = typeof body.telegramChatId === "string" ? body.telegramChatId.trim() : "";

    if (token) settings.telegram.token = token;
    if (chatId) settings.telegram.chatId = chatId;

    await writeSettings(settings);
    sendJson(res, 200, publicSettings(settings));
    return;
  }

  if (method === "POST" && url.pathname === "/api/telegram/test") {
    const settings = await readSettings();
    await sendTelegram(settings, "价格提醒测试：监控面板已连通 Telegram");
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "没有找到这个接口" });
}

async function createMonitor(body) {
  const input = stringField(body.input || body.url || body.sku);
  if (!input) {
    throw httpError(400, "请填写商品链接或货号");
  }

  const site = normalizeSite(isUrl(input) ? guessSite(input) : stringField(body.site) || guessSite(input));
  const siteDefaults = siteConfig(site);
  const resolved = resolveInput(input, site);
  const intervalMinutes = clampNumber(
    Number(body.intervalMinutes || 60),
    MIN_INTERVAL_MINUTES,
    24 * 60
  );
  const targetPrice = optionalNumber(body.targetPrice);
  const baselinePrice = optionalNumber(body.baselinePrice);
  const now = new Date().toISOString();

  return {
    id: slugify(`${site || "item"}-${resolved.sku || input}-${randomUUID().slice(0, 8)}`),
    name: stringField(body.name) || resolved.name || resolved.sku || input,
    input,
    sku: stringField(body.sku) || resolved.sku,
    site,
    url: resolved.url,
    checkUrl: resolved.checkUrl,
    currency: stringField(body.currency) || siteDefaults.currency,
    baselinePrice,
    targetPrice,
    intervalMinutes,
    notifyOnAnyChange: Boolean(body.notifyOnAnyChange),
    notifyOnDrop: body.notifyOnDrop !== false,
    isActive: body.isActive !== false,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: null,
    nextCheckAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString(),
    lastPrice: baselinePrice,
    lastSaleDetected: false,
    lastStatus: "已创建，等待检查",
    lastError: "",
    lastNotificationKey: ""
  };
}

function resolveInput(input, site) {
  const trimmed = input.trim();
  const normalizedSite = normalizeSite(site || guessSite(trimmed));
  const config = siteConfig(normalizedSite);

  if (isUrl(trimmed)) {
    const sku = extractSku(trimmed);
    return {
      sku,
      url: trimmed,
      checkUrl: trimmed
    };
  }

  const sku = trimmed.toUpperCase();
  if (config.productApi) {
    return {
      sku,
      name: `${normalizedSite} ${sku}`,
      url: `${config.baseUrl}${config.searchPath}?q=${encodeURIComponent(sku)}`,
      checkUrl: `${config.productApi}${encodeURIComponent(sku)}`
    };
  }

  return {
    sku,
    url: trimmed,
    checkUrl: trimmed
  };
}

function guessSite(input) {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("adidas.ca")) return "adidas.ca";
    if (host.includes("adidas.com") && parsed.pathname.startsWith("/us")) return "adidas.com/us";
    if (host.includes("adidas.com")) return "adidas.com/us";
    return host || "custom";
  } catch {
    return DEFAULT_SITE;
  }
}

function isUrl(input) {
  return /^https?:\/\//i.test(String(input || "").trim());
}

function normalizeSite(site) {
  const value = stringField(site).toLowerCase();
  if (value === "adidas.us" || value === "adidas.com" || value === "www.adidas.com" || value === "us") {
    return "adidas.com/us";
  }
  if (value === "www.adidas.ca" || value === "ca") return "adidas.ca";
  return value || DEFAULT_SITE;
}

function siteConfig(site) {
  return SITE_CONFIGS[normalizeSite(site)] || {
    currency: "CAD",
    baseUrl: "",
    searchPath: "",
    productApi: "",
    acceptLanguage: "en,en;q=0.9"
  };
}

async function updateMonitor(id, patch) {
  const data = await readMonitors();
  const monitor = data.monitors.find((item) => item.id === id);
  if (!monitor) throw httpError(404, "没有找到这个监控");

  if ("isActive" in patch) {
    monitor.isActive = Boolean(patch.isActive);
    monitor.nextCheckAt = monitor.isActive
      ? new Date(Date.now() + monitor.intervalMinutes * 60 * 1000).toISOString()
      : null;
  }

  if ("intervalMinutes" in patch) {
    monitor.intervalMinutes = clampNumber(Number(patch.intervalMinutes), MIN_INTERVAL_MINUTES, 24 * 60);
    monitor.nextCheckAt = monitor.isActive
      ? new Date(Date.now() + monitor.intervalMinutes * 60 * 1000).toISOString()
      : null;
  }

  if ("targetPrice" in patch) monitor.targetPrice = optionalNumber(patch.targetPrice);
  if ("baselinePrice" in patch) monitor.baselinePrice = optionalNumber(patch.baselinePrice);
  if ("notifyOnAnyChange" in patch) monitor.notifyOnAnyChange = Boolean(patch.notifyOnAnyChange);
  if ("notifyOnDrop" in patch) monitor.notifyOnDrop = Boolean(patch.notifyOnDrop);
  if ("name" in patch && stringField(patch.name)) monitor.name = stringField(patch.name);

  monitor.updatedAt = new Date().toISOString();
  await writeMonitors(data);
  return monitor;
}

async function deleteMonitor(id) {
  const data = await readMonitors();
  const next = data.monitors.filter((monitor) => monitor.id !== id);
  if (next.length === data.monitors.length) throw httpError(404, "没有找到这个监控");
  data.monitors = next;
  await writeMonitors(data);
}

async function runDueChecks({ startup = false } = {}) {
  if (checkInFlight) return;
  checkInFlight = true;

  try {
    const data = await readMonitors();
    const now = Date.now();
    const due = data.monitors.filter((monitor) => {
      if (!monitor.isActive) return false;
      if (startup && monitor.nextCheckAt) return false;
      if (!monitor.nextCheckAt) return true;
      return new Date(monitor.nextCheckAt).getTime() <= now;
    });

    for (const monitor of due) {
      await checkMonitor(monitor);
    }

    if (due.length) await writeMonitors(data);
  } finally {
    checkInFlight = false;
  }
}

async function checkMonitorById(id, options = {}) {
  const data = await readMonitors();
  const monitor = data.monitors.find((item) => item.id === id);
  if (!monitor) throw httpError(404, "没有找到这个监控");

  await checkMonitor(monitor, options);
  await writeMonitors(data);
  return monitor;
}

async function checkMonitor(monitor, { manual = false } = {}) {
  const checkedAt = new Date();

  try {
    const result = await fetchPrice(monitor);
    const previousPrice = monitor.lastPrice;
    const baselinePrice = numberOrNull(monitor.baselinePrice);
    const targetPrice = numberOrNull(monitor.targetPrice);
    const currentPrice = numberOrNull(result.price);
    const priceChanged = previousPrice !== null && currentPrice !== null && currentPrice !== previousPrice;
    const belowBaseline = baselinePrice !== null && currentPrice !== null && currentPrice < baselinePrice;
    const belowTarget = targetPrice !== null && currentPrice !== null && currentPrice <= targetPrice;
    const shouldNotify =
      (monitor.notifyOnDrop && (belowBaseline || belowTarget || result.saleDetected)) ||
      (monitor.notifyOnAnyChange && priceChanged);

    monitor.name = result.name || monitor.name;
    monitor.url = result.url || monitor.url;
    monitor.currency = result.currency || monitor.currency;
    monitor.lastPrice = currentPrice;
    monitor.lastSaleDetected = Boolean(result.saleDetected);
    monitor.lastCheckedAt = checkedAt.toISOString();
    monitor.nextCheckAt = monitor.isActive
      ? new Date(Date.now() + monitor.intervalMinutes * 60 * 1000).toISOString()
      : null;
    monitor.lastError = "";
    monitor.lastStatus = describeStatus({
      currentPrice,
      previousPrice,
      baselinePrice,
      targetPrice,
      saleDetected: result.saleDetected,
      manual
    });
    monitor.updatedAt = checkedAt.toISOString();

    if (shouldNotify) {
      const notificationKey = `${currentPrice ?? "unknown"}:${result.saleDetected ? "sale" : "regular"}:${monitor.url}`;
      if (notificationKey !== monitor.lastNotificationKey) {
        const settings = await readSettings();
        await sendTelegram(settings, buildNotification(monitor, result, { previousPrice, baselinePrice, targetPrice }));
        monitor.lastNotificationKey = notificationKey;
        monitor.lastNotificationAt = new Date().toISOString();
        monitor.lastStatus = `${monitor.lastStatus}，已通知 Telegram`;
      }
    }
  } catch (error) {
    monitor.lastCheckedAt = checkedAt.toISOString();
    monitor.nextCheckAt = monitor.isActive
      ? new Date(Date.now() + monitor.intervalMinutes * 60 * 1000).toISOString()
      : null;
    monitor.lastError = error.message;
    monitor.lastStatus = `检查失败：${error.message}`;
    monitor.updatedAt = checkedAt.toISOString();
  }
}

async function fetchPrice(monitor) {
  const config = siteConfig(monitor.site);
  const response = await fetch(monitor.checkUrl || monitor.url, {
    headers: {
      "user-agent": "Mozilla/5.0 PriceMonitor/1.0",
      "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
      "accept-language": config.acceptLanguage
    }
  });

  if (!response.ok) {
    throw new Error(responseStatusMessage(monitor, response.status));
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json") || looksLikeJson(text)) {
    try {
      return extractFromJson(JSON.parse(text), monitor);
    } catch {
      return extractFromHtml(text, monitor);
    }
  }

  return extractFromHtml(text, monitor);
}

function responseStatusMessage(monitor, status) {
  const sku = monitor.sku ? `货号 ${monitor.sku}` : "这个商品";
  if (isAdidasProductApi(monitor) && (status === 403 || status === 404)) {
    const reason = status === 403 ? "没有返回商品数据" : "没有找到商品数据";
    return `${monitor.site} ${reason}：${sku}。请确认国家站是否选对，或改用商品详情页链接。`;
  }
  return `页面返回 ${status}`;
}

function isAdidasProductApi(monitor) {
  return /adidas\.(?:ca|com)\/api\/products\//i.test(monitor.checkUrl || "");
}

function extractFromJson(data, monitor) {
  const pricing = data.pricing_information || data.pricingInformation || data.priceData || {};
  const productDescription = data.product_description || data.productDescription || {};
  const price =
    firstNumber(
      pricing.sale_price,
      pricing.salePrice,
      pricing.current_price,
      pricing.currentPrice,
      pricing.price,
      pricing.standard_price,
      pricing.standardPrice,
      data.sale_price,
      data.currentPrice,
      data.price
    ) ?? firstRecursivePrice(data);

  const standardPrice = firstNumber(pricing.standard_price, pricing.standardPrice, pricing.list_price, pricing.listPrice);
  const saleDetected = standardPrice !== null && price !== null && price < standardPrice;
  const productUrl = stringField(data.link || data.url || productDescription.link);

  if (price === null) {
    throw new Error("没有从商品数据里识别到价格");
  }

  return {
    price,
    currency: normalizeCurrency(stringField(pricing.currency || pricing.currency_code || data.currency) || monitor.currency),
    saleDetected,
    name: stringField(data.name || productDescription.title || productDescription.name),
    url: productUrl ? absoluteAdidasUrl(productUrl, monitor.site) : monitor.url
  };
}

function extractFromHtml(html, monitor) {
  const jsonLd = extractJsonLd(html, monitor);
  if (jsonLd) return jsonLd;

  const metaPrice =
    findMetaContent(html, "product:price:amount") ||
    findMetaContent(html, "og:price:amount") ||
    findMetaContent(html, "twitter:data1");
  const price = numberOrNull(metaPrice) ?? firstMoneyMatch(html);
  const currency =
    findMetaContent(html, "product:price:currency") ||
    findMetaContent(html, "og:price:currency") ||
    monitor.currency ||
    "CAD";
  const saleDetected = /sale|discount|markdown|was price|sale price|reduced|% off|promo|promotion/i.test(html);
  const name =
    findMetaContent(html, "og:title") ||
    findTitle(html) ||
    monitor.name;

  if (price === null) {
    throw new Error("没有从页面里识别到价格");
  }

  return {
    price,
    currency: normalizeCurrency(currency),
    saleDetected,
    name,
    url: monitor.url
  };
}

function extractJsonLd(html, monitor) {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of matches) {
    const raw = decodeHtml(match[1].trim());
    try {
      const data = JSON.parse(raw);
      const offer = findOffer(data);
      if (offer) {
        const price = numberOrNull(offer.price || offer.lowPrice || offer.highPrice);
        if (price !== null) {
          return {
            price,
            currency: normalizeCurrency(offer.priceCurrency || monitor.currency || siteConfig(monitor.site).currency),
            saleDetected: false,
            name: stringField(data.name),
            url: stringField(data.url)
          };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findOffer(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const offer = findOffer(item);
      if (offer) return offer;
    }
    return null;
  }
  if (data.offers) {
    if (Array.isArray(data.offers)) return data.offers[0];
    return data.offers;
  }
  for (const value of Object.values(data)) {
    const offer = findOffer(value);
    if (offer) return offer;
  }
  return null;
}

function firstRecursivePrice(data) {
  const queue = [data];
  const priceKeys = new Set(["price", "currentprice", "current_price", "saleprice", "sale_price"]);

  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;

    for (const [key, value] of Object.entries(item)) {
      if (priceKeys.has(key.toLowerCase())) {
        const price = numberOrNull(value);
        if (price !== null) return price;
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

function firstMoneyMatch(html) {
  const clean = html.replace(/&nbsp;/g, " ");
  const patterns = [
    /(?:C\$|CA\$)\s*([0-9]+(?:[.,][0-9]{2})?)/i,
    /(?:US\$|\$)\s*([0-9]+(?:[.,][0-9]{2})?)/i,
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
    /"salePrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return numberOrNull(match[1]);
  }
  return null;
}

async function sendTelegram(settings, text) {
  const token = settings.telegram?.token;
  const chatId = settings.telegram?.chatId;
  if (!token || !chatId) {
    throw new Error("Telegram token 或 chat_id 还没有配置");
  }

  const params = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: "false"
  });
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram 返回 ${response.status}`);
  }
}

function buildNotification(monitor, result, { previousPrice, baselinePrice, targetPrice }) {
  const lines = [
    "价格监控提醒",
    monitor.name,
    `当前价格：${formatPrice(result.price, result.currency || monitor.currency)}`,
    baselinePrice !== null ? `基准价格：${formatPrice(baselinePrice, monitor.currency)}` : "",
    targetPrice !== null ? `提醒价格：${formatPrice(targetPrice, monitor.currency)}` : "",
    previousPrice !== null ? `上次价格：${formatPrice(previousPrice, monitor.currency)}` : "",
    result.saleDetected ? "页面显示可能有折扣/促销" : "",
    monitor.url
  ].filter(Boolean);

  return lines.join("\n");
}

function describeStatus({ currentPrice, previousPrice, baselinePrice, targetPrice, saleDetected, manual }) {
  const prefix = manual ? "手动检查完成" : "自动检查完成";
  if (currentPrice === null) return `${prefix}，未识别到价格`;
  if (saleDetected) return `${prefix}，页面显示可能有折扣`;
  if (baselinePrice !== null && currentPrice < baselinePrice) return `${prefix}，低于基准价`;
  if (targetPrice !== null && currentPrice <= targetPrice) return `${prefix}，达到提醒价`;
  if (previousPrice !== null && currentPrice !== previousPrice) return `${prefix}，价格有变化`;
  return `${prefix}，价格未触发提醒`;
}

async function readMonitors() {
  const raw = await readFile(MONITORS_FILE, "utf8");
  const data = JSON.parse(raw);
  return { monitors: Array.isArray(data.monitors) ? data.monitors : [] };
}

async function writeMonitors(data) {
  await writeFile(MONITORS_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readSettings() {
  const raw = await readFile(SETTINGS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return {
    telegram: {
      token: parsed.telegram?.token || process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: parsed.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || ""
    }
  };
}

async function writeSettings(settings) {
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function publicSettings(settings) {
  return {
    telegram: {
      connected: Boolean(settings.telegram?.token && settings.telegram?.chatId),
      chatId: settings.telegram?.chatId || "",
      tokenPreview: maskToken(settings.telegram?.token || "")
    }
  };
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(fullPath);
    res.writeHead(200, { "content-type": contentType(fullPath) });
    res.end(body);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw httpError(413, "请求内容太大");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "JSON 格式不正确");
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sortMonitors(monitors) {
  return [...monitors].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

function stringField(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  return numberOrNull(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value).replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function extractSku(url) {
  const match = url.match(/\/([A-Z0-9]{5,10})\.html(?:$|[?#])/i);
  return match ? match[1].toUpperCase() : "";
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeCurrency(currency) {
  const value = String(currency || "").trim().toUpperCase();
  if (value === "C$" || value === "CA$") return "CAD";
  if (value === "$" || value === "US$") return "USD";
  return value || "CAD";
}

function formatPrice(price, currency = "CAD") {
  if (price === null || price === undefined) return "未知";
  const normalized = normalizeCurrency(currency);
  const symbol = normalized === "CAD" ? "C$" : normalized === "USD" ? "$" : `${currency} `;
  return `${symbol}${Number(price).toFixed(Number.isInteger(price) ? 0 : 2)}`;
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 12) return "********";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function findMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function findTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, " ").trim()) : "";
}

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function looksLikeJson(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function absoluteAdidasUrl(url, site) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const config = siteConfig(site);
  const baseUrl = config.baseUrl || "https://www.adidas.ca";
  return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}
