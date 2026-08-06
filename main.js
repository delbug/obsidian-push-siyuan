/**
 * SiPush — Obsidian ↔ 思源笔记 双向同步插件 (V2.1.0)
 * 纯 JS 编写，零构建，直接放入插件目录即可使用
 *
 * V2 新增：双向同步 / 批量同步 / 冲突解决 / 搜索拉回 / 同步报告
 * V2.1 新增：一键全库推送 / 媒体资源上传 / 双链转换
 * 思源 Kernel API: http://localhost:6806 (可自定义)
 */
const {
  Plugin, PluginSettingTab, Setting, Notice, Modal,
  MarkdownView, TFile, TFolder, setIcon, FuzzySuggestModal
} = require("obsidian");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════
// 默认设置
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_SETTINGS = {
  // V1
  serverUrl: "http://127.0.0.1:6806",
  apiToken: "",
  defaultNotebookId: "",
  defaultPath: "/Obsidian/",
  pushFrontmatter: false,
  docMapping: {},
  // V2
  syncConflictMode: "ask", // ask | obsidian-wins | siyuan-wins
  maxSyncHistory: 20,
  syncHistory: [],
  // V2.1
  preserveFolderStructure: true,
  syncAssets: true,
  rewriteWikilinks: true,
  // 思源官方建议统一放到 /assets/；子目录（如 sipush/）容易导致引用找不到
  assetsDirPath: "/assets/",
  // vault 相对路径 → 思源 assets 路径（避免重复上传产生多份副本）
  assetMap: {},
  // 一键同步默认动作：vault = 全库推送，current = 仅当前笔记
  oneClickAction: "vault",
  // 缓存笔记本列表，打开设置时无需每次点刷新才能看到名称
  notebookCache: [],
  // 思源文档树最大深度（叶子文档可以在第 7 层；第 7 层下不能再建子文档）
  maxDocDepth: 7,
  // 推送时若已有文档的思源路径与当前规则不一致，自动迁到正确层级
  realignDocPath: true,
  // 推送失败队列：修好 bug 后可一键重试
  failedQueue: [],
  // 可暂停/继续的推送任务断点
  pushJob: null,
  // 推送结束自动修复：音视频 ![]→播放器、去重后附件断链
  autoRepairAfterPush: true,
  // 是否仍需把 custom-si-push-id 从 frontmatter 迁到文末
  needsPushIdFooterMigration: true,
};

const HASH_ATTR = "si-push-content-hash";
const MTIME_ATTR = "si-push-mtime";
const PUSH_ID_KEY = "custom-si-push-id";
/** 文末极小字号 ID 标记（替代顶部 frontmatter，减少干扰） */
const PUSH_FOOTER_CLASS = "sipush-meta";

function formatPushIdFooter(id) {
  return `\n\n<div class="${PUSH_FOOTER_CLASS}">si-push · id:${id}</div>\n`;
}
function extractPushIdFromContent(md) {
  if (!md) return null;
  const m = String(md).match(
    new RegExp(`<div class="${PUSH_FOOTER_CLASS}"[^>]*>[\\s\\S]*?id:\\s*([a-zA-Z0-9_-]+)\\s*<\\/div>\\s*$`, "i")
  ) || String(md).match(/<!--\s*sipush-id:\s*([a-zA-Z0-9_-]+)\s*-->\s*$/i);
  return m ? m[1] : null;
}
function stripPushIdFooter(md) {
  return String(md || "")
    .replace(new RegExp(`\\n*<div class="${PUSH_FOOTER_CLASS}"[^>]*>[\\s\\S]*?<\\/div>\\s*$`, "i"), "")
    .replace(/\n*<!--\s*sipush-id:[\s\S]*?-->\s*$/i, "")
    .replace(/\s+$/g, "");
}
/** 从 YAML frontmatter 文本读取 custom-si-push-id */
function extractPushIdFromFrontmatterText(md) {
  const m = String(md || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find(l => new RegExp(`^\\s*${PUSH_ID_KEY}\\s*:`).test(l));
  if (!line) return null;
  const v = line.replace(new RegExp(`^\\s*${PUSH_ID_KEY}\\s*:\\s*`), "").trim().replace(/^["']|["']$/g, "");
  return v || null;
}
/** 删除 frontmatter 中的 custom-si-push-id；若 FM 因此变空则整块去掉 */
function removePushIdFromFrontmatter(md) {
  const text = String(md || "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!m) return text;
  if (!new RegExp(`^\\s*${PUSH_ID_KEY}\\s*:`, "m").test(m[1])) return text;
  const kept = m[1].split(/\r?\n/).filter(l => !new RegExp(`^\\s*${PUSH_ID_KEY}\\s*:`).test(l));
  const meaningful = kept.filter(l => l.trim() !== "");
  const rest = text.slice(m[0].length).replace(/^\r?\n/, "");
  if (!meaningful.length) return rest;
  return `---\n${kept.join("\n").replace(/^\n+|\n+$/g, "")}\n---\n` + rest;
}
/**
 * 把关联 ID 固定写到文末小字，并清掉顶部 custom-si-push-id。
 * createIfMissing=false 时：没有任何 ID 则不改动（用于全库迁移）。
 */
function applyPushIdFooterMigration(md, opts) {
  opts = opts || {};
  const fmId = extractPushIdFromFrontmatterText(md);
  const footerId = extractPushIdFromContent(md);
  let id = opts.preferredId || footerId || fmId || null;
  if (!id) {
    if (opts.createIfMissing === false) return { id: null, md, changed: false };
    id = genPushId();
  }
  let next = removePushIdFromFrontmatter(md);
  next = stripPushIdFooter(next).replace(/\s+$/, "") + formatPushIdFooter(id);
  return { id, md: next, changed: next !== md };
}
// ═══════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════
function contentHash(text) {
  // 规范化内容再哈希：统一换行符，去除尾部空白，剥离思源自动添加的标题行
  const normalized = text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/\s+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^# .*\n*/, "") // 剥离第一行标题（思源 exportMdContent 自动添加），同时清除残留换行
    .trim();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

// 剥离思源 exportMdContent 自动添加的第一行标题
function stripSiTitle(text) {
  return text.replace(/^# .*\n/, "");
}
function utcSec() { return Math.floor(Date.now() / 1000); }
/** 让出事件循环，保证进度条/状态栏能刷新 */
function yieldUi() { return new Promise(r => setTimeout(r, 0)); }
function formatTime(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleString("zh-CN", { hour12: false });
}
function genPushId() {
  return "si" + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
function safeTitle(t) { return t.replace(/[<>:"/\\|?*]/g, "_"); }
function stripFM(c) {
  return stripPushIdFooter(
    c.replace(/^---[\s\S]*?---\n*/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/gm, "").trim()
  );
}

/** 图片：用 ![](assets/...)；音视频必须用 HTML，否则思源当图片加载会显示「找不到」 */
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic",
]);
const AUDIO_EXTS = new Set([
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus",
]);
const VIDEO_EXTS = new Set([
  "mp4", "webm", "mov", "mkv", "avi", "m4v", "flv", "wmv",
]);
const INLINE_MEDIA_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS, ...VIDEO_EXTS]);
function isRemoteUrl(p) { return /^https?:\/\//i.test(p) || /^data:/i.test(p) || /^siyuan:/i.test(p); }
function isInlineMediaExt(ext) { return INLINE_MEDIA_EXTS.has((ext || "").toLowerCase()); }
function isImageExt(ext) { return IMAGE_EXTS.has((ext || "").toLowerCase()); }
function isAudioExt(ext) { return AUDIO_EXTS.has((ext || "").toLowerCase()); }
function isVideoExt(ext) { return VIDEO_EXTS.has((ext || "").toLowerCase()); }
function isMarkdownExt(ext) { return (ext || "").toLowerCase() === "md"; }
/** 任意非 md 本地文件都视为需上传的资源（不限于白名单：pdf/音视频/office 等） */
function isAssetFile(file) {
  if (!file || !file.extension) return false;
  return !isMarkdownExt(file.extension);
}
function guessAssetMime(ext) {
  const e = (ext || "").toLowerCase();
  const map = {
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
    m4a: "audio/mp4", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    avi: "video/x-msvideo", m4v: "video/x-m4v",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    pdf: "application/pdf", zip: "application/zip",
  };
  return map[e] || "";
}
/** 规范化思源资源链接路径：解码 %20、去掉多余斜杠，统一为 assets/... */
function normalizeAssetLinkPath(p) {
  if (!p) return p;
  let s = decodeUriPath(String(p).trim()).replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");
  if (!/^assets\//i.test(s)) s = "assets/" + s.replace(/^assets\/?/i, "");
  // 思源 Markdown 引用不要带 %xx，空格等直接用净化后的文件名
  return s;
}
function extFromAssetPath(assetPath) {
  const name = String(assetPath || "").split("/").pop() || "";
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}
/** 按类型生成思源可识别的 Markdown / HTML 引用 */
function formatAssetMarkdown(file, assetPath, alias) {
  const name = (alias || (file && file.basename) || "file").replace(/[\[\]]/g, "");
  const ext = ((file && file.extension) || extFromAssetPath(assetPath) || "").toLowerCase();
  const path = normalizeAssetLinkPath(assetPath);
  // 音频：必须用 <audio>，![]() 会被当成图片 → 「找不到」
  if (isAudioExt(ext)) {
    return `<audio controls="controls" src="${path}" data-src="${path}"></audio>`;
  }
  // 视频同理
  if (isVideoExt(ext)) {
    return `<video controls="controls" src="${path}" data-src="${path}"></video>`;
  }
  // 图片：内联预览
  if (isImageExt(ext)) return `![${name}](${path})`;
  // PDF/文档/其它附件：可点击链接
  return `[${name}](${path})`;
}
function parseWikiTarget(raw) {
  const pipe = raw.indexOf("|");
  const target = pipe >= 0 ? raw.slice(0, pipe).trim() : raw.trim();
  const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : null;
  const hashIdx = target.indexOf("#");
  const caretIdx = target.indexOf("^");
  let cut = target.length;
  if (hashIdx >= 0) cut = Math.min(cut, hashIdx);
  if (caretIdx >= 0) cut = Math.min(cut, caretIdx);
  return { path: target.slice(0, cut).trim(), alias };
}
function decodeUriPath(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

/** SHA-256 十六进制；大附件去重用 */
async function sha256Hex(buffer) {
  if (!buffer) return "";
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 从思源资源名解析上传时间戳 name-YYYYMMDDHHmmss-xxxxxx.ext */
function parseSiYuanAssetTimestamp(name) {
  const m = String(name || "").match(/-(\d{14})-[a-z0-9]{6,10}(\.[^.]+)?$/i);
  if (!m) return 0;
  const s = m[1];
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
  const t = Date.UTC(y, mo, d, h, mi, se);
  return Number.isFinite(t) ? t : 0;
}

function assetEarlinessMs(item) {
  const fromName = parseSiYuanAssetTimestamp(item.name);
  if (fromName) return fromName;
  const u = Number(item.updated) || 0;
  // readDir 的 updated 多为秒；也可能是毫秒
  return u > 1e12 ? u : u * 1000;
}

function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + " B";
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + " KB";
  if (x < 1024 * 1024 * 1024) return (x / (1024 * 1024)).toFixed(1) + " MB";
  return (x / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/** 去掉思源自动追加的 -YYYYMMDDHHmmss-xxxxxx，便于同族归组 */
function stripSiYuanAssetId(name) {
  return String(name || "").replace(/-\d{14}-[a-z0-9]{6,10}(\.[^.]+)$/i, "$1");
}

/** 去掉插件 uniqueAssetName 追加的短哈希 -xxxxxxxx */
function stripPluginAssetHash(name) {
  return String(name || "").replace(/-[a-f0-9]{8,12}(\.[^.]+)$/i, "$1");
}

/**
 * 同内容重复上传后的文件名族键：
 * - 普通：foo-ab12cd34-时间-id.png → foo.png（再归一化空格/下划线）
 * - 思源内容哈希开头：同一 32 位 hex 前缀视为同族
 * - 「14.00 千问」与「14.00_千问」必须归为同族
 */
function assetFamilyKey(name) {
  let stripped = stripPluginAssetHash(stripSiYuanAssetId(name));
  const extM = stripped.match(/(\.[^.]+)$/);
  const ext = extM ? extM[1].toLowerCase() : "";
  const m = stripped.match(/^([a-f0-9]{32})/i);
  if (m) return m[1].toLowerCase() + ext;
  return stripped
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * 上传文件名：短、无空格；内容哈希优先（去重稳定），避免长 UUID 被 slice 截断后撞名。
 */
function uniqueAssetName(file, contentHashHex) {
  const ext = file.extension ? ("." + String(file.extension).toLowerCase()) : "";
  const rawBase = String(file.basename || "asset");
  let base = safeTitle(rawBase)
    .replace(/\s+/g, "_")
    .replace(/[^\w\u4e00-\u9fff._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  // UUID 类长名：保留末尾更有区分度的一段
  if (base.length > 40) {
    base = base.slice(0, 20) + "_" + base.slice(-12);
  }
  base = base || "asset";
  const hash = String(contentHashHex || contentHash(file.path)).replace(/[^a-f0-9]/gi, "").slice(0, 12)
    || contentHash(file.path).slice(0, 8);
  return `${base}-${hash}${ext}`;
}
function resolveAssetsDirPath(setting) {
  let dir = (setting || "/assets/").trim() || "/assets/";
  // 历史默认 /assets/sipush/ 在思源中引用易失效，自动纠正
  if (/\/assets\/sipush\/?$/i.test(dir) || /^assets\/sipush\/?$/i.test(dir)) {
    dir = "/assets/";
  }
  if (!dir.startsWith("/")) dir = "/" + dir;
  if (!dir.endsWith("/")) dir += "/";
  return dir;
}
/** 已是可用的思源资源链接则跳过重传；旧 sipush / %20 / 空格路径视为损坏需重传 */
function shouldReuseAssetLink(link) {
  if (!link || isRemoteUrl(link)) return false;
  const raw = String(link);
  const decoded = decodeUriPath(raw);
  if (!/^assets\//i.test(decoded)) return false;
  if (/^assets\/sipush\//i.test(decoded)) return false;
  if (/%[0-9a-f]{2}/i.test(raw)) return false;
  if (/\s/.test(decoded)) return false;
  return true;
}
/** 从损坏的 assets 链接反推可能的 vault 文件名，便于重新上传 */
function guessVaultNameFromAssetLink(link) {
  let name = decodeUriPath(String(link || "")).split("/").pop() || "";
  name = name.replace(/-\d{14}-[a-z0-9]{6,10}(\.[^.]+)$/i, "$1");
  name = name.replace(/-[a-f0-9]{8}(\.[^.]+)$/i, "$1");
  if (name.includes("__")) {
    const parts = name.split("__");
    name = parts[parts.length - 1] || name;
  }
  return name;
}

/** 思源 updated 格式 "YYYYMMDDHHMMSS" → 毫秒时间戳 */
function siYuanTimeToMs(timeStr) {
  if (!timeStr) return 0;
  const s = String(timeStr).replace(/[^0-9]/g, "");
  if (s.length !== 14) return 0;
  // 解析为本地时间
  const y = parseInt(s.substring(0, 4));
  const m = parseInt(s.substring(4, 6)) - 1;
  const d = parseInt(s.substring(6, 8));
  const h = parseInt(s.substring(8, 10));
  const mi = parseInt(s.substring(10, 12));
  const sec = parseInt(s.substring(12, 14));
  const dt = new Date(y, m, d, h, mi, sec);
  return dt.getTime();
}

/** 思源 exportMdContent 返回的 Markdown 中含有思源自己的 frontmatter，需要剥离 */
function stripSiYuanFrontmatter(content) {
  if (!content) return "";
  // 移除思源自带的 frontmatter（title/date/lastmod 等）
  let stripped = content.replace(/^---[\s\S]*?lastmod:.*?\n---\s*\n/gm, "");
  // 如果上面没匹配到，试试更通用的 frontmatter 剥离
  if (stripped === content) {
    stripped = content.replace(/^---[\s\S]*?---\n*/g, "").trim();
  }
  // 也剥离思源自带的标题行（# Title），确保 getDocMd 返回纯净 body
  stripped = stripped.replace(/^# .*\n*/, "").trim();
  // 规范化：统一换行符，去除尾部空白
  return stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ═══════════════════════════════════════════════════════════════════
// SiYuan API 封装 (V2 修复版)
// ═══════════════════════════════════════════════════════════════════
class SiYuanApi {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async request(endpoint, payload) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Token " + this.token;
    let resp;
    try {
      resp = await fetch(this.url + endpoint, {
        method: "POST", headers, body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error("无法连接思源: " + e.message);
    }
    // 只跳过 204 No Content（无响应体），不做 Content-Length 判断
    // 浏览器在 gzip/分块编码时可能不暴露 Content-Length，导致误判为空
    if (resp.status === 204) {
      return {};
    }
    let text = "";
    try { text = await resp.text(); } catch { /* ignore */ }
    if (!text || text.trim() === "") {
      return {};
    }
    try {
      const j = JSON.parse(text);
      if (j.code !== 0) {
        throw new Error("SiYuan API: " + (j.msg || "code=" + j.code));
      }
      return j.data || j;
    } catch (e) {
      // JSON 解析失败 — 可能是 removeBlock 返回了非标准响应
      console.log(`[SiPush] JSON parse failed for ${endpoint}:`, text.substring(0, 200));
      if (e.message && e.message.includes("SiYuan")) throw e;
      // 对已知的 "轻量" API（删除操作），忽略 JSON 解析错误
      if (endpoint.includes("removeBlock") || endpoint.includes("removeDoc")) {
        return {};
      }
      throw new Error("无法连接思源: " + e.message);
    }
  }

  // ── 基础 ──
  async getNotebooks() {
    const d = await this.request("/api/notebook/lsNotebooks", {});
    return d.notebooks || d;
  }

  async createDoc(notebookId, path, md) {
    return this.request("/api/filetree/createDocWithMd", { notebook: notebookId, path, markdown: md });
  }

  async updateDoc(docId, md) {
    return this.request("/api/block/updateBlock", { id: docId, dataType: "markdown", data: md });
  }

  async appendToDoc(docId, content) {
    return this.request("/api/block/appendBlock", { parentID: docId, data: content, domain: 0 });
  }

  async setAttrs(id, attrs) { return this.request("/api/attr/setBlockAttrs", { id, attrs }); }

  async getAttrs(id) { return this.request("/api/attr/getBlockAttrs", { id }); }

  // ── 查找文档（带 updated 时间戳） ──
  async findDoc(pushId) {
    if (!pushId) return null;
    const stmt =
      "SELECT b.id, b.hpath, b.box, b.updated FROM blocks b " +
      "JOIN attributes a ON a.block_id = b.id " +
      "WHERE a.name='custom-si-push-id' AND a.value='" + pushId.replace(/'/g,"''") + "' " +
      "AND b.type='d' ORDER BY b.updated DESC LIMIT 1";
    const d = await this.request("/api/query/sql", { stmt });
    return d && d.length > 0 ? d[0] : null;
  }

  /** 按笔记本 + 人类可读路径找文档，避免 createDocWithMd 重复建同名文档 */
  async findDocByHPath(notebookId, hpath) {
    if (!notebookId || !hpath) return null;
    let p = String(hpath).trim().replace(/\\/g, "/");
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/\/+/g, "/");
    // 优先官方 API
    try {
      const ids = await this.request("/api/filetree/getIDsByHPath", {
        notebook: notebookId,
        path: p,
      });
      const list = Array.isArray(ids) ? ids : (ids && ids.ids) || [];
      if (list.length) return { id: list[0], hpath: p, box: notebookId };
    } catch (e) { /* 旧版思源可能无此接口 */ }
    // SQL 回退（精确 + 去掉末尾斜杠）
    const escaped = p.replace(/'/g, "''");
    const stmt =
      "SELECT id, hpath, box, updated FROM blocks WHERE type='d' AND box='" +
      notebookId.replace(/'/g, "''") +
      "' AND (hpath='" + escaped + "' OR hpath='" + escaped.replace(/\/$/, "") +
      "') ORDER BY updated DESC LIMIT 1";
    try {
      const d = await this.request("/api/query/sql", { stmt });
      return d && d.length > 0 ? d[0] : null;
    } catch (e) {
      return null;
    }
  }

  // ── 获取文档的同步元信息 ──
  async getSyncInfo(docId) {
    const a = await this.getAttrs(docId);
    return {
      hash: a[HASH_ATTR] || null,
      mtime: parseInt(a[MTIME_ATTR]) || 0,
      // 思源文档的 updated 时间戳
      updatedMs: siYuanTimeToMs(a.updated) || 0,
    };
  }

  // ── 写入同步元信息 ──
  async setSyncInfo(docId, hash, mtime) {
    return this.setAttrs(docId, { [HASH_ATTR]: hash, [MTIME_ATTR]: String(mtime) });
  }

  // ── 获取文档完整 Markdown（使用 exportMdContent API） ──
  async getDocMd(docId) {
    // 使用思源官方的 exportMdContent API 获取完整 Markdown
    const result = await this.request("/api/export/exportMdContent", { id: docId });
    if (!result || !result.content) return "";
    // 剥离思源自带的 frontmatter
    return stripSiYuanFrontmatter(result.content);
  }

  // ── 搜索 ──
  async searchDoc(kw, nb) {
    const f = nb ? "AND box='" + nb.replace(/'/g,"''") + "'" : "";
    const k = kw.replace(/'/g,"''");
    const stmt =
      "SELECT b.id, b.content, b.hpath, b.path, b.updated FROM blocks b " +
      "WHERE b.type='d' AND (b.content LIKE '%" + k + "%' OR b.hpath LIKE '%" + k + "%')" +
      f + " ORDER BY b.updated DESC LIMIT 30";
    return { blocks: await this.request("/api/query/sql", { stmt }) };
  }

  async searchLinked(nb) {
    const f = nb ? "AND b.box='" + nb.replace(/'/g,"''") + "'" : "";
    const stmt =
      "SELECT DISTINCT b.id, b.hpath, b.path, b.updated, a.value as push_id FROM blocks b " +
      "JOIN attributes a ON a.block_id=b.id " +
      "WHERE a.name='custom-si-push-id' AND b.type='d' " +
      f + " ORDER BY b.updated DESC LIMIT 5000";
    return await this.request("/api/query/sql", { stmt });
  }

  // ── 删除思源文档（用 removeDoc 按路径删除，彻底删除） ──
  async removeDoc(notebookId, path) {
    // removeDoc 需要文件树路径，如 /Obsidian/推送原测试
    const p = path ? path.replace(/^[\/]/, "") : "";
    return this.request("/api/filetree/removeDoc", { notebook: notebookId, path: p });
  }
  async removeDocByID(id) {
    if (!id) return null;
    return this.request("/api/filetree/removeDocByID", { id });
  }
  async getHPathByID(id) {
    if (!id) return null;
    const d = await this.request("/api/filetree/getHPathByID", { id });
    // 接口可能直接返回字符串，或包在对象里
    if (typeof d === "string") return d;
    if (d && typeof d === "object") return d.hpath || d.path || d.data || null;
    return null;
  }
  async removeBlock(id) { return this.request("/api/block/removeBlock", { id }); }

  // ── 上传资源到思源 assets ──
  async uploadAsset(blobOrFile, fileName, assetsDirPath) {
    const form = new FormData();
    form.append("assetsDirPath", resolveAssetsDirPath(assetsDirPath));
    // 优先用 File，保留文件名与 MIME，大音视频更稳
    form.append("file[]", blobOrFile, fileName);
    const headers = {};
    if (this.token) headers["Authorization"] = "Token " + this.token;
    let resp;
    try {
      resp = await fetch(this.url + "/api/asset/upload", { method: "POST", headers, body: form });
    } catch (e) {
      throw new Error("上传资源失败: " + e.message);
    }
    if (!resp.ok) {
      throw new Error("SiYuan upload HTTP " + resp.status + "（大文件可能被超时/网关拦截）");
    }
    let j;
    try {
      j = await resp.json();
    } catch (e) {
      throw new Error("SiYuan upload 响应非 JSON（常见于大文件超时）");
    }
    if (j.code !== 0) throw new Error("SiYuan upload: " + (j.msg || "code=" + j.code));
    const map = (j.data && j.data.succMap) || {};
    const errFiles = (j.data && j.data.errFiles) || [];
    if (errFiles && errFiles.length && !Object.keys(map).length) {
      throw new Error("SiYuan upload errFiles: " + errFiles.join(", "));
    }
    const raw = map[fileName] || Object.values(map)[0] || null;
    if (!raw) throw new Error("SiYuan upload 未返回资源路径: " + fileName);
    return normalizeAssetLinkPath(raw);
  }

  // ── 文件 / 资源池（去重用） ──
  async readDir(path) {
    const d = await this.request("/api/file/readDir", { path });
    return Array.isArray(d) ? d : [];
  }

  async removeFile(path) {
    return this.request("/api/file/removeFile", { path });
  }

  async findReplaceAssetPath(fromPath, toPath) {
    const k = String(fromPath || "").replace(/^\/+/, "");
    const r = String(toPath || "").replace(/^\/+/, "");
    if (!k || !r || k === r) return { replaceCount: 0 };
    // ids 必须传数组，否则思源端会 panic
    return this.request("/api/search/findReplace", {
      k,
      r,
      query: k,
      ids: [],
      method: 0,
      paths: [],
      replaceTypes: {
        text: true,
        imgText: true,
        imgTitle: true,
        imgSrc: true,
        aText: true,
        aTitle: true,
        aHref: true,
        code: true,
        codeBlock: true,
        htmlBlock: true,
        inlineMemo: true,
        math: true,
        mathBlock: true,
      },
    });
  }

  /**
   * findReplace 改不到 NodeAudio/NodeVideo 的 src。
   * 对仍含旧路径的文档：导出 Markdown → 替换 → updateBlock。
   */
  async rewriteAssetRefsInDocs(fromPath, toPath, opts) {
    opts = opts || {};
    const from = normalizeAssetLinkPath(String(fromPath || "").replace(/^data\//, ""));
    const to = normalizeAssetLinkPath(String(toPath || "").replace(/^data\//, ""));
    if (!from || !to || from === to) return { docs: 0, changed: 0 };
    const fromName = from.split("/").pop();
    const toName = to.split("/").pop();
    if (!fromName) return { docs: 0, changed: 0 };
    const safe = fromName.replace(/'/g, "''");
    const rows = await this.request("/api/query/sql", {
      stmt:
        "SELECT DISTINCT root_id FROM blocks WHERE markdown LIKE '%" + safe + "%' LIMIT 2000",
    });
    const ids = Array.from(new Set((Array.isArray(rows) ? rows : []).map(r => r && r.root_id).filter(Boolean)));
    let changed = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (opts.onProgress) {
        opts.onProgress({
          message: opts.progressMessage || `改文档引用 ${i + 1}/${ids.length}`,
          current: i + 1,
          total: ids.length,
          detail: fromName + " → " + toName,
        });
      }
      try {
        let md = await this.getDocMd(id);
        if (!md || (md.indexOf(from) < 0 && md.indexOf(fromName) < 0)) continue;
        let next = md.split(from).join(to);
        if (next === md && fromName !== toName) {
          next = md.split(fromName).join(toName);
        }
        if (next === md) continue;
        await this.updateDoc(id, next);
        changed++;
      } catch (e) {
        console.warn("[SiPush] 文档改引用失败:", id, from, "→", to, e.message);
      }
      await yieldUi();
    }
    return { docs: ids.length, changed };
  }

  async removeUnusedAsset(path) {
    return this.request("/api/asset/removeUnusedAsset", { path });
  }

  async statAsset(path) {
    // path 形如 assets/xxx.png
    const d = await this.request("/api/asset/statAsset", { path });
    return d || {};
  }

  /** getFile 返回原始字节，不能走 JSON request */
  async getFileBinary(path) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Token " + this.token;
    let resp;
    try {
      resp = await fetch(this.url + "/api/file/getFile", {
        method: "POST",
        headers,
        body: JSON.stringify({ path }),
      });
    } catch (e) {
      throw new Error("读取思源文件失败: " + e.message);
    }
    if (resp.status === 202) {
      let msg = "文件不存在或无法读取";
      try {
        const j = await resp.json();
        if (j && j.msg) msg = j.msg;
        else if (j && j.code) msg = "code=" + j.code;
      } catch (e) { /* ignore */ }
      throw new Error(msg + ": " + path);
    }
    if (!resp.ok) throw new Error("读取思源文件 HTTP " + resp.status + ": " + path);
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const j = await resp.json();
      if (j && j.code && j.code !== 0) throw new Error((j.msg || "code=" + j.code) + ": " + path);
      throw new Error("getFile 返回了 JSON 而非文件内容: " + path);
    }
    return await resp.arrayBuffer();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 冲突解决弹窗
// ═══════════════════════════════════════════════════════════════════
class ConflictModal extends Modal {
  constructor(app, obsMd, siMd, title) {
    super(app); this.obsMd = obsMd; this.siMd = siMd; this.title = title;
    this._resolve = null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-conflict-modal");
    const { contentEl } = this;
    contentEl.addClass("si-push-conflict-modal");
    contentEl.createEl("h2", { text: "⚠️ 同步冲突" });
    contentEl.createEl("p", { cls: "si-push-conflict-desc", text: `"${this.title}" 在 Obsidian 和思源中都修改过。` });
    const panes = contentEl.createDiv({ cls: "si-push-conflict-panes" });
    const p1 = panes.createDiv({ cls: "si-push-conflict-pane" });
    p1.createEl("h3", { text: "📝 Obsidian" });
    p1.createEl("pre", { text: this.obsMd.substring(0, 500) + (this.obsMd.length > 500 ? "\n...[截断]" : "") });
    const p2 = panes.createDiv({ cls: "si-push-conflict-pane" });
    p2.createEl("h3", { text: "📓 思源笔记" });
    const cleanSiMd = this.siMd ? stripSiTitle(this.siMd) : "";
    const siPreview = cleanSiMd ? (cleanSiMd.substring(0, 500) + (cleanSiMd.length > 500 ? "\n...[截断]" : "")) : "(思源文档无内容或已删除)";
    p2.createEl("pre", { text: siPreview });
    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    const b1 = acts.createEl("button", { text: "📝 保留 Obsidian", cls: "mod-cta" });
    b1.onclick = () => { if (this._resolve) this._resolve("obsidian"); this.close(); };
    const b2 = acts.createEl("button", { text: "📓 保留思源", cls: "mod-cta" });
    b2.style.marginLeft = "8px"; b2.onclick = () => { if (this._resolve) this._resolve("siyuan"); this.close(); };
    const b3 = acts.createEl("button", { text: "取消" });
    b3.style.marginLeft = "8px"; b3.onclick = () => { if (this._resolve) this._resolve("cancel"); this.close(); };
  }
  onClose() { this.contentEl.empty(); if (this._resolve) this._resolve("cancel"); }
  openAndResolve() { return new Promise(r => { this._resolve = r; this.open(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// 思源资源池去重（快速：文件名族 + 大小；可选严格哈希）
// ═══════════════════════════════════════════════════════════════════
class AssetDedupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.phase = "idle"; // idle | scanning | report | applying | done
    this.plan = null;
    this.applyResult = null;
    // 默认快速：同族同大小即视为重复，不读全文哈希
    this.strictHash = false;
    this._progress = { current: 0, total: 0, message: "", detail: "", stats: "" };
    this._progressEl = null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    this.render();
    this.startScan();
  }
  onClose() {
    this.contentEl.empty();
    if (this.plugin && this.plugin._assetDedupModal === this) this.plugin._assetDedupModal = null;
    try { this.plugin.refreshStatusBar(); } catch (e) { /* ignore */ }
  }

  /** 接受字符串，或 { message, current, total, detail, stats } */
  setProgress(info) {
    if (typeof info === "string") {
      this._progress.message = info;
    } else if (info && typeof info === "object") {
      if (info.message != null) this._progress.message = String(info.message);
      if (info.detail != null) this._progress.detail = String(info.detail);
      if (info.stats != null) this._progress.stats = String(info.stats);
      if (typeof info.current === "number") this._progress.current = info.current;
      if (typeof info.total === "number") this._progress.total = info.total;
      if (info.reset) {
        this._progress.current = info.current || 0;
        this._progress.total = info.total || 0;
        this._progress.detail = info.detail || "";
        this._progress.stats = info.stats || "";
        this._progress.message = info.message || this._progress.message;
      }
    }
    this.refreshProgress();
    const p = this._progress;
    if (this.plugin && typeof this.plugin.setStatusBarText === "function") {
      if (p.total > 0) {
        this.plugin.setStatusBarText(`去重 ${Math.min(p.current, p.total)}/${p.total}`);
      } else if (p.message) {
        this.plugin.setStatusBarText(String(p.message).slice(0, 36));
      }
    }
  }

  refreshProgress() {
    if (!this._progressEl) return;
    this.fillProgress(this._progressEl);
  }

  fillProgress(box) {
    box.empty();
    const p = this._progress;
    const busy = this.phase === "scanning" || this.phase === "applying";
    box.createEl("p", { text: p.message || (busy ? "进行中…" : "准备中…") });
    if (p.total > 0) {
      const shown = Math.min(Math.max(0, p.current), p.total);
      const pct = Math.min(100, Math.round((shown / p.total) * 100));
      box.createEl("p", { text: `进度：${shown}/${p.total}（${pct}%）` });
      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      const fill = bar.createDiv({ cls: "si-push-progress-fill" });
      fill.style.width = pct + "%";
    } else if (busy) {
      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      const fill = bar.createDiv({ cls: "si-push-progress-fill si-push-progress-indeterminate" });
      fill.style.width = "30%";
    }
    if (p.detail) {
      box.createEl("p", { cls: "si-push-doc-preview", text: p.detail });
    }
    if (p.stats) {
      box.createEl("p", { text: p.stats });
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-search-modal");
    contentEl.addClass("si-push-control-modal");
    contentEl.createEl("h2", { text: "🧹 思源资源池去重" });
    contentEl.createEl("p", {
      cls: "si-push-doc-preview",
      text: "只删除「重复副本」：同文件名族且同大小（或严格哈希相同）时，保留最早一份，其余副本先尽量改文档引用再删除。不会清理「仅未被引用」的独立文件。",
    });

    this._progressEl = contentEl.createDiv({ cls: "si-push-control-status" });
    this._progressEl.style.padding = "8px 0 12px";
    this.fillProgress(this._progressEl);

    if (this.phase === "idle" || this.phase === "report" || this.phase === "done") {
      const mode = contentEl.createDiv({ cls: "si-push-conflict-actions" });
      const label = mode.createEl("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      label.style.margin = "8px 0";
      const cb = label.createEl("input", { type: "checkbox" });
      cb.checked = !!this.strictHash;
      cb.onchange = () => { this.strictHash = !!cb.checked; };
      label.createSpan({ text: "严格模式：同族同大小仍计算 SHA-256（更慢，更稳）" });
    }

    if (this.phase === "scanning" || this.phase === "applying") {
      contentEl.createEl("p", {
        cls: "si-push-doc-preview",
        text: this.phase === "scanning"
          ? "正在扫描：枚举 → 归组 → 比大小 → 查引用。请勿关闭，进度见上方。"
          : "正在改引用并删除副本。请勿关闭，进度见上方。",
      });
      const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
      const close = acts.createEl("button", { text: "关闭（后台继续）" });
      close.onclick = () => this.close();
      return;
    }

    if ((this.phase === "report" || this.phase === "done") && this.plan) {
      const p = this.plan;
      const summary = contentEl.createDiv({ cls: "si-push-control-status" });
      summary.createEl("p", {
        text: `资源 ${p.totalFiles} · 候选族内 ${p.candidateCount || 0} · 重复组 ${p.groups.length} · 可删重复副本 ${p.duplicateCount} · 文档中已引用的副本 ${p.referencedDupCount || 0} · 预计释放 ${formatBytes(p.bytesSaved)}` +
          (p.mode === "strict" ? " · 严格哈希" : " · 快速模式"),
      });
      if (this.applyResult) {
        summary.createEl("p", {
          text: `已执行：改引用尝试 ${this.applyResult.replaced} · 删除重复副本 ${this.applyResult.deleted} · 失败 ${this.applyResult.failed}`,
        });
      }
      const list = contentEl.createDiv({ cls: "si-push-history-list" });
      list.style.maxHeight = "360px";
      list.style.overflow = "auto";
      const show = p.groups.slice(0, 40);
      for (const g of show) {
        const row = list.createDiv({ cls: "si-push-history-item" });
        row.createEl("div", {
          text: `${g.files.length} 份 · ${formatBytes(g.size)} · 保留 ${g.keep.name}`,
        });
        const refN = (g.remove || []).filter(x => x.referenced).length;
        row.createEl("div", {
          cls: "si-push-doc-preview",
          text: `将删重复副本 ${g.remove.length}（文档已引用 ${refN}）：` + g.remove.map(f => f.name).join(" 、 "),
        });
      }
      if (p.groups.length > show.length) {
        contentEl.createEl("p", { text: `…其余 ${p.groups.length - show.length} 组已省略` });
      }
    }

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    if (this.phase === "report" && this.plan && this.plan.groups.length) {
      const go = acts.createEl("button", { text: "执行去重（只删重复副本）", cls: "mod-cta" });
      go.onclick = () => this.startApply();
      const rescan = acts.createEl("button", { text: "重新扫描" });
      rescan.style.marginLeft = "8px";
      rescan.onclick = () => this.startScan();
    } else if (this.phase === "report" && this.plan && !this.plan.groups.length) {
      const rescan = acts.createEl("button", { text: "重新扫描", cls: "mod-cta" });
      rescan.onclick = () => this.startScan();
    } else if (this.phase === "done") {
      const repair = acts.createEl("button", { text: "🔗 修复附件断链", cls: "mod-cta" });
      repair.onclick = () => {
        this.close();
        this.plugin.repairBrokenAssetRefs();
      };
      const rescan = acts.createEl("button", { text: "再扫一次" });
      rescan.style.marginLeft = "8px";
      rescan.onclick = () => this.startScan();
    }
    const close = acts.createEl("button", { text: "关闭" });
    close.style.marginLeft = "8px";
    close.onclick = () => this.close();
  }

  async startScan() {
    if (this.phase === "scanning" || this.phase === "applying") return;
    this.phase = "scanning";
    this.plan = null;
    this.applyResult = null;
    this._progress = { current: 0, total: 0, message: "开始扫描…", detail: "", stats: "" };
    this.render();
    try {
      this.plan = await this.plugin.scanSiYuanAssetDuplicates({
        onProgress: (info) => this.setProgress(info),
        strictHash: !!this.strictHash,
      });
      this.phase = "report";
      this.setProgress({
        reset: true,
        current: this.plan.groups.length,
        total: this.plan.groups.length || 1,
        message: this.plan.groups.length
          ? `扫描完成：${this.plan.groups.length} 组重复，可删副本 ${this.plan.duplicateCount}（其中文档已引用 ${this.plan.referencedDupCount || 0}）`
          : "扫描完成：未发现重复附件（不会删除任何文件）",
        detail: "规则：仅删除重复副本；独立/唯一文件即使未被引用也保留",
        stats: `资源 ${this.plan.totalFiles} · 可删重复副本 ${this.plan.duplicateCount} · 预计释放 ${formatBytes(this.plan.bytesSaved)}`,
      });
      this.render();
      try { this.plugin.refreshStatusBar(); } catch (e) { /* ignore */ }
    } catch (e) {
      this.phase = "idle";
      this.setProgress({ message: "扫描失败: " + e.message, current: 0, total: 0, detail: "" });
      this.render();
      new Notice("❌ 资源去重扫描失败: " + e.message, 8000);
      try { this.plugin.refreshStatusBar(); } catch (err) { /* ignore */ }
    }
  }

  async startApply() {
    if (!this.plan || !this.plan.groups.length || this.phase === "applying") return;
    this.phase = "applying";
    const totalDups = this.plan.groups.reduce((n, g) => n + ((g.remove && g.remove.length) || 0), 0);
    this._progress = {
      current: 0,
      total: Math.max(1, totalDups),
      message: "开始执行去重…",
      detail: "",
      stats: `共 ${this.plan.groups.length} 组 · ${totalDups} 个副本`,
    };
    this.render();
    try {
      this.applyResult = await this.plugin.applySiYuanAssetDedup(this.plan, {
        onProgress: (info) => this.setProgress(info),
      });
      this.phase = "done";
      this.setProgress({
        reset: true,
        current: this.applyResult.deleted + this.applyResult.failed,
        total: totalDups || 1,
        message: `去重完成：删除重复副本 ${this.applyResult.deleted} 个`,
        detail: "",
        stats: `改引用尝试 ${this.applyResult.replaced} · 失败 ${this.applyResult.failed}`,
      });
      this.render();
      new Notice(`✅ 资源去重完成：删重复副本 ${this.applyResult.deleted} · 改引用 ${this.applyResult.replaced}。若仍有音频打不开，请点「修复附件断链」。`, 10000);
      try { this.plugin.refreshStatusBar(); } catch (e) { /* ignore */ }
    } catch (e) {
      this.phase = "report";
      this.setProgress({ message: "执行失败: " + e.message, detail: "" });
      this.render();
      new Notice("❌ 资源去重执行失败: " + e.message, 8000);
      try { this.plugin.refreshStatusBar(); } catch (err) { /* ignore */ }
    }
  }
}

/** 通用长时间任务进度弹窗（修复/清理等） */
class AssetOpProgressModal extends Modal {
  constructor(app, plugin, title) {
    super(app);
    this.plugin = plugin;
    this.titleText = title || "进行中";
    this._progress = { current: 0, total: 0, message: "准备中…", detail: "", stats: "" };
    this._progressEl = null;
    this._done = false;
    this._resultText = "";
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    this.render();
  }
  onClose() {
    this.contentEl.empty();
    try { this.plugin.refreshStatusBar(); } catch (e) { /* ignore */ }
  }
  setProgress(info) {
    if (typeof info === "string") {
      this._progress.message = info;
    } else if (info && typeof info === "object") {
      if (info.message != null) this._progress.message = String(info.message);
      if (info.detail != null) this._progress.detail = String(info.detail);
      if (info.stats != null) this._progress.stats = String(info.stats);
      if (typeof info.current === "number") this._progress.current = info.current;
      if (typeof info.total === "number") this._progress.total = info.total;
    }
    if (!this._progressEl) this.render();
    else this.fillProgress(this._progressEl);
    const p = this._progress;
    if (this.plugin && typeof this.plugin.setStatusBarText === "function") {
      if (p.total > 0) this.plugin.setStatusBarText(`${this.titleText} ${Math.min(p.current, p.total)}/${p.total}`);
      else if (p.message) this.plugin.setStatusBarText(String(p.message).slice(0, 36));
    }
  }
  markDone(text) {
    this._done = true;
    this._resultText = text || "已完成";
    this._progress.message = this._resultText;
    this.render();
  }
  fillProgress(box) {
    box.empty();
    const p = this._progress;
    box.createEl("p", { text: p.message || "进行中…" });
    if (p.total > 0) {
      const shown = Math.min(Math.max(0, p.current), p.total);
      const pct = Math.min(100, Math.round((shown / p.total) * 100));
      box.createEl("p", { text: `进度：${shown}/${p.total}（${pct}%）` });
      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      const fill = bar.createDiv({ cls: "si-push-progress-fill" });
      fill.style.width = pct + "%";
    } else if (!this._done) {
      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      bar.createDiv({ cls: "si-push-progress-fill si-push-progress-indeterminate" }).style.width = "30%";
    }
    if (p.detail) box.createEl("p", { cls: "si-push-doc-preview", text: p.detail });
    if (p.stats) box.createEl("p", { text: p.stats });
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-search-modal");
    contentEl.addClass("si-push-control-modal");
    contentEl.createEl("h2", { text: this.titleText });
    this._progressEl = contentEl.createDiv({ cls: "si-push-control-status" });
    this._progressEl.style.padding = "8px 0 12px";
    this.fillProgress(this._progressEl);
    if (!this._done) {
      contentEl.createEl("p", { cls: "si-push-doc-preview", text: "任务进行中，进度见上方；关闭弹窗不会中断（若已在跑）。" });
    }
    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    acts.createEl("button", { text: this._done ? "关闭" : "关闭弹窗", cls: this._done ? "mod-cta" : "" }).onclick = () => this.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 同步报告弹窗
// ═══════════════════════════════════════════════════════════════════
class SyncReportModal extends Modal {
  constructor(app, results, plugin) {
    super(app);
    this.results = results;
    this.plugin = plugin || null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    const { contentEl } = this;
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "🔄 同步报告" });
    const r = this.results;
    const total = (r.synced || 0) + (r.failed || 0) + (r.conflicts || 0) + (r.skipped || 0);
    const s = contentEl.createDiv();
    s.style.textAlign = "center"; s.style.padding = "16px";
    const failN = (this.plugin && (this.plugin.settings.failedQueue || []).length) || r.failed || 0;
    const html = `<p style="font-size:18px;font-weight:600">共 ${total} 篇</p><p>✅ 已同步 ${r.synced || 0} &nbsp; ⚠️ 冲突 ${r.conflicts || 0} &nbsp; ❌ 失败 ${r.failed || 0}` +
      (r.skipped > 0 ? ` &nbsp; ⏭️ 跳过 ${r.skipped}` : "") +
      (r.assets > 0 ? ` &nbsp; 🖼️ 资源 ${r.assets}` : "") +
      (r.deleted > 0 ? ` &nbsp; 🗑️ 已删除 ${r.deleted}` : "") + `</p>` +
      (r.repairNote
        ? `<p>🔧 收尾修复：${r.repairNote}` +
          ((r.repairAvFixed || r.repairBrokenPairs)
            ? `（音视频 ${r.repairAvFixed || 0} · 断链路径 ${r.repairBrokenPairs || 0} · 文档 ${r.repairBrokenDocs || 0}）`
            : "") +
          `</p>`
        : "") +
      (failN > 0 ? `<p class="si-push-error">失败已记入队列（当前积压 ${failN} 篇），可稍后重试</p>` : "");
    s.innerHTML = html;

    const fails = (r.details || []).filter(d => d.status === "error" || d.status === "failed");
    const showList = fails.length ? fails : (r.details || []).slice(0, 50);
    if (showList.length) {
      contentEl.createEl("h3", { text: fails.length ? "❌ 失败明细" : "部分明细" });
      const list = contentEl.createEl("ul", { cls: "si-push-doc-list" });
      list.style.maxHeight = "280px"; list.style.overflowY = "auto";
      for (const d of showList) {
        const li = list.createEl("li", { cls: "si-push-doc-item" });
        const ic = d.status === "success" ? "✅" : d.status === "conflict" ? "⚠️" : d.status === "deleted" ? "🗑️" : "❌";
        li.createEl("div", { text: ic + " " + d.title });
        li.createEl("div", { cls: "si-push-doc-preview", text: d.direction + (d.detail ? " — " + d.detail : "") });
      }
    }

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    if (this.plugin) {
      addBackToControlButton(acts, this, this.plugin);
      const b1 = acts.createEl("button", { text: "📋 查看失败队列" });
      b1.onclick = () => { this.close(); this.plugin.openPushHistory(); };
      if (failN > 0) {
        const b2 = acts.createEl("button", { text: "🔁 重试失败项" });
        b2.onclick = () => {
          this.close();
          window.setTimeout(() => this.plugin.retryFailedQueue(), 50);
        };
      }
    }
    const cb = acts.createEl("button", { text: "关闭" });
    cb.onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

// ═══════════════════════════════════════════════════════════════════
// 推送历史 / 失败队列弹窗
// ═══════════════════════════════════════════════════════════════════
class PushHistoryModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    this.render();
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "📋 推送历史与失败队列" });

    const hist = this.plugin.settings.syncHistory || [];
    const queue = this.plugin.settings.failedQueue || [];

    const sum = contentEl.createDiv();
    sum.style.padding = "8px 0 16px";
    if (hist.length) {
      const last = hist[0];
      sum.createEl("p", {
        text: `最近一次：✅ ${last.synced || 0} 成功 / ❌ ${last.failed || 0} 失败` +
          (last.time ? ` · ${formatTime(last.time)}` : ""),
      });
    } else {
      sum.createEl("p", { text: "暂无同步历史" });
    }
    sum.createEl("p", {
      cls: queue.length ? "si-push-error" : "si-push-success",
      text: queue.length ? `失败队列积压 ${queue.length} 篇（修好后可重试）` : "✅ 失败队列为空",
    });

    if (hist.length > 1) {
      contentEl.createEl("h3", { text: "历史摘要" });
      const hl = contentEl.createEl("ul", { cls: "si-push-doc-list" });
      hl.style.maxHeight = "120px"; hl.style.overflowY = "auto";
      for (const h of hist.slice(0, 10)) {
        const li = hl.createEl("li", { cls: "si-push-doc-item" });
        li.createEl("div", {
          text: `${formatTime(h.time)}  ✅${h.synced || 0}  ❌${h.failed || 0}` +
            (h.assets ? `  🖼️${h.assets}` : ""),
        });
      }
    }

    contentEl.createEl("h3", { text: "失败队列" });
    if (!queue.length) {
      contentEl.createEl("div", { text: "没有待重试的失败项", cls: "si-push-search-hint" });
    } else {
      const list = contentEl.createEl("ul", { cls: "si-push-doc-list" });
      list.style.maxHeight = "320px"; list.style.overflowY = "auto";
      for (const item of queue) {
        const li = list.createEl("li", { cls: "si-push-doc-item" });
        li.createEl("div", { text: "❌ " + item.path, cls: "si-push-doc-path" });
        li.createEl("div", {
          cls: "si-push-doc-preview",
          text: (item.error || "") + (item.time ? " · " + formatTime(item.time) : "") +
            (item.retries ? ` · 已重试 ${item.retries} 次` : ""),
        });
      }
    }

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    addBackToControlButton(acts, this, this.plugin);
    if (queue.length) {
      const retry = acts.createEl("button", { text: "🔁 重试全部失败项" });
      retry.onclick = () => {
        this.close();
        window.setTimeout(() => this.plugin.retryFailedQueue(), 50);
      };
      const exp = acts.createEl("button", { text: "📝 导出失败列表到笔记" });
      exp.onclick = async () => {
        await this.plugin.exportFailedReport();
        new Notice("✅ 已写入笔记：SiPush-推送失败队列.md");
      };
      const clear = acts.createEl("button", { text: "清空失败队列" });
      clear.onclick = async () => {
        this.plugin.settings.failedQueue = [];
        await this.plugin.saveSettings();
        this.plugin.refreshStatusBar();
        this.render();
      };
    }
    const close = acts.createEl("button", { text: "关闭" });
    close.onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

// ═══════════════════════════════════════════════════════════════════
// 通用：返回推送控制台
// ═══════════════════════════════════════════════════════════════════
function goBackToPushControl(modal, plugin) {
  if (modal) modal.close();
  if (plugin && typeof plugin.openPushControl === "function") {
    window.setTimeout(() => plugin.openPushControl(), 0);
  }
}
function addBackToControlButton(actsEl, modal, plugin, opts) {
  opts = opts || {};
  const back = actsEl.createEl("button", {
    text: opts.text || "← 返回推送控制台",
    cls: opts.cta === false ? "" : "mod-cta",
  });
  back.onclick = () => goBackToPushControl(modal, plugin);
  return back;
}

// ═══════════════════════════════════════════════════════════════════
// 选择文件夹 / 从指定位置重推（带返回控制台）
// ═══════════════════════════════════════════════════════════════════
class PathPickModal extends Modal {
  constructor(app, plugin, opts) {
    super(app);
    this.plugin = plugin;
    this.titleText = (opts && opts.title) || "请选择";
    this.hint = (opts && opts.hint) || "";
    this.items = (opts && opts.items) || []; // [{ text, value }]
    this.onChooseCb = opts && opts.onChoose;
    this.filter = "";
    this._listEl = null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    this.render();
  }
  filteredItems() {
    const q = (this.filter || "").trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(it => (it.text || "").toLowerCase().includes(q));
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: this.titleText });
    if (this.hint) contentEl.createEl("p", { cls: "si-push-doc-preview", text: this.hint });

    const inp = contentEl.createEl("input", {
      type: "text",
      placeholder: "筛选…",
      cls: "si-push-tree-search",
    });
    Object.assign(inp.style, { width: "100%", margin: "8px 0", padding: "8px" });
    inp.value = this.filter;
    inp.oninput = () => {
      this.filter = inp.value;
      this.renderList();
    };

    this._listEl = contentEl.createEl("ul", { cls: "si-push-doc-list" });
    this._listEl.style.maxHeight = "50vh";
    this._listEl.style.overflowY = "auto";
    this.renderList();

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    acts.style.marginTop = "12px";
    addBackToControlButton(acts, this, this.plugin);
    const close = acts.createEl("button", { text: "关闭" });
    close.onclick = () => this.close();
    inp.focus();
  }
  renderList() {
    if (!this._listEl) return;
    this._listEl.empty();
    const list = this.filteredItems();
    if (!list.length) {
      this._listEl.createEl("li", { cls: "si-push-search-hint", text: "没有匹配项" });
      return;
    }
    for (const it of list) {
      const li = this._listEl.createEl("li", { cls: "si-push-doc-item" });
      li.createEl("div", { text: it.text, cls: "si-push-doc-path" });
      li.onclick = () => {
        this.close();
        if (this.onChooseCb) this.onChooseCb(it.value);
      };
    }
  }
  onClose() { this.contentEl.empty(); }
}

class FolderSuggestModal {
  /** 兼容旧调用：new FolderSuggestModal(app, cb).open() 或带 plugin */
  constructor(app, onChoose, plugin) {
    this.app = app;
    this.onChoose = onChoose;
    this.plugin = plugin || null;
  }
  open() {
    const map = new Map();
    map.set("", "(整个仓库)");
    for (const f of this.app.vault.getMarkdownFiles()) {
      let folder = f.parent;
      while (folder) {
        if (folder.path && !folder.path.startsWith(".obsidian") && !folder.path.startsWith(".trash")) {
          if (!map.has(folder.path)) map.set(folder.path, folder.path);
        }
        folder = folder.parent;
      }
    }
    const items = Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, text]) => ({ value: path, text: text || "(整个仓库)" }));
    new PathPickModal(this.app, this.plugin, {
      title: "📁 选择要推送的文件夹",
      hint: "点选后开始推送；可用「返回推送控制台」回去。",
      items,
      onChoose: this.onChoose,
    }).open();
  }
}

class StartFromSuggestModal {
  constructor(app, paths, onChoose, plugin) {
    this.app = app;
    this.paths = paths || [];
    this.onChoose = onChoose;
    this.plugin = plugin || null;
  }
  open() {
    const items = (this.paths || []).map(p => ({ value: p, text: p }));
    new PathPickModal(this.app, this.plugin, {
      title: "⏭ 从指定位置重新推送",
      hint: "选择从哪一篇开始；可用「返回推送控制台」回去。",
      items,
      onChoose: this.onChoose,
    }).open();
  }
}

class VaultTreeSelectModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.selected = new Set(); // file paths
    this.expanded = new Set([""]); // folder paths；根默认展开
    this.filter = "";
    this.tree = null;
    this._countEl = null;
  }

  onOpen() {
    this.modalEl.addClass("si-push-tree-modal");
    this.tree = this.buildTree();
    this.render();
  }

  buildTree() {
    const root = { name: "仓库根目录", path: "", isFile: false, children: [], fileCount: 0 };
    const folderMap = new Map();
    folderMap.set("", root);

    const ensureFolder = (folderPath) => {
      if (folderMap.has(folderPath)) return folderMap.get(folderPath);
      const parts = folderPath.split("/").filter(Boolean);
      let parentPath = "";
      let parent = root;
      for (const part of parts) {
        const curPath = parentPath ? parentPath + "/" + part : part;
        if (!folderMap.has(curPath)) {
          const node = { name: part, path: curPath, isFile: false, children: [], fileCount: 0 };
          parent.children.push(node);
          folderMap.set(curPath, node);
        }
        parent = folderMap.get(curPath);
        parentPath = curPath;
      }
      return parent;
    };

    const files = this.app.vault.getMarkdownFiles()
      .filter(f => !f.path.startsWith(".obsidian/") && !f.path.startsWith(".trash/"))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      const folderPath = file.parent ? file.parent.path : "";
      const folder = ensureFolder(folderPath);
      folder.children.push({
        name: file.basename,
        path: file.path,
        isFile: true,
        children: [],
        fileCount: 1,
      });
    }

    const sortAndCount = (node) => {
      node.children.sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return a.name.localeCompare(b.name, "zh");
      });
      let n = 0;
      for (const c of node.children) {
        if (c.isFile) n += 1;
        else n += sortAndCount(c);
      }
      node.fileCount = n;
      return n;
    };
    sortAndCount(root);
    return root;
  }

  collectFiles(node, out) {
    if (node.isFile) out.push(node.path);
    else for (const c of node.children) this.collectFiles(c, out);
  }

  findNode(path, node) {
    node = node || this.tree;
    if (node.path === path) return node;
    for (const c of node.children) {
      const hit = this.findNode(path, c);
      if (hit) return hit;
    }
    return null;
  }

  setFolderChecked(node, checked) {
    const files = [];
    this.collectFiles(node, files);
    for (const p of files) {
      if (checked) this.selected.add(p);
      else this.selected.delete(p);
    }
  }

  folderCheckState(node) {
    const files = [];
    this.collectFiles(node, files);
    if (!files.length) return "none";
    let n = 0;
    for (const p of files) if (this.selected.has(p)) n++;
    if (n === 0) return "none";
    if (n === files.length) return "all";
    return "partial";
  }

  nodeMatchesFilter(node) {
    const q = (this.filter || "").trim().toLowerCase();
    if (!q) return true;
    if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) return true;
    if (!node.isFile) {
      for (const c of node.children) if (this.nodeMatchesFilter(c)) return true;
    }
    return false;
  }

  updateCount() {
    if (this._countEl) this._countEl.setText(`已选 ${this.selected.size} 篇`);
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-tree-modal-body");
    contentEl.createEl("h2", { text: "🌲 勾选要同步到思源的文档" });
    contentEl.createEl("p", {
      cls: "si-push-doc-preview",
      text: "展开文件夹树，勾选文件或整个文件夹；确认后只推送勾选项。",
    });

    const toolbar = contentEl.createDiv({ cls: "si-push-tree-toolbar" });
    const search = toolbar.createEl("input", {
      type: "text",
      placeholder: "筛选文件夹 / 文件名…",
      cls: "si-push-tree-search",
    });
    search.value = this.filter;
    search.oninput = () => {
      this.filter = search.value;
      // 有筛选时自动展开匹配路径的祖先
      if (this.filter.trim()) this.expandMatches(this.tree);
      this.renderTreeOnly();
    };

    const btns = toolbar.createDiv({ cls: "si-push-tree-toolbar-btns" });
    const mk = (t) => {
      const b = btns.createEl("button", { text: t });
      b.style.marginLeft = "6px";
      return b;
    };
    mk("全选").onclick = () => {
      this.setFolderChecked(this.tree, true);
      this.renderTreeOnly();
    };
    mk("清空").onclick = () => {
      this.selected.clear();
      this.renderTreeOnly();
    };
    mk("全部展开").onclick = () => {
      this.expandAll(this.tree);
      this.renderTreeOnly();
    };
    mk("全部折叠").onclick = () => {
      this.expanded = new Set([""]);
      this.renderTreeOnly();
    };

    this._countEl = toolbar.createSpan({ cls: "si-push-tree-count", text: `已选 ${this.selected.size} 篇` });

    this._treeHost = contentEl.createDiv({ cls: "si-push-tree-host" });
    this.renderTreeOnly();

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    acts.style.marginTop = "12px";
    addBackToControlButton(acts, this, this.plugin);
    const go = acts.createEl("button", { text: "开始推送勾选项", cls: "mod-cta" });
    go.onclick = () => {
      const paths = Array.from(this.selected).sort((a, b) => a.localeCompare(b));
      if (!paths.length) {
        new Notice("请先勾选至少一篇笔记");
        return;
      }
      this.close();
      this.plugin.startPushJob({
        paths,
        label: `勾选推送（${paths.length} 篇）`,
      });
    };
    const close = acts.createEl("button", { text: "关闭" });
    close.onclick = () => this.close();
  }

  renderTreeOnly() {
    if (!this._treeHost) return;
    this._treeHost.empty();
    this.renderNode(this.tree, this._treeHost, 0);
    this.updateCount();
  }

  expandAll(node) {
    if (!node.isFile) {
      this.expanded.add(node.path);
      for (const c of node.children) this.expandAll(c);
    }
  }

  expandMatches(node) {
    if (node.isFile) return this.nodeMatchesFilter(node);
    let any = false;
    for (const c of node.children) {
      if (this.expandMatches(c)) any = true;
    }
    if (any || this.nodeMatchesFilter(node)) this.expanded.add(node.path);
    return any || this.nodeMatchesFilter(node);
  }

  renderNode(node, parentEl, depth) {
    if (!this.nodeMatchesFilter(node)) return;

    const row = parentEl.createDiv({ cls: "si-push-tree-row" });
    row.style.paddingLeft = (8 + depth * 16) + "px";

    // 展开按钮
    const twisty = row.createSpan({ cls: "si-push-tree-twisty" });
    if (!node.isFile && node.children.length) {
      const open = this.expanded.has(node.path);
      twisty.setText(open ? "▼" : "▶");
      twisty.onclick = (e) => {
        e.stopPropagation();
        if (this.expanded.has(node.path)) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.renderTreeOnly();
      };
    } else {
      twisty.setText(" ");
    }

    // 勾选
    const cb = row.createEl("input", { type: "checkbox", cls: "si-push-tree-check" });
    if (node.isFile) {
      cb.checked = this.selected.has(node.path);
      cb.onchange = () => {
        if (cb.checked) this.selected.add(node.path);
        else this.selected.delete(node.path);
        this.renderTreeOnly();
      };
    } else {
      const st = this.folderCheckState(node);
      cb.checked = st === "all";
      cb.indeterminate = st === "partial";
      cb.onchange = () => {
        this.setFolderChecked(node, cb.checked);
        this.renderTreeOnly();
      };
    }

    const icon = row.createSpan({ cls: "si-push-tree-icon", text: node.isFile ? "📄" : "📁" });
    const label = row.createSpan({
      cls: "si-push-tree-label" + (node.isFile ? " is-file" : " is-folder"),
      text: node.isFile ? node.name : `${node.name}（${node.fileCount}）`,
    });
    if (!node.isFile) {
      label.onclick = () => {
        if (this.expanded.has(node.path)) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.renderTreeOnly();
      };
    }

    // 子节点
    if (!node.isFile && this.expanded.has(node.path)) {
      for (const c of node.children) this.renderNode(c, parentEl, depth + 1);
    }
  }

  onClose() { this.contentEl.empty(); }
}

class PushControlModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this._timer = null;
    this._statusEl = null;
    this._failBtn = null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-control-modal");
    this.plugin._controlModal = this;
    this.render();
    // 定时拉最新进度（任务在后台跑时，关掉再开也能跟上）
    this._timer = window.setInterval(() => {
      try { this.refreshProgress(); } catch (e) { /* ignore */ }
    }, 400);
    // 若状态是 running 但循环意外停了，自动续跑（绝不因关控制台而暂停）
    const job = this.plugin.settings.pushJob;
    if (job && job.status === "running" && !this.plugin._jobLoopRunning) {
      this.plugin.runPushJobLoop().catch(e => console.warn("[SiPush] 续跑失败:", e));
    }
  }
  onClose() {
    // 只关 UI，不暂停、不取消后台推送
    if (this._timer) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
    if (this.plugin._controlModal === this) this.plugin._controlModal = null;
    this.contentEl.empty();
  }

  /** 仅刷新顶部进度区，避免整页重绘打断操作 */
  refreshProgress() {
    if (!this._statusEl) return;
    this.fillStatus(this._statusEl);
    const failN = (this.plugin.settings.failedQueue || []).length;
    if (this._failBtn) {
      this._failBtn.setText(failN ? `📋 失败队列（${failN}）` : "📋 失败队列");
    }
  }

  fillStatus(box) {
    box.empty();
    const job = this.plugin.settings.pushJob;
    const looping = !!this.plugin._jobLoopRunning;
    const unfinished = this.plugin.jobHasUnfinishedWork(job);
    // idle/done 但还有未跑完的上传/双链时，仍展示进度（避免取消后误以为「没有任务」）
    if (!job || ((job.status === "idle" || job.status === "done") && !unfinished)) {
      box.createEl("p", { text: "当前没有进行中的推送任务" });
    } else {
      const total = Math.max(1, (job.paths || []).length);
      const isRepair = job.phase === "repair";
      const cur = isRepair
        ? (job.repairCurrent || 0)
        : (job.phase === "wikilinks" ? (job.wikiCursor || 0) : (job.cursor || 0));
      const repairTotal = Math.max(1, job.repairTotal || 1);
      const shown = isRepair ? Math.min(cur, repairTotal) : Math.min(cur, total);
      const pctBase = isRepair ? repairTotal : total;
      const pct = Math.min(100, Math.round((shown / pctBase) * 100));
      const phaseText = isRepair
        ? "收尾修复"
        : (job.phase === "wikilinks" ? "写入双链" : "上传文档");
      let statusText = job.status === "paused" ? "已暂停 ⏸" : (job.status === "running" ? "进行中 ▶️" : job.status);
      if (job.status === "running" && looping) statusText = "后台推送中 ▶️";
      if ((job.status === "idle" || job.status === "done") && unfinished) {
        statusText = "未完成（可继续）⏸";
      }
      box.createEl("p", { text: `状态：${statusText} · ${job.label || ""}` });
      box.createEl("p", {
        text: isRepair
          ? `进度：${phaseText} ${shown}/${repairTotal}（${pct}%）`
          : `进度：${phaseText} ${shown}/${total}（${pct}%）`,
      });

      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      const fill = bar.createDiv({ cls: "si-push-progress-fill" });
      fill.style.width = pct + "%";

      if (isRepair && job.repairDetail) {
        box.createEl("p", { cls: "si-push-doc-preview", text: job.repairDetail });
      } else if (!isRepair && job.paths && job.paths[Math.min(shown, total - 1)]) {
        box.createEl("p", {
          cls: "si-push-doc-preview",
          text: (job.status === "running" ? "正在处理：" : "当前/下一篇：") + job.paths[Math.min(shown, total - 1)],
        });
      }
      box.createEl("p", {
        text: `本轮 ✅${(job.results && job.results.synced) || 0}  ❌${(job.results && job.results.failed) || 0}` +
          ((job.results && job.results.assets) ? `  🖼️${job.results.assets}` : "") +
          ((job.results && job.results.repairNote) ? `  🔧${job.results.repairNote}` : ""),
      });
      // 上传阶段中断时，思源里仍是 [[笔记]]，还没有 ((id)) 可点双链
      if (unfinished && job.phase === "upload" && (job.cursor || 0) > 0) {
        box.createEl("p", {
          cls: "si-push-error",
          text: "⚠ 双链尚未写入：上传中断时思源正文仍是 [[笔记]]。请点「继续」跑完，或点「仅回写双链」。",
        });
      }
      if (job.status === "running") {
        box.createEl("p", {
          cls: "si-push-doc-preview",
          text: isRepair
            ? "正在自动修复音视频引用与附件断链，完成后会出报告。"
            : "提示：关闭控制台不会暂停，任务在后台继续；再打开即可看最新进度。",
        });
      }
    }
    const failN = (this.plugin.settings.failedQueue || []).length;
    if (failN > 0) {
      box.createEl("p", { cls: "si-push-error", text: `失败队列积压 ${failN} 篇，可在下方查看 / 重试` });
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("si-push-search-modal");
    contentEl.addClass("si-push-control-modal");
    contentEl.createEl("h2", { text: "🚀 SiPush 推送控制台" });

    this._statusEl = contentEl.createDiv({ cls: "si-push-control-status" });
    this._statusEl.style.padding = "8px 0 16px";
    this.fillStatus(this._statusEl);

    const failN = (this.plugin.settings.failedQueue || []).length;
    const mkBtn = (parent, text, cls) => {
      const b = parent.createEl("button", { text, cls: cls || "" });
      b.style.margin = "4px";
      return b;
    };

    contentEl.createEl("h3", { text: "开始推送" });
    const startActs = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    mkBtn(startActs, "🌲 树状勾选推送", "mod-cta").onclick = () => {
      this.close();
      this.plugin.openVaultTreeSelect();
    };
    // 以下任务启动后控制台保持打开，实时看进度
    mkBtn(startActs, "一键全库推送").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.pushAllVault();
    };
    mkBtn(startActs, "选择文件夹").onclick = () => {
      this.close();
      new FolderSuggestModal(this.app, (folderPath) => {
        this.plugin.pushFolder(folderPath);
      }, this.plugin).open();
    };
    mkBtn(startActs, "当前文件夹").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.pushCurrentFolder();
    };
    mkBtn(startActs, "仅当前笔记").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.pushCurrentNoteOnly();
    };

    contentEl.createEl("h3", { text: "同步" });
    const syncActs = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    mkBtn(syncActs, "同步当前笔记").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.syncCurrentNote();
    };
    mkBtn(syncActs, "全库双向同步").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.batchSync();
    };
    mkBtn(syncActs, "按设置一键同步").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.oneClickSync();
    };

    contentEl.createEl("h3", { text: "任务控制" });
    const ctrl = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    mkBtn(ctrl, "⏸ 暂停").onclick = async () => { await this.plugin.pausePushJob(); this.refreshProgress(); };
    mkBtn(ctrl, "▶️ 继续", "mod-cta").onclick = () => { this.plugin.resumePushJob(); };
    mkBtn(ctrl, "从指定位置重推").onclick = () => {
      const paths = (this.plugin.settings.pushJob && this.plugin.settings.pushJob.paths)
        || this.plugin.listPushableFiles().map(f => f.path);
      if (!paths.length) { new Notice("没有可选择的笔记"); return; }
      this.close();
      new StartFromSuggestModal(this.app, paths, (path) => this.plugin.restartPushFrom(path), this.plugin).open();
    };
    mkBtn(ctrl, "🔗 仅回写双链").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.rewriteWikilinksOnly();
    };
    mkBtn(ctrl, "取消任务").onclick = async () => { await this.plugin.cancelPushJob(); this.refreshProgress(); };

    contentEl.createEl("h3", { text: "失败队列 / 其它" });
    const more = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    this._failBtn = mkBtn(more, failN ? `📋 失败队列（${failN}）` : "📋 失败队列");
    this._failBtn.onclick = () => {
      this.close();
      this.plugin.openPushHistory();
    };
    if (failN > 0) {
      mkBtn(more, "🔁 重试失败项").onclick = () => {
        // 控制台保持打开，直接开跑并刷新进度
        this.plugin.retryFailedQueue();
      };
    }
    mkBtn(more, "搜索思源并拉回").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.close();
      this.plugin.pullFromSiYuan();
    };
    mkBtn(more, "迁移 ID 到文末").onclick = () => {
      this.plugin.migrateAllPushIdsToFooter({ force: true });
    };
    mkBtn(more, "🧹 去重思源资源池", "mod-cta").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.close();
      this.plugin.openAssetDedup();
    };
    mkBtn(more, "🔗 修复附件断链", "mod-cta").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.repairBrokenAssetRefs();
    };
    mkBtn(more, "🔊 修复音视频引用").onclick = () => {
      if (!this.plugin.ensureConfigured()) return;
      this.plugin.repairSiYuanAudioVideoMarkup();
    };
    mkBtn(more, "测试思源连接").onclick = () => this.plugin.testConnection();

    const close = contentEl.createEl("button", { text: "关闭（后台继续推送）" });
    close.style.cssText = "display:block;margin:16px auto 0";
    close.title = "仅关闭窗口，不会暂停正在进行的推送";
    close.onclick = () => this.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 搜索拉回弹窗
// ═══════════════════════════════════════════════════════════════════
class SearchPullModal extends Modal {
  constructor(app, api, nb, plugin) {
    super(app);
    this.api = api;
    this.nb = nb;
    this.plugin = plugin || null;
    this.result = null;
    this._resolve = null;
  }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    const { contentEl } = this;
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "🔍 搜索思源文档并拉回 Obsidian" });
    const inp = contentEl.createEl("input", { type: "text", placeholder: "关键词搜索（留空列全部已关联）" });
    Object.assign(inp.style, { width: "100%", margin: "8px 0", padding: "8px" });
    const box = contentEl.createDiv();
    const btn = contentEl.createEl("button", { text: "🔍 搜索", cls: "mod-cta" });
    btn.onclick = async () => {
      box.empty(); box.createEl("div", { text: "搜索中...", cls: "si-push-search-hint" });
      try {
        const kw = inp.value.trim();
        let data = kw ? (await this.api.searchDoc(kw, this.nb)).blocks : await this.api.searchLinked(this.nb);
        box.empty();
        if (!data || !data.length) { box.createEl("div", { text: "未找到", cls: "si-push-search-hint" }); return; }
        const list = box.createEl("ul", { cls: "si-push-doc-list" });
        for (const b of data) {
          const li = list.createEl("li", { cls: "si-push-doc-item" });
          li.createEl("div", { text: b.hpath || "(无路径)", cls: "si-push-doc-path" });
          li.createEl("div", { text: (b.content || "").substring(0, 60), cls: "si-push-doc-preview" });
          li.onclick = () => { this.result = b; this.close(); };
        }
      } catch (e) {
        box.empty();
        box.createEl("div", { text: "失败: " + e.message, cls: "si-push-error" });
      }
    };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });

    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    acts.style.marginTop = "12px";
    if (this.plugin) addBackToControlButton(acts, this, this.plugin);
    const close = acts.createEl("button", { text: "关闭" });
    close.onclick = () => this.close();

    inp.focus();
  }
  onClose() { this.contentEl.empty(); if (this._resolve) this._resolve(this.result); }
  openAndGetResult() { return new Promise(r => { this._resolve = r; this.open(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// 主插件
// ═══════════════════════════════════════════════════════════════════
/** 思源默认不允许超过 7 层文档；超深路径压平，避免 createDocWithMd 失败 */
/** 叶子文档可以落在第 7 层；不能在第 7 层文档下再创建子文档 */
const SIYUAN_MAX_DOC_DEPTH = 7;
const SIYUAN_SAFE_DOC_DEPTH = 7;

function normalizeHPath(p) {
  let s = String(p == null ? "" : p).trim().replace(/\\/g, "/");
  if (!s) return "";
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/").replace(/\/$/, "");
  return s || "/";
}

function buildPath(defaultPath, fileOrTitle, preserveFolder, maxDepth) {
  // defaultPath 为空或 "/" 时，文档建在笔记本根下（不再强制 /Obsidian）
  let prefix = String(defaultPath == null ? "/Obsidian/" : defaultPath).trim();
  if (prefix === "" || prefix === "/") {
    prefix = "";
  } else {
    prefix = prefix.replace(/\/+$/, "");
    if (!prefix.startsWith("/")) prefix = "/" + prefix;
  }
  const prefixParts = prefix.split("/").filter(Boolean);
  const rawLimit = Number(maxDepth) || SIYUAN_SAFE_DOC_DEPTH;
  const limit = Math.max(1, Math.min(rawLimit, SIYUAN_MAX_DOC_DEPTH));

  if (fileOrTitle && typeof fileOrTitle === "object" && fileOrTitle.path) {
    if (preserveFolder) {
      const noExt = fileOrTitle.path.replace(/\.md$/i, "");
      let parts = noExt.split("/").map(p => safeTitle(p)).filter(Boolean);
      // 总深度 = 前缀层数 + Obsidian 相对路径层数，必须 ≤ limit
      const maxParts = Math.max(1, limit - prefixParts.length);
      if (parts.length > maxParts) {
        // 保留靠前的目录，把多出来的中间路径并进最后一层文档名（用 __ 连接）
        const keep = Math.max(0, maxParts - 1);
        const head = parts.slice(0, keep);
        const leaf = safeTitle(parts.slice(keep).join("__"));
        parts = head.concat(leaf);
        console.log("[SiPush] 路径超深已压平:", fileOrTitle.path, "→", (prefix || "") + "/" + parts.join("/"));
      }
      return (prefix || "") + "/" + parts.join("/");
    }
    return (prefix || "") + "/" + safeTitle(fileOrTitle.basename);
  }
  return (prefix || "") + "/" + safeTitle(String(fileOrTitle || "untitled"));
}

function pluginBuildPath(plugin, fileOrTitle) {
  return buildPath(
    plugin.settings.defaultPath,
    fileOrTitle,
    plugin.settings.preserveFolderStructure,
    plugin.settings.maxDocDepth
  );
}

class SiPushPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.api = new SiYuanApi(this.settings.serverUrl, this.settings.apiToken);
    this.isSyncing = false;
    this.statusBarEl = null;

    // 左侧功能区：只保留一个入口，其余功能都在推送控制台
    this.addRibbonIcon("upload-cloud", "SiPush 推送控制台", () => this.openPushControl());

    // 底部状态栏：点击同样打开控制台
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("si-push-status-bar");
    this.statusBarEl.setAttribute("aria-label", "打开 SiPush 推送控制台");
    this.statusBarEl.setAttribute("title", "打开推送控制台");
    this.statusBarEl.addEventListener("click", () => this.openPushControl());
    this.refreshStatusBar();

    this.addCommand({ id: "push-current", name: "推送当前笔记到思源", icon: "upload-cloud",
      editorCallback: () => this.pushCurrentNote() });
    this.addCommand({ id: "push-select", name: "推送选中内容到思源", icon: "upload-cloud",
      editorCallback: ed => { const s = ed.getSelection(); if(!s){ new Notice("请先选中内容"); return; } this.pushSelection(s); } });
    this.addCommand({ id: "append-doc", name: "追加到思源已有文档", icon: "upload-cloud",
      editorCallback: ed => this.appendToExisting(ed.getSelection() || ed.getValue()) });
    // V2 命令
    this.addCommand({ id: "sync-current", name: "同步当前笔记到思源", icon: "refresh-cw",
      callback: () => this.syncCurrentNote() });
    this.addCommand({ id: "sync-batch", name: "全库双向同步到思源", icon: "git-pull-request",
      callback: () => this.batchSync() });
    this.addCommand({ id: "push-all-vault", name: "一键全库推送到思源", icon: "upload-cloud",
      callback: () => this.pushAllVault() });
    this.addCommand({ id: "one-click-sync", name: "全库同步到思源", icon: "upload-cloud",
      callback: () => this.oneClickSync() });
    this.addCommand({ id: "push-control", name: "打开推送控制台", icon: "folders",
      callback: () => this.openPushControl() });
    this.addCommand({ id: "push-tree-select", name: "树状勾选文档推送到思源", icon: "list-tree",
      callback: () => this.openVaultTreeSelect() });
    this.addCommand({ id: "push-folder", name: "选择文件夹推送到思源", icon: "folder",
      callback: () => new FolderSuggestModal(this.app, (p) => this.pushFolder(p), this).open() });
    this.addCommand({ id: "push-current-folder", name: "推送当前笔记所在文件夹到思源", icon: "folder",
      callback: () => this.pushCurrentFolder() });
    this.addCommand({ id: "push-current-only", name: "仅推送当前笔记到思源（含资源双链）", icon: "file",
      callback: () => this.pushCurrentNoteOnly() });
    this.addCommand({ id: "pause-push", name: "暂停推送", icon: "pause-circle",
      callback: () => this.pausePushJob() });
    this.addCommand({ id: "resume-push", name: "继续推送", icon: "play-circle",
      callback: () => this.resumePushJob() });
    this.addCommand({ id: "restart-push-from", name: "从指定位置重新推送", icon: "skip-forward",
      callback: () => this.pickRestartFrom() });
    this.addCommand({ id: "cancel-push", name: "取消当前推送任务", icon: "x-square",
      callback: () => this.cancelPushJob() });
    this.addCommand({ id: "rewrite-wikilinks-only", name: "仅回写双链到思源（不重传正文附件）", icon: "link-2",
      callback: () => this.rewriteWikilinksOnly() });
    this.addCommand({ id: "force-push", name: "强制推送当前笔记到思源", icon: "upload-cloud",
      editorCallback: () => this.pushCurrentNote() });
    this.addCommand({ id: "pull-from-siyuan", name: "搜索思源文档并拉回", icon: "download-cloud",
      callback: () => this.pullFromSiYuan() });
    this.addCommand({ id: "view-push-history", name: "查看推送失败队列", icon: "list-checks",
      callback: () => this.openPushHistory() });
    this.addCommand({ id: "retry-failed", name: "重试推送失败项", icon: "rotate-cw",
      callback: () => this.retryFailedQueue() });
    this.addCommand({ id: "export-failed", name: "导出推送失败列表到笔记", icon: "file-text",
      callback: () => this.exportFailedReport() });
    this.addCommand({ id: "test-conn", name: "测试思源连接", icon: "link",
      callback: () => this.testConnection() });
    this.addCommand({ id: "migrate-push-id-footer", name: "迁移关联 ID 到文末（清除 frontmatter）", icon: "arrow-down",
      callback: () => this.migrateAllPushIdsToFooter({ force: true }) });
    this.addCommand({ id: "dedup-siyuan-assets", name: "去重思源资源池（按内容哈希）", icon: "trash",
      callback: () => this.openAssetDedup() });
    this.addCommand({ id: "repair-broken-asset-refs", name: "修复附件断链（去重后文档未更新）", icon: "link-2",
      callback: () => this.repairBrokenAssetRefs() });
    this.addCommand({ id: "repair-siyuan-av-markup", name: "修复思源音视频引用（![]→播放器）", icon: "audio-file",
      callback: () => this.repairSiYuanAudioVideoMarkup() });

    this.addSettingTab(new SiPushSettingTab(this.app, this));
    this.loadAssetIndex().catch(e => console.warn("[SiPush] loadAssetIndex:", e));
    this.migrateFailedQueueFromHistory();
    // 上次异常退出 / 取消导致 idle 但未跑完：改为 paused，方便继续或回写双链
    if (this.settings.pushJob && this.jobHasUnfinishedWork(this.settings.pushJob)) {
      if (this.settings.pushJob.status === "running" || this.settings.pushJob.status === "idle") {
        this.settings.pushJob.status = "paused";
        this.saveSettings().then(() => this.refreshStatusBar());
        new Notice("检测到未完成的推送任务（双链可能未写入）。可点「继续推送」或「仅回写双链」。", 10000);
      } else {
        this.refreshStatusBar();
      }
    } else if (this.settings.pushJob && this.settings.pushJob.status === "running") {
      this.settings.pushJob.status = "paused";
      this.saveSettings().then(() => this.refreshStatusBar());
      new Notice("检测到未完成的推送任务，已设为暂停。可点「继续推送」或打开推送控制台。", 8000);
    } else {
      this.refreshStatusBar();
    }
    // 布局就绪后，把全库顶部 custom-si-push-id 挪到文末（一次性）
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.needsPushIdFooterMigration === false) return;
      window.setTimeout(() => {
        this.migrateAllPushIdsToFooter({ quiet: false }).catch(e => {
          console.warn("[SiPush] ID 迁移失败:", e);
        });
      }, 1200);
    });
  }
  onunload() {
    this.statusBarEl = null;
  }
  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 避免与 DEFAULT 共享数组引用
    this.settings.syncHistory = Array.isArray(saved.syncHistory) ? saved.syncHistory.slice() : [];
    this.settings.failedQueue = Array.isArray(saved.failedQueue) ? saved.failedQueue.slice() : [];
    this.settings.notebookCache = Array.isArray(saved.notebookCache) ? saved.notebookCache.slice() : [];
    this.settings.assetMap = (saved.assetMap && typeof saved.assetMap === "object")
      ? Object.assign({}, saved.assetMap)
      : {};
    if (saved.pushJob && typeof saved.pushJob === "object") {
      this.settings.pushJob = Object.assign({}, saved.pushJob);
      if (Array.isArray(saved.pushJob.paths)) this.settings.pushJob.paths = saved.pushJob.paths.slice();
      if (saved.pushJob.results) {
        this.settings.pushJob.results = Object.assign({}, saved.pushJob.results);
        if (Array.isArray(saved.pushJob.results.details)) {
          this.settings.pushJob.results.details = saved.pushJob.results.details.slice();
        }
      }
    } else {
      this.settings.pushJob = null;
    }
    // 旧默认最大深度 6 会把深层目录压成 a__b__c，自动升到思源允许的 7
    if (saved.maxDocDepthMigratedTo7 !== true) {
      const d = Number(saved.maxDocDepth);
      if (!Number.isFinite(d) || d === 6) {
        this.settings.maxDocDepth = 7;
      }
      this.settings.maxDocDepthMigratedTo7 = true;
      await this.saveSettings();
    }
    // 旧默认 /assets/sipush/ 在思源中常导致附件引用找不到，自动迁移
    const fixedAssetsDir = resolveAssetsDirPath(this.settings.assetsDirPath);
    if (fixedAssetsDir !== this.settings.assetsDirPath) {
      this.settings.assetsDirPath = fixedAssetsDir;
      await this.saveSettings();
    } else {
      this.settings.assetsDirPath = fixedAssetsDir;
    }
  }
  async saveSettings() { await this.saveData(this.settings); this.api = new SiYuanApi(this.settings.serverUrl, this.settings.apiToken); }

  /** 检查思源配置是否齐全；未配置时提示并返回 false */
  ensureConfigured() {
    if (!this.settings.serverUrl) {
      new Notice("请先在「设置 → SiPush」中填写思源服务器地址", 6000);
      return false;
    }
    if (!this.settings.defaultNotebookId) {
      new Notice("请先在「设置 → SiPush」中选择默认笔记本（点刷新后选择）", 6000);
      return false;
    }
    return true;
  }

  /** 侧边栏 / 状态栏一键同步入口 */
  async oneClickSync() {
    if (!this.ensureConfigured()) return;
    if (this.settings.oneClickAction === "current") {
      await this.syncCurrentNote();
    } else {
      await this.pushAllVault();
    }
  }

  setStatusBarText(text) {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const iconWrap = this.statusBarEl.createSpan({ cls: "si-push-status-icon" });
    setIcon(iconWrap, "upload-cloud");
    this.statusBarEl.createSpan({ cls: "si-push-status-label", text: text || "同步到思源" });
  }

  /** 任务是否还有未完成的上传 / 双链 / 收尾 */
  jobHasUnfinishedWork(job) {
    if (!job || !job.paths || !job.paths.length) return false;
    if (job.status === "running" || job.status === "paused") return true;
    if (job.phase === "repair" && !job.repairDone) return true;
    if (job.phase === "wikilinks" && (job.wikiCursor || 0) < job.paths.length) return true;
    if (job.phase === "upload" && (job.cursor || 0) < job.paths.length) return true;
    // 上传已跑完但从未进入双链阶段（例如被标成 idle）
    if (job.phase === "upload" && (job.cursor || 0) >= job.paths.length && this.settings.rewriteWikilinks !== false) {
      return true;
    }
    return false;
  }

  refreshStatusBar() {
    const job = this.settings.pushJob;
    const unfinished = this.jobHasUnfinishedWork(job);
    if (job && (job.status === "running" || job.status === "paused" || unfinished)) {
      const total = (job.paths || []).length;
      if (job.phase === "repair") {
        const t = Math.max(1, job.repairTotal || 1);
        const c = Math.min(job.repairCurrent || 0, t);
        this.setStatusBarText(`收尾修复 ${c}/${t}`);
      } else {
        const cur = job.phase === "wikilinks" ? (job.wikiCursor || 0) : (job.cursor || 0);
        const tag = job.status === "paused" || (job.status !== "running" && unfinished)
          ? "未完成"
          : (job.phase === "wikilinks" ? "双链" : "上传");
        this.setStatusBarText(`${tag} ${Math.min(cur, total)}/${total}`);
      }
    } else {
      const n = (this.settings.failedQueue || []).length;
      this.setStatusBarText(n > 0 ? `同步到思源 · 失败${n}` : "同步到思源");
    }
    // 控制台打开时同步刷新进度
    if (this._controlModal && typeof this._controlModal.refreshProgress === "function") {
      try { this._controlModal.refreshProgress(); } catch (e) { /* ignore */ }
    }
  }

  openPushHistory() {
    new PushHistoryModal(this.app, this).open();
  }

  openPushControl(opts) {
    opts = opts || {};
    if (this._controlModal) {
      try {
        // 已打开时也拉最新进度；需要整页刷新时 forceRender
        if (opts.forceRender && typeof this._controlModal.render === "function") {
          this._controlModal.render();
        } else if (typeof this._controlModal.refreshProgress === "function") {
          this._controlModal.refreshProgress();
        }
      } catch (e) { /* ignore */ }
      return this._controlModal;
    }
    // 重新打开：新建弹窗，onOpen 会读当前 pushJob 最新进度
    const modal = new PushControlModal(this.app, this);
    modal.open();
    return modal;
  }

  /** 从历史同步报告里捞失败项进队列（升级兼容） */
  async migrateFailedQueueFromHistory() {
    if (!this.settings.failedQueue) this.settings.failedQueue = [];
    if (this.settings.failedQueue.length) {
      this.refreshStatusBar();
      return;
    }
    const hist = this.settings.syncHistory || [];
    const seen = new Set();
    const queue = [];
    for (const h of hist) {
      for (const d of h.details || []) {
        if (d.status !== "error" && d.status !== "failed") continue;
        const path = d.title;
        if (!path || seen.has(path)) continue;
        seen.add(path);
        queue.push({
          path,
          error: d.detail || d.direction || "未知错误",
          time: h.time || utcSec(),
          retries: 0,
        });
      }
    }
    if (queue.length) {
      this.settings.failedQueue = queue;
      // 精简历史，避免 data.json 过大
      this.settings.syncHistory = hist.slice(0, 5).map(h => ({
        time: h.time,
        synced: h.synced || 0,
        failed: h.failed || 0,
        conflicts: h.conflicts || 0,
        deleted: h.deleted || 0,
        assets: h.assets || 0,
        details: (h.details || []).filter(d => d.status === "error" || d.status === "failed"),
      }));
      await this.saveSettings();
      console.log("[SiPush] 已从历史导入失败队列:", queue.length, "篇");
      new Notice(`已载入 ${queue.length} 篇历史失败记录，可打开「推送失败队列」查看`, 6000);
    }
    this.refreshStatusBar();
  }

  // ── 推送 (V1 保留) ──
  async pushCurrentNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("没有打开的笔记"); return; }
    const file = view.file; if (!file) { new Notice("无法获取文件"); return; }
    const pushId = await this.getOrCreatePushId(file);
    const title = file.basename;
    let md = view.data;
    if (!this.settings.pushFrontmatter) md = stripFM(md);
    const prepared = await this.prepareMarkdownForPush(file, md);
    const path = pluginBuildPath(this, file);
    await this.pushToSiYuan(file, path, prepared.md, pushId, title, { prepared: true });
  }

  async pushSelection(text) {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    let md = text; if (!this.settings.pushFrontmatter) md = stripFM(md);
    const pushId = "si-push://" + Date.now();
    const path = buildPath(this.settings.defaultPath, "选区内容_" + Date.now().toString(36), false, this.settings.maxDocDepth);
    try {
      const res = await this.api.createDoc(this.settings.defaultNotebookId, path, md);
      await this.api.setAttrs(res, { "custom-si-push-id": pushId, title: path.split("/").pop() });
      new Notice("✅ 选区推送成功！");
    } catch(e) { new Notice("❌ 推送失败: " + e.message, 6000); }
  }

  async appendToExisting(content) {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId, this);
    const doc = await m.openAndGetResult();
    if (!doc) return;
    let md = content; if (!this.settings.pushFrontmatter) md = stripFM(md);
    new Notice("正在追加...");
    try { await this.api.appendToDoc(doc.id, md.trim()); new Notice("✅ 追加成功！"); }
    catch(e) { new Notice("❌ 追加失败: " + e.message, 6000); }
  }

  /** 第二遍：按已收集的思源文档 ID，把 [[笔记]] 写成 ((id "锚文本")) */
  async rewriteVaultWikilinks(files) {
    if (this.settings.rewriteWikilinks === false) return 0;
    // 映射必须覆盖库内其它已关联文档，否则互链目标不在本次 files 里会转失败
    await this.ensureSiDocMap(this.app.vault.getMarkdownFiles());
    let updated = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (i % 10 === 0 || i === files.length - 1) {
          this.setStatusBarText(`双链 ${i + 1}/${files.length}`);
        }
        const pushId = await this.getOrCreatePushId(file);
        let md = await this.app.vault.read(file);
        if (!this.settings.pushFrontmatter) md = stripFM(md);
        if (!/\[\[[^\]]+\]\]/.test(md) && !/siyuan:\/\/blocks\//i.test(md)) continue;
        const prepared = await this.prepareMarkdownForPush(file, md, { skipWikilinks: false });
        if (!/\(\([0-9]{14}-[0-9a-z]{7}/i.test(prepared.md)) continue;
        const path = pluginBuildPath(this, file);
        await this.pushToSiYuan(file, path, prepared.md, pushId, file.basename, { quiet: true, prepared: true });
        updated++;
      } catch (e) {
        console.warn("[SiPush] 双链回写失败:", file.path, e.message);
      }
    }
    console.log("[SiPush] 双链回写完成:", updated, "篇");
    return updated;
  }

  // ── V2.1: 可暂停/范围推送的任务机 ──
  listPushableFiles(folderPath) {
    const prefix = folderPath ? folderPath.replace(/\/+$/, "") + "/" : "";
    return this.app.vault.getMarkdownFiles()
      .filter(f => {
        if (f.path.startsWith(".obsidian/") || f.path.startsWith(".trash/")) return false;
        if (!folderPath) return true;
        return f.path === folderPath.replace(/\/+$/, "") || f.path.startsWith(prefix);
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  openVaultTreeSelect() {
    if (!this.ensureConfigured()) return;
    new VaultTreeSelectModal(this.app, this).open();
  }

  async pushAllVault() {
    const files = this.listPushableFiles("");
    await this.startPushJob({ paths: files.map(f => f.path), label: "全库推送" });
  }

  async pushFolder(folderPath) {
    const files = this.listPushableFiles(folderPath);
    if (!files.length) {
      new Notice(folderPath ? `文件夹「${folderPath}」下没有 Markdown` : "没有可推送的笔记");
      return;
    }
    await this.startPushJob({
      paths: files.map(f => f.path),
      label: folderPath ? `文件夹：${folderPath}` : "全库推送",
    });
  }

  async pushCurrentFolder() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view && view.file;
    if (!file) { new Notice("请先打开一篇笔记"); return; }
    const folder = file.parent ? file.parent.path : "";
    await this.pushFolder(folder);
  }

  async pushCurrentNoteOnly() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view && view.file;
    if (!file) { new Notice("请先打开一篇笔记"); return; }
    await this.startPushJob({ paths: [file.path], label: "单篇：" + file.path });
  }

  pickRestartFrom() {
    const job = this.settings.pushJob;
    const paths = (job && job.paths && job.paths.length)
      ? job.paths
      : this.listPushableFiles("").map(f => f.path);
    if (!paths.length) { new Notice("没有可选择的笔记"); return; }
    new StartFromSuggestModal(this.app, paths, (path) => this.restartPushFrom(path), this).open();
  }

  async startPushJob({ paths, label, startPath }) {
    if (!this.ensureConfigured()) return;
    if (!paths || !paths.length) { new Notice("没有可推送的笔记"); return; }

    if (this._jobLoopRunning) {
      // 正在跑：登记为暂停后重启，避免直接开新任务失败
      this._pendingRestart = { paths, label, startPath };
      this._pauseRequested = true;
      this.openPushControl({ forceRender: true });
      new Notice("当前推送将先暂停，然后从新任务重新开始…");
      return;
    }

    let cursor = 0;
    if (startPath) {
      const idx = paths.indexOf(startPath);
      cursor = idx >= 0 ? idx : 0;
      if (idx < 0) new Notice("未找到起点，将从列表开头推送");
    }

    this.settings.pushJob = {
      status: "running",
      label: label || "推送任务",
      paths,
      cursor,
      wikiCursor: 0,
      phase: "upload",
      repairDone: false,
      repairCurrent: 0,
      repairTotal: 2,
      repairDetail: "",
      results: { synced: 0, failed: 0, conflicts: 0, deleted: 0, skipped: 0, assets: 0, details: [] },
      createdAt: utcSec(),
      updatedAt: utcSec(),
    };
    this._pauseRequested = false;
    this._pendingRestart = null;
    await this.saveSettings();
    // 先打开/刷新控制台，再跑任务，保证进度条能实时看见
    this.openPushControl({ forceRender: true });
    this.refreshStatusBar();
    new Notice(`开始${label || "推送"}：共 ${paths.length} 篇` + (startPath ? `（从 ${startPath} 起）` : ""), 5000);
    // 让弹窗完成首帧渲染后再进入长循环
    await new Promise(r => window.setTimeout(r, 80));
    await this.runPushJobLoop();
  }

  async pausePushJob() {
    const job = this.settings.pushJob;
    if (!job || job.status !== "running") {
      new Notice("当前没有进行中的推送");
      return;
    }
    this._pauseRequested = true;
    new Notice("将在当前这篇完成后暂停…");
  }

  async resumePushJob() {
    const job = this.settings.pushJob;
    if (!job || !job.paths || !job.paths.length) {
      new Notice("没有可继续的推送任务，请先开始推送");
      return;
    }
    if (!this.jobHasUnfinishedWork(job) && job.status !== "paused" && job.status !== "running") {
      new Notice("当前任务已结束，请重新开始推送");
      return;
    }
    if (job.status === "running" && this._jobLoopRunning) {
      new Notice("推送已在进行中");
      return;
    }
    if (!this.ensureConfigured()) return;
    // 上传已全部完成但停在 upload：直接进入双链阶段
    if (
      job.phase === "upload" &&
      (job.cursor || 0) >= job.paths.length &&
      this.settings.rewriteWikilinks !== false
    ) {
      job.phase = "wikilinks";
      job.wikiCursor = job.wikiCursor || 0;
    }
    job.status = "running";
    job.updatedAt = utcSec();
    this._pauseRequested = false;
    await this.saveSettings();
    this.refreshStatusBar();
    this.openPushControl({ forceRender: true });
    new Notice(`继续推送：${job.phase === "repair" ? "收尾修复" : (job.phase === "wikilinks" ? "双链" : "上传")} ${job.phase === "wikilinks" ? job.wikiCursor : (job.phase === "repair" ? (job.repairCurrent || 0) : job.cursor)}/${job.phase === "repair" ? (job.repairTotal || 2) : job.paths.length}`);
    await new Promise(r => window.setTimeout(r, 50));
    await this.runPushJobLoop();
  }

  async restartPushFrom(startPath) {
    const job = this.settings.pushJob;
    const paths = (job && job.paths && job.paths.length)
      ? job.paths.slice()
      : this.listPushableFiles("").map(f => f.path);
    const label = (job && job.label) || "重新推送";
    await this.startPushJob({ paths, label: label + "（重推）", startPath });
  }

  async cancelPushJob() {
    this._pauseRequested = true;
    const job = this.settings.pushJob;
    if (!job || !job.paths || !job.paths.length) {
      new Notice("没有可取消的推送任务");
      return;
    }

    // 若循环还在跑：先停在当前篇，再为「已上传部分」回写双链，最后标为 paused（可继续）
    if (this._jobLoopRunning) {
      this._cancelFlushWikilinks = true;
      new Notice("将在当前篇完成后停止，并为已上传部分写入双链…", 6000);
      return;
    }

    await this.finalizeInterruptedPush(job, { flushWikilinks: true, asPaused: true });
  }

  /**
   * 中断后的收尾：可选为已上传文档回写双链，并保留任务为 paused 以便继续。
   * 不再把未完成任务直接标 idle，避免控制台显示「没有任务」且思源里双链缺失。
   */
  async finalizeInterruptedPush(job, opts) {
    opts = opts || {};
    if (!job) return;
    const uploaded = Math.min(job.cursor || 0, (job.paths || []).length);
    if (opts.flushWikilinks && this.settings.rewriteWikilinks !== false && uploaded > 0) {
      try {
        new Notice(`正在为已上传的 ${uploaded} 篇写入双链…`, 4000);
        const files = job.paths.slice(0, uploaded)
          .map(p => this.app.vault.getAbstractFileByPath(p))
          .filter(f => f instanceof TFile);
        await this.ensureSiDocMap(files);
        const n = await this.rewriteVaultWikilinks(files);
        new Notice(`已为已上传部分写入双链 ${n} 篇。点「继续」可接着推剩余笔记。`, 8000);
      } catch (e) {
        console.warn("[SiPush] 中断后双链回写失败:", e);
        new Notice("已停止推送，但双链回写失败: " + (e.message || e), 8000);
      }
    } else if (uploaded > 0 && this.settings.rewriteWikilinks !== false) {
      new Notice("已停止。已上传内容尚未写双链，请点「仅回写双链」或「继续」。", 8000);
    } else {
      new Notice("已停止推送任务（已完成的不会回滚）");
    }
    job.status = opts.asPaused === false ? "idle" : "paused";
    job.updatedAt = utcSec();
    await this.saveSettings();
    this.isSyncing = false;
    this.refreshStatusBar();
    this.openPushControl({ forceRender: true });
  }

  /**
   * 仅把 [[笔记]] 写成思源 ((id "锚文本")) 并回写，不重跑全库上传。
   * 优先处理当前任务已覆盖路径；否则处理全库已关联笔记。
   */
  async rewriteWikilinksOnly() {
    if (!this.ensureConfigured()) return;
    if (this.settings.rewriteWikilinks === false) {
      new Notice("设置里已关闭「转换双链」，请先打开");
      return;
    }
    if (this._jobLoopRunning || this.isSyncing) {
      new Notice("请先暂停/等当前推送结束，再回写双链");
      return;
    }
    const job = this.settings.pushJob;
    let files;
    let label;
    if (job && job.paths && job.paths.length) {
      const end = job.phase === "upload"
        ? Math.max(job.cursor || 0, 0)
        : job.paths.length;
      const slice = end > 0 ? job.paths.slice(0, end) : job.paths.slice();
      files = slice
        .map(p => this.app.vault.getAbstractFileByPath(p))
        .filter(f => f instanceof TFile);
      label = `任务范围内 ${files.length} 篇`;
    } else {
      files = this.listPushableFiles("");
      label = `全库 ${files.length} 篇`;
    }
    if (!files.length) {
      new Notice("没有可回写双链的笔记");
      return;
    }
    this.isSyncing = true;
    this.setStatusBarText("写入双链…");
    new Notice(`开始回写双链（${label}）…`, 4000);
    try {
      await this.ensureSiDocMap(files);
      const n = await this.rewriteVaultWikilinks(files);
      new Notice(`✅ 双链回写完成：更新 ${n} 篇（无 [[链接]] 的会跳过）`, 8000);
    } catch (e) {
      new Notice("❌ 双链回写失败: " + (e.message || e), 8000);
    } finally {
      this.isSyncing = false;
      this.refreshStatusBar();
    }
  }

  async runPushJobLoop() {
    if (this._jobLoopRunning) return;
    const job = this.settings.pushJob;
    if (!job || job.status !== "running") return;

    this._jobLoopRunning = true;
    this.isSyncing = true;
    if (!this._assetCache) this._assetCache = new Map();
    if (!this._siDocMap) this._siDocMap = { byPath: new Map(), byName: new Map() };
    if (!this._docIdByPushId) this._docIdByPushId = new Map();
    if (!this._pushIdByPath) this._pushIdByPath = new Map();

    // 从「双链阶段」恢复时，必须先重建文档 ID 映射（全库，保证互链目标可解析）
    if (job.phase === "wikilinks" && this.settings.rewriteWikilinks !== false) {
      await this.ensureSiDocMap(this.app.vault.getMarkdownFiles());
    }

    try {
      // 阶段 1：上传
      while (job.status === "running" && job.phase === "upload" && job.cursor < job.paths.length) {
        if (this._pauseRequested) {
          job.status = "paused";
          job.updatedAt = utcSec();
          await this.saveSettings();
          this.refreshStatusBar();
          if (this._cancelFlushWikilinks) {
            this._cancelFlushWikilinks = false;
            await this.finalizeInterruptedPush(job, { flushWikilinks: true, asPaused: true });
          } else {
            new Notice(`已暂停：上传 ${job.cursor}/${job.paths.length}` +
              ((job.cursor || 0) > 0 ? "（双链阶段未跑完前，思源里 [[链接]] 可能还不能点）" : ""));
          }
          break;
        }

        const filePath = job.paths[job.cursor];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        this.refreshStatusBar();

        try {
          if (!(file instanceof TFile)) throw new Error("文件不存在");
          const pushId = await this.getOrCreatePushId(file);
          let md = await this.app.vault.read(file);
          if (!this.settings.pushFrontmatter) md = stripFM(md);
          const prepared = await this.prepareMarkdownForPush(file, md, { skipWikilinks: false });
          job.results.assets += prepared.assetCount || 0;
          if (prepared.assetErrors && prepared.assetErrors.length) {
            for (const ae of prepared.assetErrors) {
              job.results.details.push({
                title: file.path,
                status: "error",
                direction: "附件失败",
                detail: ((ae.path || "") + ": " + (ae.error || "")).substring(0, 160),
              });
            }
          }
          const siPath = pluginBuildPath(this, file);
          const docId = await this.pushToSiYuan(file, siPath, prepared.md, pushId, file.basename, { quiet: true, prepared: true });
          if (docId) this.registerSiDoc(file, docId);
          job.results.synced++;
          job.results.details.push({
            title: file.path,
            status: "success",
            direction: "已推送" + (prepared.assetCount ? ` (资源 ${prepared.assetCount})` : "") +
              ((prepared.assetErrors && prepared.assetErrors.length) ? ` ⚠附件失败${prepared.assetErrors.length}` : ""),
          });
        } catch (e) {
          job.results.failed++;
          job.results.details.push({
            title: filePath,
            status: "error",
            direction: "异常",
            detail: (e.message || String(e)).substring(0, 120),
          });
        }

        job.cursor++;
        job.updatedAt = utcSec();
        this.refreshStatusBar();
        if (job.cursor % 5 === 0 || job.cursor >= job.paths.length) {
          // 精简 details，避免内存/磁盘膨胀：成功只保留最近 30 条，失败全留
          const fails = job.results.details.filter(d => d.status === "error");
          const oks = job.results.details.filter(d => d.status === "success").slice(-30);
          job.results.details = fails.concat(oks);
          await this.saveSettings();
        }
      }

      if (job.status === "running" && job.phase === "upload" && job.cursor >= job.paths.length) {
        job.phase = "wikilinks";
        job.wikiCursor = 0;
        await this.saveSettings();
        if (this.settings.rewriteWikilinks !== false) {
          new Notice("开始写入双链…", 3000);
          // 双链前建立「全库已关联文档 → 思源 ID」映射，否则跨文件夹互链会失败
          await this.ensureSiDocMap(this.app.vault.getMarkdownFiles());
        } else {
          job.phase = "done";
        }
      }

      // 阶段 2：双链
      while (
        job.status === "running" &&
        job.phase === "wikilinks" &&
        this.settings.rewriteWikilinks !== false &&
        job.wikiCursor < job.paths.length
      ) {
        if (this._pauseRequested) {
          job.status = "paused";
          job.updatedAt = utcSec();
          await this.saveSettings();
          this.refreshStatusBar();
          if (this._cancelFlushWikilinks) {
            this._cancelFlushWikilinks = false;
            // 双链阶段已在进行：直接保留 paused，无需再 flush
            new Notice(`已停止：双链 ${job.wikiCursor}/${job.paths.length}（可点继续）`);
            this.openPushControl({ forceRender: true });
          } else {
            new Notice(`已暂停：双链 ${job.wikiCursor}/${job.paths.length}`);
          }
          break;
        }

        const filePath = job.paths[job.wikiCursor];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        this.refreshStatusBar();
        try {
          if (file instanceof TFile) {
            let md = await this.app.vault.read(file);
            if (!this.settings.pushFrontmatter) md = stripFM(md);
            if (/\[\[[^\]]+\]\]/.test(md) || /siyuan:\/\/blocks\//i.test(md)) {
              const prepared = await this.prepareMarkdownForPush(file, md, { skipWikilinks: false });
              if (/\(\([0-9]{14}-[0-9a-z]{7}/i.test(prepared.md)) {
                const pushId = await this.getOrCreatePushId(file);
                await this.pushToSiYuan(file, pluginBuildPath(this, file), prepared.md, pushId, file.basename, {
                  quiet: true, prepared: true,
                });
              }
            }
          }
        } catch (e) {
          console.warn("[SiPush] 双链回写失败:", filePath, e.message);
        }
        job.wikiCursor++;
        this.refreshStatusBar();
        if (job.wikiCursor % 10 === 0) await this.saveSettings();
      }

      if (
        job.status === "running" &&
        (job.phase === "done" ||
          job.phase === "repair" ||
          (job.phase === "wikilinks" && (this.settings.rewriteWikilinks === false || job.wikiCursor >= job.paths.length)))
      ) {
        // 阶段 3：推送收尾自动修复（音视频写法 + 附件断链），避免导入后再点一堆修复
        if (this.settings.autoRepairAfterPush !== false && !job.repairDone) {
          job.phase = "repair";
          job.repairCurrent = 0;
          job.repairTotal = 2;
          job.repairDetail = "准备自动修复音视频与附件断链…";
          await this.saveSettings();
          this.refreshStatusBar();
          new Notice("推送收尾：自动修复音视频引用与附件断链…", 4000);
          try {
            const repair = await this.runPostPushRepairs({
              quiet: true,
              onProgress: (info) => {
                const msg = (info && info.message) || "";
                job.repairDetail = ((info && info.detail) || msg || "").slice(0, 160);
                if (typeof info.current === "number" && typeof info.total === "number" && info.total > 0) {
                  const step = /断链|assets|枚举|引用/.test(msg) ? 1 : 0;
                  const local = info.current / Math.max(1, info.total);
                  job.repairCurrent = Math.min(2, Math.round((step + local) * 10) / 10);
                  job.repairTotal = 2;
                }
                this.refreshStatusBar();
              },
            });
            job.results.repairAvFixed = (repair && repair.av && repair.av.fixed) || 0;
            job.results.repairBrokenPairs = (repair && repair.broken && repair.broken.pairCount) || 0;
            job.results.repairBrokenDocs = (repair && repair.broken && repair.broken.docsTouched) || 0;
            const noteParts = [];
            if (job.results.repairAvFixed) noteParts.push(`音视频${job.results.repairAvFixed}`);
            if (job.results.repairBrokenPairs) noteParts.push(`断链${job.results.repairBrokenPairs}`);
            job.results.repairNote = noteParts.length ? noteParts.join("+") : "无";
          } catch (e) {
            console.warn("[SiPush] 推送收尾修复失败:", e);
            job.results.repairNote = "失败";
            job.results.details.push({
              title: "(收尾修复)",
              status: "error",
              direction: "收尾修复",
              detail: (e.message || String(e)).substring(0, 120),
            });
          }
          job.repairDone = true;
        }

        job.phase = "done";
        job.status = "done";
        job.updatedAt = utcSec();
        await this.flushAssetMapIfNeeded(true);
        await this.saveSettings();
        await this.logSyncHistory(job.results);
        this.refreshStatusBar();
        new SyncReportModal(this.app, job.results, this).open();
        const repairHint = job.results.repairNote && job.results.repairNote !== "无"
          ? ` · 🔧${job.results.repairNote}`
          : "";
        new Notice(`推送完成：✅ ${job.results.synced} / ❌ ${job.results.failed}${repairHint}`, 7000);
      }
    } finally {
      this._jobLoopRunning = false;
      this.isSyncing = false;
      // 暂停时也落盘 assetMap，避免恢复后重复上传产生多份附件
      await this.flushAssetMapIfNeeded(true);
      if (!this.settings.pushJob || this.settings.pushJob.status !== "running") {
        this._assetCache = null;
        if (this.settings.pushJob && this.settings.pushJob.status === "done") this._siDocMap = null;
      }
      this.refreshStatusBar();

      // 暂停完成后若有「从指定位置重推」请求，立刻开新任务
      const pending = this._pendingRestart;
      if (pending) {
        this._pendingRestart = null;
        this._pauseRequested = false;
        // 下一轮事件循环启动，避免 finally 重入
        setTimeout(() => {
          this.startPushJob(pending).catch(e => console.error("[SiPush] pending restart failed:", e));
        }, 0);
      }
    }
  }

  // ── V2.1: 推送前处理 — 上传引用资源 + 转换双链为思源块引用 ──
  async prepareMarkdownForPush(sourceFile, md, opts) {
    opts = opts || {};
    // 推送到思源时去掉文末 ID 标记，避免污染思源正文
    let out = stripPushIdFooter(md || "");
    let assetCount = 0;
    let assetErrors = [];
    if (this.settings.syncAssets !== false) {
      const r = await this.rewriteAndUploadAssets(sourceFile, out);
      out = r.md;
      assetCount = r.count || 0;
      assetErrors = r.errors || [];
    }
    // 第一遍也会尽量转双链（目标已在映射中的）；第二遍再用全库 ID 补全
    if (!opts.skipWikilinks && this.settings.rewriteWikilinks !== false) {
      out = this.rewriteWikilinks(sourceFile, out);
    }
    return { md: out, assetCount, assetErrors };
  }

  /** 注册 Obsidian 文件 ↔ 思源文档 ID，供双链改写 */
  registerSiDoc(file, docId) {
    if (!file || !docId) return;
    if (!this._siDocMap) this._siDocMap = { byPath: new Map(), byName: new Map() };
    this._siDocMap.byPath.set(file.path, docId);
    this._siDocMap.byName.set(file.basename, docId);
  }

  async ensureSiDocMap(files) {
    if (!this._siDocMap) this._siDocMap = { byPath: new Map(), byName: new Map() };
    const list = files || this.app.vault.getMarkdownFiles();
    const need = list.filter(f => f && !this._siDocMap.byPath.has(f.path));
    if (!need.length) return this._siDocMap;

    // 批量拉取笔记本内已关联文档，避免逐篇 findDoc
    let byPushId = null;
    if (need.length > 20) {
      try {
        const rows = await this.api.searchLinked(this.settings.defaultNotebookId);
        byPushId = new Map();
        for (const r of (Array.isArray(rows) ? rows : [])) {
          if (r && r.push_id && r.id) byPushId.set(String(r.push_id), r.id);
        }
      } catch (e) {
        console.warn("[SiPush] 批量拉取关联文档失败，回退逐篇查询:", e.message);
        byPushId = null;
      }
    }

    for (const file of need) {
      let pushId = null;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm && fm[PUSH_ID_KEY]) pushId = fm[PUSH_ID_KEY];
      if (!pushId) {
        try {
          const md = await this.app.vault.read(file);
          pushId = extractPushIdFromContent(md);
        } catch (e) { /* ignore */ }
      }
      if (!pushId) continue;
      try {
        if (byPushId && byPushId.has(String(pushId))) {
          this.registerSiDoc(file, byPushId.get(String(pushId)));
          continue;
        }
        const doc = await this.api.findDoc(pushId);
        if (doc && doc.id) this.registerSiDoc(file, doc.id);
      } catch (e) { /* ignore */ }
    }
    return this._siDocMap;
  }

  resolveSiDocId(sourceFile, linkPath) {
    if (!this._siDocMap) return null;
    const file = this.resolveVaultFile(sourceFile, linkPath);
    if (file && this._siDocMap.byPath.has(file.path)) {
      return { id: this._siDocMap.byPath.get(file.path), file };
    }
    const title = (linkPath || "").replace(/\.md$/i, "").split("/").pop();
    if (title && this._siDocMap.byName.has(title)) {
      return { id: this._siDocMap.byName.get(title), file: file || null, title };
    }
    return null;
  }

  /** 思源块引用：((id "静态锚文本")) — API 写入后才能点开并有反向链接 */
  formatSiBlockRef(docId, display) {
    const anchor = String(display || "").replace(/"/g, "'").trim() || docId;
    return `((${docId} "${anchor}"))`;
  }

  rewriteWikilinks(sourceFile, md) {
    let out = md || "";

    // 已有 [text](siyuan://blocks/id) → 转为真正的块引用双链
    out = out.replace(/\[([^\]]+)\]\(siyuan:\/\/blocks\/([0-9a-z-]+)\)/gi, (_, text, id) => {
      return this.formatSiBlockRef(id, text);
    });

    // [[笔记]] / [[笔记|别名]] → ((docId "显示名"))
    out = out.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (full, raw) => {
      const { path: linkPath, alias } = parseWikiTarget(raw);
      if (!linkPath) return full;
      const file = this.resolveVaultFile(sourceFile, linkPath);
      if (file && isAssetFile(file)) {
        return alias || file.basename;
      }
      const title = file ? file.basename : linkPath.replace(/\.md$/i, "").split("/").pop();
      const display = alias || title;
      const hit = this.resolveSiDocId(sourceFile, linkPath);
      if (hit && hit.id) {
        return this.formatSiBlockRef(hit.id, display);
      }
      // 尚未同步到思源的目标：先保留 [[标题]]，第二遍再转
      return display === title ? `[[${title}]]` : `[[${title}|${display}]]`;
    });

    return out;
  }

  resolveVaultFile(sourceFile, linkPath) {
    if (!linkPath) return null;
    const cleaned = decodeUriPath(linkPath.trim().replace(/^\.\//, ""));
    if (!cleaned || isRemoteUrl(cleaned)) return null;
    if (shouldReuseAssetLink(cleaned)) return null;
    const tryPaths = [cleaned];
    if (/^assets\//i.test(cleaned)) {
      const guessed = guessVaultNameFromAssetLink(cleaned);
      if (guessed) tryPaths.push(guessed);
    }
    const sourcePath = (sourceFile && sourceFile.path) || "";
    for (const p of tryPaths) {
      const resolved = this.app.metadataCache.getFirstLinkpathDest(p, sourcePath);
      if (resolved instanceof TFile) return resolved;
      const byPath = this.app.vault.getAbstractFileByPath(p);
      if (byPath instanceof TFile) return byPath;
    }
    // 仅文件名 / 语雀 UUID 文件名：全库按 basename 兜底（优先 assets/）
    const base = cleaned.split("/").pop();
    if (base && base !== cleaned) {
      const resolved = this.app.metadataCache.getFirstLinkpathDest(base, sourcePath);
      if (resolved instanceof TFile) return resolved;
    }
    if (base) {
      const hits = this.app.vault.getFiles().filter(f => f.name === base);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const inAssets = hits.find(f => /(^|\/)assets\//i.test(f.path));
        if (inAssets) return inAssets;
        // 同目录优先
        const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
        const sameDir = dir ? hits.find(f => f.path.startsWith(dir)) : null;
        if (sameDir) return sameDir;
        return hits[0];
      }
    }
    return null;
  }

  fileAssetMeta(file) {
    const size = (file.stat && typeof file.stat.size === "number")
      ? file.stat.size
      : ((file.stat && file.stat.size) || 0);
    return { mtime: file.mtime || 0, size: size || 0 };
  }

  /** 独立 JSON：记录 vault 路径 / 内容哈希 → 思源 assets 路径 */
  assetIndexFilePath() {
    const dir = (this.manifest && this.manifest.dir)
      || path.join(this.app.vault.adapter.basePath, ".obsidian", "plugins", "obsidian-si-push-main");
    return path.join(dir, "asset-index.json");
  }

  emptyAssetIndex() {
    return { version: 1, updatedAt: 0, byHash: {}, byVaultPath: {} };
  }

  async loadAssetIndex() {
    if (this._assetIndex) return this._assetIndex;
    const filePath = this.assetIndexFilePath();
    let idx = this.emptyAssetIndex();
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          idx = Object.assign(this.emptyAssetIndex(), parsed);
          idx.byHash = parsed.byHash && typeof parsed.byHash === "object" ? parsed.byHash : {};
          idx.byVaultPath = parsed.byVaultPath && typeof parsed.byVaultPath === "object" ? parsed.byVaultPath : {};
        }
      }
    } catch (e) {
      console.warn("[SiPush] 读取 asset-index.json 失败:", e.message);
    }
    // 从旧 settings.assetMap 迁移一次
    const legacy = this.settings.assetMap || {};
    const legacyKeys = Object.keys(legacy);
    if (legacyKeys.length && Object.keys(idx.byVaultPath).length === 0) {
      for (const vaultPath of legacyKeys) {
        const hit = legacy[vaultPath];
        if (!hit || !hit.path) continue;
        idx.byVaultPath[vaultPath] = {
          siPath: normalizeAssetLinkPath(hit.path),
          hash: hit.hash || null,
          mtime: hit.mtime || 0,
          size: hit.size || 0,
          firstSeenAt: hit.firstSeenAt || Date.now(),
        };
      }
      this._assetIndex = idx;
      await this.saveAssetIndex(true);
      console.log("[SiPush] 已从 settings.assetMap 迁移到 asset-index.json:", legacyKeys.length);
    }
    this._assetIndex = idx;
    return idx;
  }

  async saveAssetIndex(force) {
    if (!this._assetIndex) return;
    if (!force && !this._assetIndexDirty) return;
    this._assetIndex.updatedAt = Date.now();
    const filePath = this.assetIndexFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this._assetIndex, null, 2), "utf8");
      this._assetIndexDirty = false;
    } catch (e) {
      console.warn("[SiPush] 保存 asset-index.json 失败:", e.message);
    }
  }

  lookupIndexByVaultPath(file) {
    const idx = this._assetIndex || this.emptyAssetIndex();
    const hit = idx.byVaultPath[file.path];
    if (!hit || !hit.siPath) return null;
    const meta = this.fileAssetMeta(file);
    if (hit.mtime && meta.mtime && hit.mtime !== meta.mtime) return null;
    if (hit.size && meta.size && hit.size !== meta.size) return null;
    return normalizeAssetLinkPath(hit.siPath);
  }

  lookupIndexByHash(hash) {
    if (!hash) return null;
    const idx = this._assetIndex || this.emptyAssetIndex();
    const hit = idx.byHash[hash];
    if (!hit || !hit.siPath) return null;
    return {
      siPath: normalizeAssetLinkPath(hit.siPath),
      firstSeenAt: hit.firstSeenAt || 0,
      size: hit.size || 0,
    };
  }

  rememberAssetIndex(file, assetPath, hash, meta) {
    if (!file || !assetPath) return;
    if (!this._assetIndex) this._assetIndex = this.emptyAssetIndex();
    const siPath = normalizeAssetLinkPath(assetPath);
    const m = meta || this.fileAssetMeta(file);
    const now = Date.now();
    const prevHash = hash ? this._assetIndex.byHash[hash] : null;
    // 同哈希保留最早那份思源路径
    if (hash) {
      if (!prevHash || !prevHash.siPath) {
        this._assetIndex.byHash[hash] = {
          siPath,
          size: m.size || 0,
          firstSeenAt: now,
          vaultPaths: [file.path],
        };
      } else {
        const paths = Array.isArray(prevHash.vaultPaths) ? prevHash.vaultPaths.slice() : [];
        if (!paths.includes(file.path)) paths.push(file.path);
        // 不覆盖更早的 siPath
        this._assetIndex.byHash[hash] = {
          siPath: prevHash.siPath || siPath,
          size: prevHash.size || m.size || 0,
          firstSeenAt: prevHash.firstSeenAt || now,
          vaultPaths: paths,
        };
      }
    }
    this._assetIndex.byVaultPath[file.path] = {
      siPath: (hash && this._assetIndex.byHash[hash] && this._assetIndex.byHash[hash].siPath) || siPath,
      hash: hash || null,
      mtime: m.mtime || 0,
      size: m.size || 0,
      firstSeenAt: (prevHash && prevHash.firstSeenAt) || now,
    };
    this._assetIndexDirty = true;
  }

  /** 兼容旧调用名 */
  async flushAssetMapIfNeeded(force) {
    await this.saveAssetIndex(!!force);
  }

  async uploadVaultFile(file) {
    if (!this._assetCache) this._assetCache = new Map();
    if (this._assetCache.has(file.path)) return this._assetCache.get(file.path);

    await this.loadAssetIndex();

    // 1) 路径级缓存（mtime/size 未变）
    const byPath = this.lookupIndexByVaultPath(file);
    if (byPath) {
      this._assetCache.set(file.path, byPath);
      return byPath;
    }

    const meta = this.fileAssetMeta(file);
    const sizeMb = meta.size ? (meta.size / (1024 * 1024)) : 0;
    if (sizeMb >= 40) {
      console.log("[SiPush] 大附件上传中:", file.path, sizeMb.toFixed(1) + "MB");
    }

    let data;
    try {
      data = await this.app.vault.readBinary(file);
    } catch (e) {
      throw new Error("读取附件失败: " + file.path + " — " + e.message);
    }
    if (!data || (meta.size > 1024 && data.byteLength < 100)) {
      throw new Error("附件内容异常（可能是损坏的占位文件）: " + file.path);
    }

    // 2) 内容哈希：同内容直接复用最早那份，不再上传
    const hash = await sha256Hex(data);
    const byHash = this.lookupIndexByHash(hash);
    if (byHash && byHash.siPath) {
      // 可选：确认思源侧还在（失败则继续上传）
      let stillThere = true;
      try {
        const st = await this.api.statAsset(byHash.siPath);
        if (!st || !(st.size > 0)) stillThere = false;
      } catch (e) {
        stillThere = false;
      }
      if (stillThere) {
        this._assetCache.set(file.path, byHash.siPath);
        this.rememberAssetIndex(file, byHash.siPath, hash, meta);
        await this.saveAssetIndex(false);
        return byHash.siPath;
      }
    }

    const mime = guessAssetMime(file.extension) || "application/octet-stream";
    const uploadName = uniqueAssetName(file, hash);
    let body;
    try {
      body = new File([data], uploadName, { type: mime });
    } catch (e) {
      body = new Blob([data], { type: mime });
    }
    const assetsDir = resolveAssetsDirPath(this.settings.assetsDirPath);
    let assetPath = null;
    try {
      assetPath = await this.api.uploadAsset(body, uploadName, assetsDir);
    } catch (e) {
      if (sizeMb >= 15) {
        console.warn("[SiPush] 大附件上传失败，重试一次:", file.path, e.message);
        await new Promise(r => setTimeout(r, 1000));
        assetPath = await this.api.uploadAsset(body, uploadName, assetsDir);
      } else {
        throw e;
      }
    }
    if (!assetPath) throw new Error("资源上传无返回路径: " + file.path);

    // 写入哈希索引：同内容只保留一份路径（若旧文件已不存在则更新为本次上传）
    if (hash) {
      const prev = this._assetIndex.byHash[hash];
      if (!prev || !prev.siPath) {
        this._assetIndex.byHash[hash] = {
          siPath: assetPath,
          size: meta.size || 0,
          firstSeenAt: Date.now(),
          vaultPaths: [file.path],
        };
      } else {
        // 旧映射对应文件已不存在时，换成新上传路径
        prev.siPath = assetPath;
        const paths = Array.isArray(prev.vaultPaths) ? prev.vaultPaths : [];
        if (!paths.includes(file.path)) paths.push(file.path);
        prev.vaultPaths = paths;
        prev.size = prev.size || meta.size || 0;
      }
      this._assetIndexDirty = true;
    }
    this.rememberAssetIndex(file, assetPath, hash, meta);
    this._assetCache.set(file.path, assetPath);
    await this.saveAssetIndex(false);
    return assetPath;
  }

  async rewriteAndUploadAssets(sourceFile, md) {
    let count = 0;
    let out = md;
    const errors = [];
    const seenReplace = new Set();

    const replaceOne = async (fullMatch, file, alias) => {
      if (seenReplace.has(fullMatch)) return;
      try {
        const before = this._assetCache && this._assetCache.has(file.path);
        await this.loadAssetIndex();
        const indexed = !before && !!this.lookupIndexByVaultPath(file);
        const assetPath = await this.uploadVaultFile(file);
        // 仅统计真正新上传；缓存/索引命中不算新资源
        if (!before && !indexed) count++;
        out = out.split(fullMatch).join(formatAssetMarkdown(file, assetPath, alias));
        seenReplace.add(fullMatch);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.warn("[SiPush] 资源上传失败:", file.path, msg);
        errors.push({ path: file.path, error: msg });
        seenReplace.add(fullMatch);
      }
    };

    // 1) ![[任意附件]] — 嵌入：图片 / PDF / 音频 / 视频 / 文档 全部上传
    const embedRe = /!\[\[([^\]]+)\]\]/g;
    const embeds = [...out.matchAll(embedRe)];
    for (const m of embeds) {
      const { path: linkPath, alias } = parseWikiTarget(m[1]);
      const file = this.resolveVaultFile(sourceFile, linkPath);
      if (!file || !isAssetFile(file)) continue;
      await replaceOne(m[0], file, alias);
    }

    // 2) [[附件.ext]] — 无 ! 的资源双链（非 md）也必须上传
    const wikiAssetRe = /(?<!!)\[\[([^\]]+)\]\]/g;
    const wikiAssets = [...out.matchAll(wikiAssetRe)];
    for (const m of wikiAssets) {
      const { path: linkPath, alias } = parseWikiTarget(m[1]);
      const file = this.resolveVaultFile(sourceFile, linkPath);
      if (!file || !isAssetFile(file)) continue;
      await replaceOne(m[0], file, alias);
    }

    // 3) ![alt](本地路径 / 已有 assets) — 图片保留；音视频若仍是 ![]() 则改成 <audio>/<video>
    const mdImgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const imgs = [...out.matchAll(mdImgRe)];
    for (const m of imgs) {
      const alt = m[1] || "";
      const link = decodeUriPath(m[2].replace(/^<|>$/g, ""));
      if (isRemoteUrl(link)) continue;
      if (shouldReuseAssetLink(link)) {
        const ext = extFromAssetPath(link);
        if (isAudioExt(ext) || isVideoExt(ext)) {
          out = out.split(m[0]).join(formatAssetMarkdown(null, link, alt || null));
          seenReplace.add(m[0]);
        }
        continue;
      }
      const file = this.resolveVaultFile(sourceFile, link);
      if (!file || !isAssetFile(file)) continue;
      await replaceOne(m[0], file, alt || null);
    }

    // 3b) 已有错误写法残留：正文里直接是 assets/xxx.mp3 的图片语法已在上面处理
    // 4) [text](本地附件) — 普通 Markdown 附件链接（非 md）
    const mdLinkRe = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const links = [...out.matchAll(mdLinkRe)];
    for (const m of links) {
      const text = m[1];
      const link = decodeUriPath(m[2].replace(/^<|>$/g, ""));
      if (isRemoteUrl(link) || shouldReuseAssetLink(link) || link.startsWith("#")) continue;
      if (/\.md$/i.test(link)) continue;
      const file = this.resolveVaultFile(sourceFile, link);
      if (!file || !isAssetFile(file)) continue;
      await replaceOne(m[0], file, text || null);
    }

    return { md: out, count, errors };
  }

  // ── V2: 单笔记双向同步 ──
  async syncCurrentNote() {
    if (this.isSyncing) { new Notice("同步进行中..."); return; }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("没有打开的笔记"); return; }
    const file = view.file; if (!file) { new Notice("无法获取文件"); return; }
    const pushId = await this.getOrCreatePushId(file);
    if (!pushId) return;
    this.isSyncing = true;
    this._assetCache = new Map();
    new Notice("正在双向同步...");
    try {
      await this.ensureSiDocMap();
      const result = await this.syncNote(file, pushId, file.basename);
      console.log("[SiPush] sync result:", result);
    } catch(e) { new Notice("❌ 同步出错: " + e.message, 6000); }
    this.isSyncing = false;
    this._assetCache = null;
  }

  // ── V2: 批量双向同步（全库：未关联的也会建立关联并同步） ──
  async batchSync() {
    if (this.isSyncing) { new Notice("同步进行中..."); return; }
    if (!this.ensureConfigured()) return;
    this.isSyncing = true;
    this._assetCache = new Map();
    this._siDocMap = { byPath: new Map(), byName: new Map() };
    this.setStatusBarText("同步中…");

    const results = { synced: 0, failed: 0, conflicts: 0, deleted: 0, skipped: 0, assets: 0, details: [] };
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => !f.path.startsWith(".obsidian/") && !f.path.startsWith(".trash/"))
      .sort((a, b) => a.path.localeCompare(b.path));

    new Notice(`全库双向同步：共 ${files.length} 篇，请稍候...`, 4000);
    console.log("[SiPush V2] 全库双向同步，共 " + files.length + " 篇");

    const obsPushIds = new Set();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        if (i % 10 === 0 || i === files.length - 1) {
          this.setStatusBarText(`同步 ${i + 1}/${files.length}`);
        }
        const pushId = await this.getOrCreatePushId(file);
        obsPushIds.add(pushId);
        // 第一遍跳过双链改写（不改 settings，避免异常中断后设置被写坏）
        const result = await this.syncNote(file, pushId, file.basename, { skipWikilinks: true });
        if (result === "success") {
          results.synced++;
          results.details.push({ title: file.path, status: "success", direction: "已同步" });
        } else if (result === "conflict") {
          results.conflicts++;
          results.details.push({ title: file.path, status: "conflict", direction: "冲突" });
        } else {
          results.failed++;
          results.details.push({ title: file.path, status: "error", direction: "失败" });
        }
      } catch (e) {
        results.failed++;
        results.details.push({
          title: file.path,
          status: "error",
          direction: "异常",
          detail: (e.message || String(e)).substring(0, 80),
        });
      }
    }

    // 清理思源侧被遗弃的文档：有 push-id 但 Obsidian 已删除
    try {
      const siDocs = await this.api.searchLinked(this.settings.defaultNotebookId);
      const deletedPushIds = new Set();
      for (const d of siDocs) {
        if (deletedPushIds.has(d.push_id)) continue;
        if (!obsPushIds.has(d.push_id)) {
          let docExists = false;
          try {
            const content = await this.api.getDocMd(d.id);
            if (content && content.length > 0) docExists = true;
          } catch (e) {
            docExists = false;
          }
          if (!docExists) {
            console.log("[SiPush V2] 跳过已删除文档: " + (d.hpath || "(无路径)"));
            deletedPushIds.add(d.push_id);
            continue;
          }

          let deleteSuccess = false;
          try {
            if (d.path) {
              await this.api.removeDoc(this.settings.defaultNotebookId, d.path);
              deleteSuccess = true;
            }
          } catch (e) {
            try {
              await this.api.removeBlock(d.id);
              deleteSuccess = true;
            } catch (e2) {
              console.log("[SiPush V2] 删除失败: " + (d.hpath || d.id));
            }
          }
          if (deleteSuccess) {
            deletedPushIds.add(d.push_id);
            results.deleted++;
            results.details.push({ title: d.hpath || "(无路径)", status: "deleted", direction: "已删除(遗弃)" });
          } else {
            results.details.push({ title: d.hpath || "(无路径)", status: "error", direction: "删除失败", detail: "API 均失败" });
          }
        }
      }
    } catch (e) {
      console.error("[SiPush V2] 清理废弃文档失败:", e.message);
    }

    // 文档都齐了之后，再写一遍双链
    new Notice("正在写入双链…", 3000);
    await this.rewriteVaultWikilinks(files);

    this.isSyncing = false;
    this._assetCache = null;
    this._siDocMap = null;
    this.setStatusBarText("同步到思源");
    const modal = new SyncReportModal(this.app, results, this);
    modal.open();
    this.logSyncHistory(results);
  }

  // ── V2: 核心同步逻辑（哈希驱动版） ──
  async syncNote(file, pushId, title, opts) {
    opts = opts || {};
    // 1. 获取 Obsidian 当前内容，并做资源/双链预处理（推送态）
    let obsMd;
    try { obsMd = await this.app.vault.read(file); }
    catch(e) { console.error("[SiPush] read error:", e.message); return "error"; }

    let obsRaw = obsMd;
    if (!this.settings.pushFrontmatter) obsRaw = stripFM(obsMd);

    let prepared;
    try {
      prepared = await this.prepareMarkdownForPush(file, obsRaw, { skipWikilinks: !!opts.skipWikilinks });
    } catch (e) {
      console.error("[SiPush] prepare error:", e.message);
      return "error";
    }
    const obsContent = prepared.md;

    // 为哈希对比剥离标题行（与 getDocMd 的 stripSiYuanFrontmatter 行为一致）
    let obsHashContent = obsContent.replace(/^# .*\n*/, "").trim();
    const obsHash = contentHash(obsHashContent);

    // 2. 查找思源文档
    let siDoc;
    try { siDoc = await this.resolveExistingSiDoc(pushId, pluginBuildPath(this, file)); }
    catch(e) { console.error("[SiPush] findDoc error:", e.message); return "error"; }

    if (!siDoc) {
      await this.pushToSiYuan(file, pluginBuildPath(this, file), obsContent, pushId, title, { prepared: true });
      return "success";
    }
    this.registerSiDoc(file, siDoc.id);

    // 3. 获取思源当前内容和存储的同步元信息
    let siMd = "";
    try { siMd = await this.api.getDocMd(siDoc.id); }
    catch(e) { console.error("[SiPush] getDocMd error:", e.message); }

    // 思源文档存在但内容为空 → 视为已删除，直接推送覆盖
    if (!siMd && siDoc) {
      console.log(`[SiPush] "${title}": 思源文档为空（已删除）→ PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title, file);
      return "success";
    }

    const siHash = contentHash(siMd);
    const stored = await this.api.getSyncInfo(siDoc.id);
    const storedHash = stored.hash || null;

    // 4. 内容完全一致 → 跳过
    if (siHash === obsHash) {
      console.log(`[SiPush] "${title}": 内容一致，跳过`);
      return "success";
    }

    // 5. 哈希驱动的方向判断（不依赖时间戳）
    const siChanged = storedHash ? siHash !== storedHash : false;
    const obsChanged = storedHash ? obsHash !== storedHash : false;

    if (!storedHash) {
      // 首次同步 — Obsidian 是源头，默认推送
      console.log(`[SiPush] "${title}": 首次同步 → PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title, file);
      return "success";
    }

    if (siChanged && obsChanged) {
      // 双方都改过 → 冲突
      console.log(`[SiPush] "${title}": 冲突 (双方都改过)`);
      if (this.settings.syncConflictMode === "obsidian-wins") {
        await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title, file);
      } else if (this.settings.syncConflictMode === "siyuan-wins") {
        await this.pullToObsidian(file, siDoc.id, pushId, title);
      } else {
        const cm = new ConflictModal(this.app, obsContent, siMd, title);
        const choice = await cm.openAndResolve();
        if (choice === "obsidian") await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title, file);
        else if (choice === "siyuan") await this.pullToObsidian(file, siDoc.id, pushId, title);
        return "conflict";
      }
    } else if (siChanged && !obsChanged) {
      // 只有思源改过 → 拉取
      console.log(`[SiPush] "${title}": 思源修改 → PULL`);
      await this.pullToObsidian(file, siDoc.id, pushId, title);
    } else if (!siChanged && obsChanged) {
      // 只有 Obsidian 改过 → 推送
      console.log(`[SiPush] "${title}": Obsidian修改 → PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title, file);
    }

    return "success";
  }

  // ── V2: 更新思源文档（push） ──
  async updateSiYuanDoc(docId, md, pushId, hash, mtime, title, file) {
    try {
      await this.api.updateDoc(docId, md);
      await this.api.setSyncInfo(docId, hash, mtime);
      await this.api.setAttrs(docId, { "custom-si-push-id": pushId, title: title });
      if (file) this.registerSiDoc(file, docId);
      new Notice("📤 → 思源 ✅ 已推送: " + title);
    } catch(e) {
      console.error("[SiPush] 更新失败:", e.message);
      new Notice("❌ 更新失败: " + e.message, 6000);
      throw e;
    }
  }

  // ── V2: 拉取到 Obsidian ──
  async pullToObsidian(file, docId, pushId, title) {
    try {
      const siMd = await this.api.getDocMd(docId);
      if (!siMd) { new Notice("思源文档无内容"); return; }
      // 剥离思源自动添加的标题行
      const cleanMd = stripSiTitle(siMd);
      if (!cleanMd.trim()) { new Notice("思源文档无内容"); return; }
      // 写入 Obsidian 文件（ID 放文末小字，并清掉顶部 custom-si-push-id）
      const withId = applyPushIdFooterMigration(
        removePushIdFromFrontmatter(stripPushIdFooter(cleanMd)),
        { preferredId: pushId, createIfMissing: true }
      ).md;
      await this.app.vault.modify(file, withId);
      // 更新存储的哈希（拉取后 Obsidian 和思源内容一致）
      await this.api.setSyncInfo(docId, contentHash(siMd), file.mtime);
      new Notice("📥 ← 思源 ✅ 已拉取: " + title);
    } catch(e) {
      console.error("[SiPush] 拉取失败:", e.message);
      new Notice("❌ 拉取失败: " + e.message, 6000);
      throw e;
    }
  }

  // ── V2: 搜索拉回 ──
  async pullFromSiYuan() {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId, this);
    const doc = await m.openAndGetResult();
    if (!doc) return;
    try {
      const md = await this.api.getDocMd(doc.id);
      if (!md) { new Notice("文档无内容"); return; }
      const cleanMd = stripSiTitle(md);
      if (!cleanMd.trim()) { new Notice("文档无内容"); return; }
      const safeName = safeTitle(doc.hpath.split("/").pop() || "untitled") + "_" + Date.now().toString(36).slice(-6);
      const newId = genPushId();
      const withId = stripPushIdFooter(cleanMd).replace(/\s+$/, "") + formatPushIdFooter(newId);
      await this.app.vault.create(safeName + ".md", withId);
      new Notice("✅ 拉回成功: " + safeName);
    } catch(e) { new Notice("❌ 拉回失败: " + e.message, 6000); }
  }

  // ── 获取或生成 pushId：写在文末极小字；会话内缓存，避免二次生成新 ID ──
  async getOrCreatePushId(file) {
    if (!this._pushIdByPath) this._pushIdByPath = new Map();
    if (file && file.path && this._pushIdByPath.has(file.path)) {
      return this._pushIdByPath.get(file.path);
    }
    let content = "";
    try { content = await this.app.vault.read(file); } catch (e) { content = ""; }
    const { id, md, changed } = applyPushIdFooterMigration(content, { createIfMissing: true });
    if (changed) {
      await this.app.vault.modify(file, md);
    }
    if (file && file.path && id) this._pushIdByPath.set(file.path, id);
    return id;
  }

  /** 解析已有思源文档：内存缓存 → pushId 属性 → hpath，杜绝重复 create */
  async resolveExistingSiDoc(pushId, path) {
    if (!this._docIdByPushId) this._docIdByPushId = new Map();
    if (pushId && this._docIdByPushId.has(pushId)) {
      return { id: this._docIdByPushId.get(pushId), hpath: path || null };
    }
    let doc = null;
    if (pushId) {
      try { doc = await this.api.findDoc(pushId); } catch (e) { /* ignore */ }
    }
    if (!doc && path && this.settings.defaultNotebookId) {
      try { doc = await this.api.findDocByHPath(this.settings.defaultNotebookId, path); } catch (e) { /* ignore */ }
    }
    if (doc && doc.id && pushId) this._docIdByPushId.set(pushId, doc.id);
    return doc;
  }

  rememberSiDoc(pushId, docId, file) {
    if (!this._docIdByPushId) this._docIdByPushId = new Map();
    if (pushId && docId) this._docIdByPushId.set(pushId, docId);
    if (file) this.registerSiDoc(file, docId);
  }

  /** 全库：把 custom-si-push-id 从顶部挪到文末小字（不推思源） */
  async migrateAllPushIdsToFooter(opts) {
    opts = opts || {};
    if (this._migratingPushIds) {
      if (!opts.quiet) new Notice("ID 迁移正在进行中…");
      return 0;
    }
    this._migratingPushIds = true;
    const files = this.app.vault.getMarkdownFiles();
    let changed = 0;
    let scanned = 0;
    if (!opts.quiet) new Notice(`正在迁移关联 ID 到文末（共 ${files.length} 篇）…`, 5000);
    try {
      for (const file of files) {
        scanned++;
        try {
          const content = await this.app.vault.read(file);
          const fmId = extractPushIdFromFrontmatterText(content);
          const footerId = extractPushIdFromContent(content);
          // 仅处理：仍有顶部 id，或有 id 但文末缺失
          if (!fmId && footerId) continue;
          if (!fmId && !footerId) continue;
          const result = applyPushIdFooterMigration(content, {
            preferredId: footerId || fmId,
            createIfMissing: false,
          });
          if (result.changed) {
            await this.app.vault.modify(file, result.md);
            changed++;
          }
        } catch (e) {
          console.warn("[SiPush] 迁移失败:", file.path, e.message);
        }
        if (!opts.quiet && scanned % 200 === 0) {
          this.setStatusBarText(`ID迁移 ${scanned}/${files.length}`);
        }
      }
      this.settings.needsPushIdFooterMigration = false;
      await this.saveSettings();
      this.refreshStatusBar();
      if (!opts.quiet) new Notice(`✅ 关联 ID 已迁到文末：更新 ${changed} 篇`, 8000);
    } finally {
      this._migratingPushIds = false;
    }
    return changed;
  }

  // ── 内部: 推送到思源（返回思源文档 ID） ──
  async pushToSiYuan(file, path, md, pushId, title, opts) {
    opts = opts || {};
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return null; }
    let finalMd = md;
    if (file && !opts.prepared) {
      const prepared = await this.prepareMarkdownForPush(file, md);
      finalMd = prepared.md;
    }
    const hash = contentHash(finalMd.replace(/^# .*\n*/, "").trim());
    const mtime = file ? Math.floor(file.mtime / 1000) : utcSec();

    // 先找已有文档（缓存 / 关联 ID / 同路径），避免 createDocWithMd 再造「标题1」
    let existingDoc = await this.resolveExistingSiDoc(pushId, path);

    if (existingDoc && existingDoc.id) {
      try {
        const docId = await this.updateOrRealignSiDoc(
          existingDoc, path, finalMd, pushId, title, hash, mtime
        );
        this.rememberSiDoc(pushId, docId, file);
        if (!opts.quiet) new Notice("📤 → 思源 ✅ 推送更新成功!");
        return docId;
      } catch (e) {
        if (!opts.quiet) new Notice("❌ 更新失败: " + e.message, 6000);
        throw e;
      }
    }

    try {
      const res = await this.api.createDoc(this.settings.defaultNotebookId, path, finalMd);
      let docId = typeof res === "string" ? res : (res && (res.id || res.rootID)) || res;
      if (docId && typeof docId === "object") docId = docId.id || docId.rootID || null;
      if (!docId) throw new Error("创建文档未返回 ID");

      await this.api.setSyncInfo(docId, hash, mtime);
      await this.api.setAttrs(docId, { "custom-si-push-id": pushId, title: title });
      this.rememberSiDoc(pushId, docId, file);

      // 核验：同 pushId 是否已有更早文档（属性延迟时误建的合并回去）
      try {
        const again = await this.api.findDoc(pushId);
        if (again && again.id && again.id !== docId) {
          await this.api.updateDoc(again.id, finalMd);
          await this.api.setSyncInfo(again.id, hash, mtime);
          await this.api.setAttrs(again.id, { "custom-si-push-id": pushId, title: title });
          this.rememberSiDoc(pushId, again.id, file);
          console.warn("[SiPush] 检测到重复文档，已合并到已有文档:", again.id, "新建的是:", docId);
          return again.id;
        }
      } catch (e) { /* ignore */ }

      if (!opts.quiet) new Notice("📤 → 思源 ✅ 推送新建成功!");
      return docId;
    } catch (e) {
      try {
        const byPath = await this.api.findDocByHPath(this.settings.defaultNotebookId, path);
        if (byPath && byPath.id) {
          await this.api.updateDoc(byPath.id, finalMd);
          await this.api.setSyncInfo(byPath.id, hash, mtime);
          await this.api.setAttrs(byPath.id, { "custom-si-push-id": pushId, title: title });
          this.rememberSiDoc(pushId, byPath.id, file);
          if (!opts.quiet) new Notice("📤 → 思源 ✅ 推送更新成功!");
          return byPath.id;
        }
      } catch (e2) { /* ignore */ }
      if (!opts.quiet) new Notice("❌ 推送失败: " + e.message, 6000);
      throw e;
    }
  }

  /** 更新已有文档；路径不一致时按设置迁到正确层级 */
  async updateOrRealignSiDoc(existingDoc, path, finalMd, pushId, title, hash, mtime) {
    const notebookId = this.settings.defaultNotebookId;
    let currentPath = existingDoc.hpath || null;
    if (!currentPath) {
      try { currentPath = await this.api.getHPathByID(existingDoc.id); } catch (e) { /* ignore */ }
    }
    const cur = normalizeHPath(currentPath);
    const want = normalizeHPath(path);
    const shouldRealign =
      this.settings.realignDocPath !== false &&
      want && want !== "/" &&
      cur && cur !== want;

    if (!shouldRealign) {
      await this.api.updateDoc(existingDoc.id, finalMd);
      await this.api.setSyncInfo(existingDoc.id, hash, mtime);
      await this.api.setAttrs(existingDoc.id, { "custom-si-push-id": pushId, title: title });
      return existingDoc.id;
    }

    console.log("[SiPush] 校正文档路径:", cur, "→", want);

    // 目标路径已有文档：更新它，并删掉旧位置上的同关联文档
    const atTarget = await this.api.findDocByHPath(notebookId, path);
    if (atTarget && atTarget.id) {
      await this.api.updateDoc(atTarget.id, finalMd);
      await this.api.setSyncInfo(atTarget.id, hash, mtime);
      await this.api.setAttrs(atTarget.id, { "custom-si-push-id": pushId, title: title });
      if (atTarget.id !== existingDoc.id) {
        try { await this.api.removeDocByID(existingDoc.id); } catch (e) {
          console.warn("[SiPush] 删除旧路径文档失败:", e.message);
        }
      }
      return atTarget.id;
    }

    // 在正确路径新建，再删旧文档
    try {
      const res = await this.api.createDoc(notebookId, path, finalMd);
      let docId = typeof res === "string" ? res : (res && (res.id || res.rootID)) || res;
      if (docId && typeof docId === "object") docId = docId.id || docId.rootID || null;
      if (!docId) throw new Error("校正路径时创建文档未返回 ID");
      await this.api.setSyncInfo(docId, hash, mtime);
      await this.api.setAttrs(docId, { "custom-si-push-id": pushId, title: title });
      try { await this.api.removeDocByID(existingDoc.id); } catch (e) {
        console.warn("[SiPush] 删除旧路径文档失败:", e.message);
      }
      return docId;
    } catch (e) {
      console.warn("[SiPush] 路径校正失败，回退原地更新:", e.message);
      await this.api.updateDoc(existingDoc.id, finalMd);
      await this.api.setSyncInfo(existingDoc.id, hash, mtime);
      await this.api.setAttrs(existingDoc.id, { "custom-si-push-id": pushId, title: title });
      return existingDoc.id;
    }
  }

  // ── 思源资源池去重（不重推笔记） ──
  openAssetDedup() {
    if (!this.ensureConfigured()) return;
    if (this._assetDedupModal) {
      try { this._assetDedupModal.render(); } catch (e) { /* ignore */ }
      return this._assetDedupModal;
    }
    const modal = new AssetDedupModal(this.app, this);
    this._assetDedupModal = modal;
    modal.open();
    return modal;
  }

  /** 递归列出 data/assets 下全部文件 */
  async listSiYuanAssetFiles(onProgress) {
    const api = this.api;
    const out = [];
    const report = (msg, detail) => {
      if (!onProgress) return;
      onProgress({
        message: msg,
        current: out.length,
        total: 0,
        detail: detail || "",
        stats: out.length ? `已枚举 ${out.length} 个文件` : "",
      });
    };
    const walk = async (relDir) => {
      // relDir: "data/assets" 或 "data/assets/sub"
      const entries = await api.readDir(relDir);
      for (const ent of entries) {
        if (!ent || !ent.name || ent.name.startsWith(".")) continue;
        const child = relDir.replace(/\/+$/, "") + "/" + ent.name;
        if (ent.isDir) {
          if (out.length % 50 === 0) report("① 枚举 data/assets…", "目录 " + child);
          await walk(child);
          continue;
        }
        // 跳过注解 / OCR 等旁路文件
        if (/\.sya$/i.test(ent.name) || ent.name === "ocr-texts.json") continue;
        const size = typeof ent.size === "number" ? ent.size : 0;
        const updated = ent.updated || ent.modTime || 0;
        // data/assets/xxx → assets/xxx
        const linkPath = child.replace(/^data\//, "");
        out.push({
          name: ent.name,
          workspacePath: child,
          linkPath: normalizeAssetLinkPath(linkPath),
          size,
          updated,
        });
        if (out.length === 1 || out.length % 80 === 0) {
          report(`① 枚举资源… 已发现 ${out.length}`, ent.name);
          await yieldUi();
        }
      }
    };
    await walk("data/assets");
    report(`① 枚举完成：共 ${out.length} 个资源`, "");
    return out;
  }

  /** 从文档块中收集被引用的 assets 文件名（只扫引用，不读附件正文） */
  async collectReferencedAssetNames(onProgress) {
    onProgress && onProgress({
      message: "⑤ 扫描文档中的附件引用…",
      current: 0,
      total: 0,
      detail: "",
      stats: "",
    });
    const names = new Set();
    const paths = new Set();
    let offset = 0;
    const page = 3000;
    // 分页拉取含 assets/ 的块，避免一次过大
    for (let round = 0; round < 20; round++) {
      const rows = await this.api.request("/api/query/sql", {
        stmt:
          "SELECT markdown FROM blocks WHERE markdown LIKE '%assets/%' " +
          "LIMIT " + page + " OFFSET " + offset,
      });
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) break;
      const re = /assets\/([^\s)\]\"'<>]+)/gi;
      for (const r of list) {
        const md = r && r.markdown ? String(r.markdown) : "";
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(md))) {
          let full = decodeUriPath(m[0].split("?")[0]);
          full = normalizeAssetLinkPath(full);
          paths.add(full);
          const base = full.split("/").pop();
          if (base) names.add(base);
        }
      }
      offset += list.length;
      onProgress && onProgress({
        message: `⑤ 解析引用块…`,
        current: round + 1,
        total: 0,
        detail: `已扫块 ${offset} · 引用资源名 ${names.size}`,
        stats: `分页 ${round + 1}`,
      });
      await yieldUi();
      if (list.length < page) break;
    }
    return { names, paths };
  }

  /**
   * 快速去重扫描：
   * 1) 枚举文件名（很快）
   * 2) 文件名族归组，只留 ≥2 的候选
   * 3) 只对候选 stat 大小
   * 4) 同族同大小 → 视为重复（默认不读全文哈希）
   * 5) 查文档引用：只有被引用的副本才需要 findReplace
   */
  async scanSiYuanAssetDuplicates(opts) {
    opts = opts || {};
    const rawProgress = opts.onProgress || (() => {});
    const onProgress = (info) => {
      if (typeof info === "string") rawProgress({ message: info });
      else rawProgress(info || {});
    };
    const strictHash = !!opts.strictHash;

    onProgress({ message: "① 枚举 data/assets 文件名…", current: 0, total: 0, detail: "", stats: "" });
    const files = await this.listSiYuanAssetFiles(onProgress);
    onProgress({
      message: `共 ${files.length} 个文件，② 按文件名族归组…`,
      current: files.length,
      total: files.length || 1,
      detail: "",
      stats: "",
    });

    const byFamily = new Map();
    for (const f of files) {
      const key = assetFamilyKey(f.name);
      f.familyKey = key;
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(f);
    }

    const familyCandidates = [];
    let familyCount = 0;
    for (const [, list] of byFamily) {
      if (list.length < 2) continue;
      familyCount++;
      familyCandidates.push(...list);
    }
    onProgress({
      message: `③ 疑似重复族 ${familyCount}（${familyCandidates.length} 个文件），读取大小…`,
      current: 0,
      total: Math.max(1, familyCandidates.length),
      detail: "",
      stats: `族 ${familyCount}`,
    });

    let stated = 0;
    for (const f of familyCandidates) {
      stated++;
      if (stated % 10 === 0 || stated === familyCandidates.length || stated === 1) {
        onProgress({
          message: `③ 读取大小 ${stated}/${familyCandidates.length}`,
          current: stated,
          total: familyCandidates.length,
          detail: f.name,
          stats: `疑似族 ${familyCount}`,
        });
        await yieldUi();
      }
      try {
        const st = await this.api.statAsset(f.linkPath);
        f.size = Number(st.size) || 0;
        if (st.created) f.created = Number(st.created) || 0;
        if (st.updated) f.updated = Number(st.updated) || f.updated;
      } catch (e) {
        f.size = 0;
      }
    }

    // 同族 + 同大小
    const sizeGroups = new Map();
    for (const f of familyCandidates) {
      if (!f.size) continue;
      const gk = f.familyKey + "|" + f.size;
      if (!sizeGroups.has(gk)) sizeGroups.set(gk, []);
      sizeGroups.get(gk).push(f);
    }

    let dupLists = [];
    for (const [, list] of sizeGroups) {
      if (list.length >= 2) dupLists.push(list);
    }

    // 严格模式才全文哈希
    if (strictHash) {
      const flat = dupLists.flat();
      onProgress({
        message: `④ 严格模式：对 ${flat.length} 个候选算哈希…`,
        current: 0,
        total: Math.max(1, flat.length),
        detail: "",
        stats: "",
      });
      const byHash = new Map();
      let hashed = 0;
      for (const f of flat) {
        hashed++;
        if (hashed % 2 === 0 || hashed === flat.length || hashed === 1) {
          onProgress({
            message: `④ 哈希 ${hashed}/${flat.length}`,
            current: hashed,
            total: flat.length,
            detail: `${f.name}（${formatBytes(f.size)}）`,
            stats: "",
          });
          await yieldUi();
        }
        try {
          const buf = await this.api.getFileBinary(f.workspacePath);
          if (buf && buf.byteLength) f.size = buf.byteLength;
          f.hash = await sha256Hex(buf);
          if (!byHash.has(f.hash)) byHash.set(f.hash, []);
          byHash.get(f.hash).push(f);
        } catch (e) {
          f.hashError = e.message;
        }
      }
      dupLists = [];
      for (const [, list] of byHash) {
        if (list.length >= 2) dupLists.push(list);
      }
    } else {
      onProgress({
        message: "④ 快速模式：跳过全文哈希（同族同大小直接合并）",
        current: dupLists.length,
        total: Math.max(1, dupLists.length),
        detail: "",
        stats: `重复组候选 ${dupLists.length}`,
      });
      for (const list of dupLists) {
        for (const f of list) f.hash = "family|" + f.familyKey + "|" + f.size;
      }
    }

    // ⑤ 引用扫描：只对将要删除的副本查是否被引用
    const ref = await this.collectReferencedAssetNames(onProgress);
    onProgress({
      message: `⑤ 文档引用资源 ${ref.names.size} 个，标记需改链接的副本…`,
      current: 0,
      total: Math.max(1, dupLists.length),
      detail: "",
      stats: "",
    });

    const groups = [];
    let duplicateCount = 0;
    let bytesSaved = 0;
    let referencedDupCount = 0;

    for (let gi = 0; gi < dupLists.length; gi++) {
      const list = dupLists[gi];
      const sorted = list.slice().sort((a, b) => {
        const ta = (a.created && a.created > 0) ? a.created : assetEarlinessMs(a);
        const tb = (b.created && b.created > 0) ? b.created : assetEarlinessMs(b);
        if (ta !== tb) return ta - tb;
        return String(a.linkPath).localeCompare(String(b.linkPath));
      });
      const keep = sorted[0];
      const remove = sorted.slice(1).map(f => {
        const referenced =
          ref.paths.has(f.linkPath) ||
          ref.names.has(f.name) ||
          ref.paths.has(normalizeAssetLinkPath(f.linkPath));
        if (referenced) referencedDupCount++;
        return Object.assign({}, f, { referenced: !!referenced });
      });
      duplicateCount += remove.length;
      bytesSaved += remove.reduce((s, x) => s + (x.size || 0), 0);
      groups.push({
        hash: keep.hash || ("family|" + keep.familyKey + "|" + keep.size),
        size: keep.size || 0,
        keep,
        remove,
        files: sorted,
      });
      if ((gi + 1) % 20 === 0 || gi === dupLists.length - 1) {
        onProgress({
          message: `⑤ 整理重复组 ${gi + 1}/${dupLists.length}`,
          current: gi + 1,
          total: dupLists.length,
          detail: keep.name,
          stats: `可删 ${duplicateCount} · 需改引用 ${referencedDupCount}`,
        });
      }
    }
    groups.sort((a, b) => (b.size * b.remove.length) - (a.size * a.remove.length));

    return {
      totalFiles: files.length,
      candidateCount: familyCandidates.length,
      groups,
      duplicateCount,
      referencedDupCount,
      bytesSaved,
      mode: strictHash ? "strict" : "fast",
      scannedAt: utcSec(),
    };
  }

  /** 只删除重复组里的多余副本：每份都先尝试改引用，再删文件；从不按「未引用」清孤儿 */
  async applySiYuanAssetDedup(plan, opts) {
    opts = opts || {};
    const rawProgress = opts.onProgress || (() => {});
    const onProgress = (info) => {
      if (typeof info === "string") rawProgress({ message: info });
      else rawProgress(info || {});
    };
    const groups = (plan && plan.groups) || [];
    const totalDups = groups.reduce((n, g) => n + ((g.remove && g.remove.length) || 0), 0);
    let replaced = 0;
    let deleted = 0;
    let failed = 0;
    let done = 0;
    const replacements = [];

    onProgress({
      message: `开始执行：仅删重复副本 · ${groups.length} 组 · ${totalDups} 个`,
      current: 0,
      total: Math.max(1, totalDups),
      detail: "不会删除非重复文件",
      stats: "",
    });

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const keep = g.keep;
      // 安全：必须有保留文件，且只处理 remove 列表里的重复副本
      if (!keep || !keep.linkPath || !Array.isArray(g.remove) || !g.remove.length) continue;
      for (const dup of g.remove) {
        done++;
        // 绝不删「保留项」本身
        if (!dup || !dup.linkPath || normalizeAssetLinkPath(dup.linkPath) === normalizeAssetLinkPath(keep.linkPath)) {
          onProgress({
            message: `跳过 ${done}/${totalDups}`,
            current: done,
            total: Math.max(1, totalDups),
            detail: "与保留文件相同，跳过",
            stats: `已删 ${deleted} · 改引用 ${replaced} · 失败 ${failed}`,
          });
          await yieldUi();
          continue;
        }
        onProgress({
          message: `删除重复副本 ${done}/${totalDups}（组 ${i + 1}/${groups.length}）`,
          current: done,
          total: Math.max(1, totalDups),
          detail: `先改引用再删：${dup.name} → 保留 ${keep.name}`,
          stats: `已删 ${deleted} · 改引用 ${replaced} · 失败 ${failed}`,
        });
        await yieldUi();
        try {
          // 1) 全局 findReplace（对图片/链接有效；音视频 NodeAudio 常无效）
          try {
            await this.api.findReplaceAssetPath(dup.linkPath, keep.linkPath);
          } catch (e) {
            console.warn("[SiPush] findReplace 失败:", dup.linkPath, e.message);
          }
          try {
            await this.api.findReplaceAssetPath("data/" + dup.linkPath, "data/" + keep.linkPath);
          } catch (e) { /* ignore */ }

          // 2) 文档级改写：覆盖 <audio>/<video> src（去重断链的根因修复）
          try {
            const rw = await this.api.rewriteAssetRefsInDocs(dup.linkPath, keep.linkPath, {
              onProgress: (info) => onProgress({
                message: `改文档引用 ${done}/${totalDups}`,
                current: done,
                total: Math.max(1, totalDups),
                detail: (info && info.detail) || `${dup.name} → ${keep.name}`,
                stats: `已删 ${deleted} · 改引用 ${replaced} · 失败 ${failed}`,
              }),
            });
            if (rw && rw.changed > 0) replaced += rw.changed;
            else replaced++; // 至少记一次尝试
            replacements.push({ from: dup.linkPath, to: keep.linkPath });
          } catch (e) {
            console.warn("[SiPush] 文档改引用失败(继续删副本):", dup.linkPath, e.message);
            replacements.push({ from: dup.linkPath, to: keep.linkPath });
          }

          try {
            await this.api.removeFile(dup.workspacePath);
            deleted++;
          } catch (e1) {
            try {
              await this.api.removeUnusedAsset(dup.linkPath);
              deleted++;
            } catch (e2) {
              failed++;
              console.warn("[SiPush] 删除重复副本失败:", dup.linkPath, e1.message, e2.message);
            }
          }
        } catch (e) {
          failed++;
          console.warn("[SiPush] 去重失败:", dup.linkPath, "→", keep.linkPath, e.message);
        }
      }
    }

    onProgress({
      message: "更新本地附件索引映射…",
      current: totalDups,
      total: Math.max(1, totalDups),
      detail: "",
      stats: `已删重复副本 ${deleted} · 改引用 ${replaced}`,
    });

    await this.loadAssetIndex();
    let mapFixed = 0;
    const fromSet = new Map(replacements.map(r => [normalizeAssetLinkPath(r.from), normalizeAssetLinkPath(r.to)]));
    for (const key of Object.keys(this._assetIndex.byVaultPath || {})) {
      const entry = this._assetIndex.byVaultPath[key];
      if (!entry || !entry.siPath) continue;
      const cur = normalizeAssetLinkPath(entry.siPath);
      if (fromSet.has(cur)) {
        entry.siPath = fromSet.get(cur);
        mapFixed++;
        this._assetIndexDirty = true;
      }
    }
    for (const key of Object.keys(this._assetIndex.byHash || {})) {
      const entry = this._assetIndex.byHash[key];
      if (!entry || !entry.siPath) continue;
      const cur = normalizeAssetLinkPath(entry.siPath);
      if (fromSet.has(cur)) {
        entry.siPath = fromSet.get(cur);
        mapFixed++;
        this._assetIndexDirty = true;
      }
    }
    await this.saveAssetIndex(true);
    onProgress({
      message: `完成：仅删除重复副本 ${deleted} · 改引用 ${replaced} · 失败 ${failed}`,
      current: totalDups,
      total: Math.max(1, totalDups),
      detail: mapFixed ? `本地索引已修正 ${mapFixed} 条` : "非重复文件均未触碰",
      stats: "",
    });
    return { replaced, deleted, failed, skippedReplace: 0, mapFixed };
  }

  // ── 推送收尾：音视频写法 + 附件断链一次性搞定 ──
  async runPostPushRepairs(opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || (() => {});
    const av = await this._doRepairAvMarkup(onProgress);
    const broken = await this._doRepairBrokenRefs(onProgress);
    return { av, broken };
  }

  async _doRepairAvMarkup(onProgress) {
    onProgress = onProgress || (() => {});
    const avRe = /!\[([^\]]*)\]\((assets\/[^)\s]+\.(?:mp3|wav|flac|ogg|m4a|aac|wma|opus|mp4|webm|mov|mkv|avi|m4v|flv|wmv))\)/gi;
    let scanned = 0;
    let fixed = 0;
    let failed = 0;
    onProgress({ message: "修复音视频：查询候选文档…", current: 0, total: 0 });
    const rows = await this.api.request("/api/query/sql", {
      stmt:
        "SELECT DISTINCT root_id FROM blocks WHERE type='p' AND (" +
        "markdown LIKE '%](assets/%.mp3)%' OR markdown LIKE '%](assets/%.wav)%' OR " +
        "markdown LIKE '%](assets/%.m4a)%' OR markdown LIKE '%](assets/%.mp4)%' OR " +
        "markdown LIKE '%](assets/%.ogg)%' OR markdown LIKE '%](assets/%.flac)%'" +
        ") LIMIT 5000",
    });
    const roots = Array.isArray(rows) ? rows.map(r => r.root_id).filter(Boolean) : [];
    const uniq = Array.from(new Set(roots));
    onProgress({
      message: uniq.length ? `修复音视频：${uniq.length} 篇候选` : "修复音视频：无需处理",
      current: 0,
      total: Math.max(1, uniq.length),
    });
    for (const id of uniq) {
      scanned++;
      onProgress({
        message: `修复音视频 ${scanned}/${uniq.length}`,
        current: scanned,
        total: Math.max(1, uniq.length),
        detail: `文档 ${id}`,
        stats: `已修复 ${fixed} · 失败 ${failed}`,
      });
      await yieldUi();
      try {
        const md = await this.api.getDocMd(id);
        if (!md || !avRe.test(md)) continue;
        avRe.lastIndex = 0;
        const next = md.replace(avRe, (_, alt, p) => formatAssetMarkdown(null, p, alt || null));
        if (next === md) continue;
        await this.api.updateDoc(id, next);
        fixed++;
      } catch (e) {
        failed++;
        console.warn("[SiPush] 修复音视频失败:", id, e.message);
      }
    }
    return { scanned, fixed, failed };
  }

  async _doRepairBrokenRefs(onProgress) {
    onProgress = onProgress || (() => {});
    let pairCount = 0;
    let docsTouched = 0;
    let replaceOps = 0;
    let unresolved = 0;

    onProgress({ message: "修复断链：① 枚举 assets…", current: 0, total: 0 });
    const files = await this.listSiYuanAssetFiles((info) => {
      onProgress(typeof info === "string"
        ? { message: info }
        : Object.assign({ message: "修复断链：① 枚举 assets…" }, info || {}));
    });
    const existing = new Set(files.map(f => f.name));
    const byFamily = new Map();
    for (const f of files) {
      const key = assetFamilyKey(f.name);
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(f);
    }
    for (const [, list] of byFamily) {
      list.sort((a, b) => {
        const ta = (a.created && a.created > 0) ? a.created : assetEarlinessMs(a);
        const tb = (b.created && b.created > 0) ? b.created : assetEarlinessMs(b);
        if (ta !== tb) return ta - tb;
        return String(a.linkPath).localeCompare(String(b.linkPath));
      });
    }

    onProgress({ message: "修复断链：② 扫描文档引用…", current: 0, total: 0 });
    const refPathToDocs = new Map();
    let offset = 0;
    const page = 3000;
    const re = /assets\/([^\s)\]\"'<>]+)/gi;
    for (let round = 0; round < 40; round++) {
      const rows = await this.api.request("/api/query/sql", {
        stmt:
          "SELECT root_id, markdown FROM blocks WHERE markdown LIKE '%assets/%' " +
          "LIMIT " + page + " OFFSET " + offset,
      });
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) break;
      for (const r of list) {
        const md = r && r.markdown ? String(r.markdown) : "";
        const rootId = r && r.root_id;
        if (!rootId || !md) continue;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(md))) {
          let full = decodeUriPath(m[0].split("?")[0]);
          full = normalizeAssetLinkPath(full);
          const base = full.split("/").pop();
          if (!base || existing.has(base)) continue;
          if (!refPathToDocs.has(full)) refPathToDocs.set(full, new Set());
          refPathToDocs.get(full).add(rootId);
        }
      }
      offset += list.length;
      onProgress({
        message: `修复断链：② 已扫块 ${offset}`,
        current: round + 1,
        total: 0,
        detail: `疑似断链 ${refPathToDocs.size}`,
      });
      await yieldUi();
      if (list.length < page) break;
    }

    const pairs = [];
    for (const [linkPath, docs] of refPathToDocs) {
      const name = linkPath.split("/").pop();
      const key = assetFamilyKey(name);
      const cands = byFamily.get(key) || [];
      if (!cands.length) { unresolved++; continue; }
      const keep = cands[0];
      pairs.push({
        from: linkPath,
        to: keep.linkPath,
        fromName: name,
        toName: keep.name,
        docs: Array.from(docs),
      });
    }
    pairCount = pairs.length;

    if (!pairs.length) {
      onProgress({
        message: unresolved
          ? `修复断链：无可自动修复（无法匹配 ${unresolved}）`
          : "修复断链：无需处理",
        current: 1,
        total: 1,
      });
      return { pairCount: 0, docsTouched: 0, replaceOps: 0, unresolved };
    }

    const touched = new Set();
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      onProgress({
        message: `修复断链 ${i + 1}/${pairs.length}`,
        current: i + 1,
        total: pairs.length,
        detail: `${p.fromName} → ${p.toName}`,
        stats: `已改文档 ${touched.size} · 无法匹配 ${unresolved}`,
      });
      await yieldUi();
      try {
        let changed = 0;
        for (const id of p.docs) {
          try {
            let md = await this.api.getDocMd(id);
            if (!md) continue;
            if (md.indexOf(p.from) < 0 && md.indexOf(p.fromName) < 0) continue;
            let next = md.split(p.from).join(p.to);
            if (next === md) next = md.split(p.fromName).join(p.toName);
            if (next === md) continue;
            await this.api.updateDoc(id, next);
            touched.add(id);
            changed++;
            replaceOps++;
          } catch (e) {
            console.warn("[SiPush] 断链修复单文档失败:", id, e.message);
          }
        }
        if (!changed) {
          const rw = await this.api.rewriteAssetRefsInDocs(p.from, p.to);
          if (rw && rw.changed) {
            replaceOps += rw.changed;
            docsTouched += rw.changed;
          }
        }
      } catch (e) {
        console.warn("[SiPush] 断链修复失败:", p.from, "→", p.to, e.message);
      }
    }
    docsTouched = Math.max(docsTouched, touched.size);

    try {
      await this.loadAssetIndex();
      let mapFixed = 0;
      const fromSet = new Map(pairs.map(p => [normalizeAssetLinkPath(p.from), normalizeAssetLinkPath(p.to)]));
      for (const store of [this._assetIndex.byVaultPath, this._assetIndex.byHash]) {
        for (const key of Object.keys(store || {})) {
          const entry = store[key];
          if (!entry || !entry.siPath) continue;
          const cur = normalizeAssetLinkPath(entry.siPath);
          if (fromSet.has(cur)) {
            entry.siPath = fromSet.get(cur);
            mapFixed++;
            this._assetIndexDirty = true;
          }
        }
      }
      await this.saveAssetIndex(true);
      if (mapFixed) console.log("[SiPush] 断链修复同步索引", mapFixed);
    } catch (e) {
      console.warn("[SiPush] 断链修复写索引失败:", e.message);
    }

    onProgress({
      message: `修复断链完成：路径 ${pairCount} · 文档 ${docsTouched}`,
      current: pairs.length,
      total: pairs.length,
      detail: unresolved ? `无法匹配 ${unresolved}` : "",
    });
    return { pairCount, docsTouched, replaceOps, unresolved };
  }

  // ── 修复思源里被写成图片语法的音视频（显示「找不到」） ──
  async repairSiYuanAudioVideoMarkup() {
    if (!this.ensureConfigured()) return;
    if (this._repairingAv || this._repairingBrokenRefs) { new Notice("修复进行中…"); return; }
    this._repairingAv = true;
    const modal = new AssetOpProgressModal(this.app, this, "🔊 修复思源音视频引用");
    modal.open();
    try {
      const r = await this._doRepairAvMarkup((info) => modal.setProgress(info));
      const doneMsg = `✅ 完成：扫描 ${r.scanned} · 修复 ${r.fixed} · 失败 ${r.failed}`;
      modal.setProgress({ message: doneMsg, current: r.scanned || 1, total: Math.max(1, r.scanned) });
      modal.markDone(doneMsg);
      new Notice(doneMsg, 8000);
    } catch (e) {
      modal.markDone("❌ 修复失败: " + e.message);
      new Notice("❌ 修复失败: " + e.message, 8000);
    } finally {
      this._repairingAv = false;
      this.refreshStatusBar();
    }
  }

  /**
   * 修复「文档仍引用已删副本」的断链（也可由推送收尾自动执行）
   */
  async repairBrokenAssetRefs() {
    if (!this.ensureConfigured()) return;
    if (this._repairingBrokenRefs || this._repairingAv) { new Notice("修复进行中…"); return; }
    this._repairingBrokenRefs = true;
    const modal = new AssetOpProgressModal(this.app, this, "🔗 修复附件断链");
    modal.open();
    try {
      const r = await this._doRepairBrokenRefs((info) => modal.setProgress(info));
      const doneMsg = r.pairCount
        ? `✅ 断链修复完成：路径 ${r.pairCount} · 文档 ${r.docsTouched} · 替换 ${r.replaceOps}` +
          (r.unresolved ? ` · 无法匹配 ${r.unresolved}` : "")
        : (r.unresolved
          ? `未找到可自动修复的断链（另有 ${r.unresolved} 条无同族文件可匹配）`
          : "✅ 未发现附件断链，无需修复");
      modal.setProgress({ message: doneMsg, current: 1, total: 1 });
      modal.markDone(doneMsg);
      new Notice(doneMsg, 10000);
    } catch (e) {
      modal.markDone("❌ 断链修复失败: " + e.message);
      new Notice("❌ 断链修复失败: " + e.message, 8000);
    } finally {
      this._repairingBrokenRefs = false;
      this.refreshStatusBar();
    }
  }

  // ── 测试连接 ──
  async testConnection() {
    new Notice("正在测试连接...");
    try {
      const nbs = await this.api.getNotebooks();
      const lines = nbs.map(n => "  📓 " + n.name + " (" + n.id.substring(0,12) + "…)");
      new Notice("✅ 连接成功！" + nbs.length + " 个笔记本:\n" + lines.join("\n"), 8000);
    } catch(e) { new Notice("❌ 连接失败: " + e.message, 6000); }
  }

  // ── 同步历史 + 失败队列 ──
  async logSyncHistory(results) {
    const fails = (results.details || []).filter(d => d.status === "error" || d.status === "failed");
    const okPaths = new Set(
      (results.details || [])
        .filter(d => d.status === "success" || d.status === "conflict" || d.status === "deleted")
        .map(d => d.title)
    );

    // 更新失败队列：成功的移除，失败的写入/更新
    const map = new Map();
    for (const item of this.settings.failedQueue || []) {
      if (item && item.path) map.set(item.path, item);
    }
    for (const path of okPaths) map.delete(path);
    for (const d of fails) {
      const prev = map.get(d.title) || { path: d.title, retries: 0 };
      map.set(d.title, {
        path: d.title,
        error: d.detail || d.direction || prev.error || "未知错误",
        time: utcSec(),
        retries: prev.retries || 0,
      });
    }
    this.settings.failedQueue = Array.from(map.values());

    // 历史只保留摘要 + 失败明细，避免 data.json 膨胀
    const slim = {
      time: utcSec(),
      synced: results.synced || 0,
      failed: results.failed || 0,
      conflicts: results.conflicts || 0,
      deleted: results.deleted || 0,
      skipped: results.skipped || 0,
      assets: results.assets || 0,
      details: fails,
    };
    const h = this.settings.syncHistory || [];
    h.unshift(slim);
    this.settings.syncHistory = h.slice(0, this.settings.maxSyncHistory || 20);
    await this.saveSettings();
    this.refreshStatusBar();
    if (fails.length) {
      try { await this.exportFailedReport(); } catch (e) { console.warn("[SiPush] 导出失败列表:", e.message); }
    }
  }

  async exportFailedReport() {
    const queue = this.settings.failedQueue || [];
    const hist = this.settings.syncHistory || [];
    const last = hist[0];
    const lines = [
      "# SiPush 推送失败队列",
      "",
      `更新时间：${formatTime(utcSec())}`,
      "",
      last
        ? `最近一次同步：✅ ${last.synced || 0} 成功 / ❌ ${last.failed || 0} 失败（${formatTime(last.time)}）`
        : "最近一次同步：暂无",
      "",
      `当前失败积压：**${queue.length}** 篇`,
      "",
      "> 修好插件或思源配置后，在命令面板执行「重试推送失败项」，或点左侧「查看推送失败队列」。",
      "",
    ];
    if (!queue.length) {
      lines.push("（队列为空）");
    } else {
      const byErr = {};
      for (const item of queue) {
        const k = item.error || "未知错误";
        if (!byErr[k]) byErr[k] = [];
        byErr[k].push(item);
      }
      lines.push("## 按错误分类");
      lines.push("");
      for (const [err, items] of Object.entries(byErr)) {
        lines.push(`### ${err}（${items.length}）`);
        lines.push("");
        for (const item of items) {
          lines.push(`- [[${item.path.replace(/\.md$/i, "")}]]`);
        }
        lines.push("");
      }
      lines.push("## 完整列表");
      lines.push("");
      lines.push("| 路径 | 错误 | 时间 | 重试 |");
      lines.push("| --- | --- | --- | --- |");
      for (const item of queue) {
        lines.push(
          `| \`${item.path}\` | ${String(item.error || "").replace(/\|/g, "\\|")} | ${item.time ? formatTime(item.time) : "-"} | ${item.retries || 0} |`
        );
      }
    }
    const path = "SiPush-推送失败队列.md";
    const body = lines.join("\n") + "\n";
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
    return path;
  }

  async retryFailedQueue() {
    if (!this.ensureConfigured()) return;
    const queue = this.settings.failedQueue || [];
    if (!queue.length) {
      new Notice("失败队列为空，无需重试");
      return;
    }

    const paths = [];
    let missing = 0;
    for (const item of queue) {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) {
        paths.push(item.path);
        item.retries = (item.retries || 0) + 1;
      } else {
        missing++;
      }
    }
    await this.saveSettings();

    if (!paths.length) {
      new Notice("失败队列里的文件都已不存在，无法重试");
      return;
    }
    if (missing > 0) {
      new Notice(`已跳过 ${missing} 个不存在的文件，开始重试 ${paths.length} 篇`, 5000);
    }

    // 先打开控制台展示进度，再启动与普通推送相同的任务机
    this.openPushControl({ forceRender: true });
    await new Promise(r => window.setTimeout(r, 50));
    await this.startPushJob({
      paths,
      label: `重试失败队列（${paths.length} 篇）`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// 设置页
// ═══════════════════════════════════════════════════════════════════
class SiPushSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._dd = null;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SiPush - 思源同步设置 (V2.1)" });

    new Setting(containerEl).setName("思源服务器地址").setDesc("Kernel API 地址")
      .addText(t => t.setPlaceholder("http://127.0.0.1:6806").setValue(this.plugin.settings.serverUrl)
        .onChange(async v => { this.plugin.settings.serverUrl = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("API Token").setDesc("思源设置 → 关于 → API Token")
      .addText(t => t.setPlaceholder("留空不使用").setValue(this.plugin.settings.apiToken)
        .onChange(async v => { this.plugin.settings.apiToken = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).addButton(b => b.setButtonText("🔌 测试连接").onClick(() => this.plugin.testConnection()));

    new Setting(containerEl).setName("迁移关联 ID 到文末")
      .setDesc("清除笔记顶部 custom-si-push-id，改为文末极小字 si-push · id:…")
      .addButton(b => b.setButtonText("立即迁移").setCta().onClick(() => {
        this.plugin.migrateAllPushIdsToFooter({ force: true });
      }));

    new Setting(containerEl).setName("默认笔记本").setDesc("打开设置时自动从思源加载；也可手动刷新")
      .addDropdown(dd => {
        this._dd = dd;
        this.fillNotebookDropdown(dd, this.plugin.settings.notebookCache || []);
        dd.onChange(async v => { this.plugin.settings.defaultNotebookId = v; await this.plugin.saveSettings(); });
      }).addButton(b => b.setButtonText("🔄 刷新").setCta().onClick(() => this.refresh(false)));

    // 打开设置页时静默拉取最新笔记本列表，避免每次都要手动刷新
    if (this.plugin.settings.serverUrl) {
      this.refresh(true);
    }
    new Setting(containerEl).setName("默认路径前缀").setDesc("思源文档根路径。填 /Obsidian/ 会建在「Obsidian」下；填 / 则直接在笔记本根下（与 Obsidian 文件夹一一对应，深层笔记更不容易被压平）")
      .addText(t => t.setPlaceholder("/Obsidian/").setValue(this.plugin.settings.defaultPath)
        .onChange(async v => { this.plugin.settings.defaultPath = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("保留 Frontmatter").setDesc("推送时保留 --- frontmatter --- 区域")
      .addToggle(t => t.setValue(this.plugin.settings.pushFrontmatter)
        .onChange(async v => { this.plugin.settings.pushFrontmatter = v; await this.plugin.saveSettings(); }));

    // V2 设置
    containerEl.createEl("h3", { text: "🔄 双向同步设置 (V2)" });

    new Setting(containerEl).setName("冲突解决策略").setDesc("当 Obsidian 和思源同时修改时如何处理")
      .addDropdown(dd => {
        dd.addOption("ask", "弹窗让用户选择");
        dd.addOption("obsidian-wins", "始终保留 Obsidian 版本");
        dd.addOption("siyuan-wins", "始终保留思源版本");
        dd.setValue(this.plugin.settings.syncConflictMode);
        dd.onChange(async v => { this.plugin.settings.syncConflictMode = v; await this.plugin.saveSettings(); });
      });

    containerEl.createEl("h3", { text: "📦 全库推送 / 资源与双链 (V2.1)" });

    new Setting(containerEl).setName("一键同步动作")
      .setDesc("点击左侧云图标 / 底部「同步到思源」时执行的操作")
      .addDropdown(dd => {
        dd.addOption("vault", "全库推送到思源（推荐）");
        dd.addOption("current", "仅同步当前笔记");
        dd.setValue(this.plugin.settings.oneClickAction || "vault");
        dd.onChange(async v => { this.plugin.settings.oneClickAction = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName("保留文件夹结构")
      .setDesc("推送时尽量按 Obsidian 相对路径建文档；超过思源最大深度时自动压平（中间层用 __ 拼进文档名）")
      .addToggle(t => t.setValue(this.plugin.settings.preserveFolderStructure !== false)
        .onChange(async v => { this.plugin.settings.preserveFolderStructure = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("思源文档最大深度")
      .setDesc("建议 7（思源叶子文档最深一层）。设小会把深层路径压成「目录__子目录__文件名」，看起来层级就乱了")
      .addText(t => t.setPlaceholder("7").setValue(String(this.plugin.settings.maxDocDepth || 7))
        .onChange(async v => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxDocDepth = Number.isFinite(n) && n > 0 ? Math.min(n, 7) : 7;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("自动校正文档路径")
      .setDesc("已关联文档的思源路径与当前规则不一致时，推送会迁到正确层级并删除旧位置（改前缀/深度后重推可对齐层级）")
      .addToggle(t => t.setValue(this.plugin.settings.realignDocPath !== false)
        .onChange(async v => { this.plugin.settings.realignDocPath = v; await this.plugin.saveSettings(); }));

    const failN = (this.plugin.settings.failedQueue || []).length;
    containerEl.createEl("h3", { text: "📋 推送失败队列" });
    new Setting(containerEl)
      .setName(failN ? `当前积压 ${failN} 篇失败` : "失败队列为空")
      .setDesc("查看明细、导出笔记，或在修完 bug 后重试")
      .addButton(b => b.setButtonText("查看队列").setCta().onClick(() => this.plugin.openPushHistory()))
      .addButton(b => b.setButtonText("重试失败项").onClick(() => this.plugin.retryFailedQueue()));

    containerEl.createEl("h3", { text: "🚀 推送控制" });
    new Setting(containerEl)
      .setName("推送控制台")
      .setDesc("指定文件夹/单篇推送；暂停、继续、从指定笔记重新推送")
      .addButton(b => b.setButtonText("打开控制台").setCta().onClick(() => this.plugin.openPushControl()));

    new Setting(containerEl)
      .setName("树状勾选推送")
      .setDesc("打开仓库文件夹树，勾选要同步到思源的文档")
      .addButton(b => b.setButtonText("打开树状选择").setCta().onClick(() => this.plugin.openVaultTreeSelect()));
    new Setting(containerEl).setName("同步媒体与附件")
      .setDesc("图片、PDF、音视频(含 wav)、Office、压缩包等本地引用一律上传到思源 assets；已上传的会记住路径，避免重复上传出多份副本")
      .addToggle(t => t.setValue(this.plugin.settings.syncAssets !== false)
        .onChange(async v => { this.plugin.settings.syncAssets = v; await this.plugin.saveSettings(); }));

    const idxPath = this.plugin.assetIndexFilePath();
    let idxN = 0;
    try {
      const idx = this.plugin._assetIndex || null;
      if (idx && idx.byHash) idxN = Object.keys(idx.byHash).length;
      else if (fs.existsSync(idxPath)) {
        const j = JSON.parse(fs.readFileSync(idxPath, "utf8"));
        idxN = Object.keys((j && j.byHash) || {}).length;
      }
    } catch (e) { /* ignore */ }
    new Setting(containerEl).setName("附件哈希索引")
      .setDesc(idxN
        ? `asset-index.json 已记录 ${idxN} 个内容哈希；同哈希附件推送时直接复用，不再重复上传`
        : "同步时写入插件目录 asset-index.json（路径/哈希/思源 assets）")
      .addButton(b => b.setButtonText("打开目录").onClick(() => {
        try {
          const { shell } = require("electron");
          shell.showItemInFolder(idxPath);
        } catch (e) {
          new Notice("索引文件: " + idxPath, 8000);
        }
      }))
      .addButton(b => b.setButtonText("清空索引").onClick(async () => {
        this.plugin._assetIndex = this.plugin.emptyAssetIndex();
        this.plugin._assetIndexDirty = true;
        this.plugin._assetCache = null;
        this.plugin.settings.assetMap = {};
        await this.plugin.saveAssetIndex(true);
        await this.plugin.saveSettings();
        new Notice("已清空附件哈希索引");
        this.display();
      }));

    new Setting(containerEl).setName("推送结束自动修复")
      .setDesc("推送完成后自动：① 音视频 ![]→播放器 ② 附件断链改到仍存在的文件。一般不用再单独点修复")
      .addToggle(t => t.setValue(this.plugin.settings.autoRepairAfterPush !== false)
        .onChange(async v => { this.plugin.settings.autoRepairAfterPush = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("去重思源资源池")
      .setDesc("只删重复副本（同内容/同族同大小多份里留最早一份）；不会因为「未被引用」而删除独立文件")
      .addButton(b => b.setButtonText("开始去重").setCta().onClick(() => this.plugin.openAssetDedup()));

    new Setting(containerEl).setName("修复附件断链")
      .setDesc("去重后若文档仍指向已删副本：按文件名族改到仍存在的那份（推送结束默认也会自动跑）")
      .addButton(b => b.setButtonText("一键修复").onClick(() => this.plugin.repairBrokenAssetRefs()));

    new Setting(containerEl).setName("修复音视频引用")
      .setDesc("把误写成 ![](assets/xxx.mp3) 的改成播放器（推送结束默认也会自动跑）")
      .addButton(b => b.setButtonText("立即修复").onClick(() => this.plugin.repairSiYuanAudioVideoMarkup()));

    new Setting(containerEl).setName("转换双链")
      .setDesc("将 [[笔记]] 转为思源块引用 ((文档ID \"显示名\"))，才能在思源里点击跳转")
      .addToggle(t => t.setValue(this.plugin.settings.rewriteWikilinks !== false)
        .onChange(async v => { this.plugin.settings.rewriteWikilinks = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("资源上传目录")
      .setDesc("思源官方建议用 /assets/；勿用子目录（旧版 sipush 会导致附件找不到）")
      .addText(t => t.setPlaceholder("/assets/").setValue(this.plugin.settings.assetsDirPath || "/assets/")
        .onChange(async v => {
          this.plugin.settings.assetsDirPath = resolveAssetsDirPath(v || "/assets/");
          await this.plugin.saveSettings();
        }));

    const info = containerEl.createDiv({ cls: "si-push-info" });
    Object.assign(info.style, { marginTop:"24px", padding:"12px", background:"var(--background-secondary)", borderRadius:"6px" });
    info.createEl("p", { text: "💡 功能说明" });
    info.createEl("ul").innerHTML = `
      <li><strong>☁️ 一键全库推送到思源</strong>：遍历 Vault 全部 Markdown，含未关联笔记；引用资源必传，双链可打开</li>
      <li><strong>推送</strong>：当前笔记 → 思源（已有文档原地更新）</li>
      <li><strong>🔄 双向同步当前笔记</strong>：对比内容哈希，自动 push 或 pull</li>
      <li><strong>🔄 批量双向同步</strong>：仅处理已关联笔记</li>
      <li><strong>📥 搜索思源文档并拉回</strong>：从思源搜索文档，拉取到 Obsidian</li>
      <li>关联标记：文末极小字 <code>si-push · id:…</code>（不再写入顶部 frontmatter）</li>
      <li>资源：凡笔记里引用的本地非 md 文件都上传（图片/PDF/音视频/Office/压缩包等）</li>
      <li>写法支持：<code>![[a.pdf]]</code> <code>[[a.mp3]]</code> <code>![](a.png)</code> <code>[文档](a.docx)</code></li>
      <li>双链：全库同步两遍——先建文档，再把 <code>[[笔记]]</code> 写成 <code>((文档ID "显示名"))</code>，思源可点击</li>
    `;
  }
  fillNotebookDropdown(dd, notebooks) {
    if (!dd) return;
    const selected = this.plugin.settings.defaultNotebookId || "";
    dd.selectEl.empty();
    dd.addOption("", notebooks && notebooks.length ? "-- 请选择笔记本 --" : "-- 加载中 / 请刷新 --");
    let found = false;
    for (const nb of notebooks || []) {
      if (!nb || !nb.id) continue;
      dd.addOption(nb.id, (nb.closed ? "📁 " : "📓 ") + (nb.name || nb.id));
      if (nb.id === selected) found = true;
    }
    // 缓存里没有当前已选 ID 时，先占位显示，避免下拉空白
    if (selected && !found) {
      dd.addOption(selected, "📓 " + selected.substring(0, 12) + "…（已保存）");
    }
    if (selected) dd.setValue(selected);
  }

  async refresh(quiet) {
    const dd = this._dd; if (!dd) return;
    const api = new SiYuanApi(this.plugin.settings.serverUrl, this.plugin.settings.apiToken);
    try {
      const nbs = await api.getNotebooks();
      const list = (nbs || []).map(nb => ({ id: nb.id, name: nb.name, closed: !!nb.closed }));
      this.plugin.settings.notebookCache = list;
      await this.plugin.saveSettings();
      this.fillNotebookDropdown(dd, list);
      if (!quiet) new Notice("✅ 已加载 " + list.length + " 个笔记本");
    } catch (e) {
      if (!quiet) new Notice("❌ 获取失败: " + e.message, 6000);
      else console.warn("[SiPush] 自动加载笔记本失败:", e.message);
    }
  }
}

module.exports = SiPushPlugin;
