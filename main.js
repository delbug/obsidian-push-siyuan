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
  // 一键同步默认动作：vault = 全库推送，current = 仅当前笔记
  oneClickAction: "vault",
  // 缓存笔记本列表，打开设置时无需每次点刷新才能看到名称
  notebookCache: [],
  // 思源文档树最大深度（默认 6，给压平留余量；7 层下无法再创建子文档）
  maxDocDepth: 6,
  // 推送失败队列：修好 bug 后可一键重试
  failedQueue: [],
  // 可暂停/继续的推送任务断点
  pushJob: null,
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

/** 可内联预览的媒体：图片 / 音视频 → 用 ![](assets/...) 便于思源展示播放 */
const INLINE_MEDIA_EXTS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic",
  // 音频
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus",
  // 视频
  "mp4", "webm", "mov", "mkv", "avi", "m4v", "flv", "wmv",
]);
function isRemoteUrl(p) { return /^https?:\/\//i.test(p) || /^data:/i.test(p) || /^siyuan:/i.test(p); }
function isInlineMediaExt(ext) { return INLINE_MEDIA_EXTS.has((ext || "").toLowerCase()); }
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
/** 按类型生成思源可识别的 Markdown 引用 */
function formatAssetMarkdown(file, assetPath, alias) {
  const name = (alias || file.basename || "file").replace(/[\[\]]/g, "");
  const ext = (file.extension || "").toLowerCase();
  const path = normalizeAssetLinkPath(assetPath);
  // 图片/音视频：内联，思源可预览或播放
  if (isInlineMediaExt(ext)) return `![${name}](${path})`;
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
/**
 * 上传文件名：短、无空格、无特殊字符。
 * 旧实现用整段路径 + 空格，思源侧常变成 assets/sipush/xxx%20yyy.mp3 导致找不到。
 */
function uniqueAssetName(file) {
  const ext = file.extension ? ("." + String(file.extension).toLowerCase()) : "";
  // Obsidian 的 basename 本身不含扩展名；不要用 \.[^.]+$ 乱裁，否则 19.00_19.40 会被截断
  const rawBase = String(file.basename || "asset");
  const base = safeTitle(rawBase)
    .replace(/\s+/g, "_")
    .replace(/[^\w\u4e00-\u9fff._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "asset";
  const hash = contentHash(file.path).slice(0, 8);
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
    const stmt =
      "SELECT b.id, b.hpath, b.box, b.updated FROM blocks b " +
      "JOIN attributes a ON a.block_id = b.id " +
      "WHERE a.name='custom-si-push-id' AND a.value='" + pushId.replace(/'/g,"''") + "' " +
      "AND b.type='d' ORDER BY b.updated DESC LIMIT 1";
    const d = await this.request("/api/query/sql", { stmt });
    return d && d.length > 0 ? d[0] : null;
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
  async removeBlock(id) { return this.request("/api/block/removeBlock", { id }); }

  // ── 上传资源到思源 assets ──
  async uploadAsset(blob, fileName, assetsDirPath) {
    const form = new FormData();
    form.append("assetsDirPath", resolveAssetsDirPath(assetsDirPath));
    form.append("file[]", blob, fileName);
    const headers = {};
    if (this.token) headers["Authorization"] = "Token " + this.token;
    let resp;
    try {
      resp = await fetch(this.url + "/api/asset/upload", { method: "POST", headers, body: form });
    } catch (e) {
      throw new Error("上传资源失败: " + e.message);
    }
    const j = await resp.json();
    if (j.code !== 0) throw new Error("SiYuan upload: " + (j.msg || "code=" + j.code));
    const map = (j.data && j.data.succMap) || {};
    const errFiles = (j.data && j.data.errFiles) || [];
    if (errFiles && errFiles.length && !Object.keys(map).length) {
      throw new Error("SiYuan upload errFiles: " + errFiles.join(", "));
    }
    const raw = map[fileName] || Object.values(map)[0] || null;
    return normalizeAssetLinkPath(raw);
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
      const back = acts.createEl("button", { text: "← 返回推送控制台", cls: "mod-cta" });
      back.onclick = () => { this.close(); this.plugin.openPushControl(); };
      const b1 = acts.createEl("button", { text: "📋 查看失败队列" });
      b1.onclick = () => { this.close(); this.plugin.openPushHistory(); };
      if (failN > 0) {
        const b2 = acts.createEl("button", { text: "🔁 重试失败项" });
        b2.onclick = () => { this.close(); this.plugin.retryFailedQueue(); };
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
    const back = acts.createEl("button", { text: "← 返回推送控制台", cls: "mod-cta" });
    back.onclick = () => {
      this.close();
      this.plugin.openPushControl();
    };
    if (queue.length) {
      const retry = acts.createEl("button", { text: "🔁 重试全部失败项" });
      retry.onclick = () => { this.close(); this.plugin.retryFailedQueue(); };
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
// 选择文件夹推送
// ═══════════════════════════════════════════════════════════════════
class FolderSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChooseCb = onChoose;
    this.setPlaceholder("选择要推送的文件夹…");
  }
  getItems() {
    // 不依赖 getAllLoadedFiles，从 md 文件反推文件夹，兼容性更好
    const map = new Map();
    map.set("", { path: "", name: "(整个仓库)" });
    for (const f of this.app.vault.getMarkdownFiles()) {
      let folder = f.parent;
      while (folder) {
        if (folder.path && !folder.path.startsWith(".obsidian") && !folder.path.startsWith(".trash")) {
          if (!map.has(folder.path)) map.set(folder.path, folder);
        }
        folder = folder.parent;
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.path || "").localeCompare(b.path || ""));
  }
  getItemText(item) {
    return item.path ? item.path : "(整个仓库)";
  }
  onChooseItem(item) {
    if (this.onChooseCb) this.onChooseCb(item.path || "");
  }
}

class StartFromSuggestModal extends FuzzySuggestModal {
  constructor(app, paths, onChoose) {
    super(app);
    this.paths = paths || [];
    this.onChooseCb = onChoose;
    this.setPlaceholder("选择从哪一篇开始推送…");
  }
  getItems() { return this.paths; }
  getItemText(path) { return path; }
  onChooseItem(path) {
    if (this.onChooseCb) this.onChooseCb(path);
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
    const close = acts.createEl("button", { text: "取消" });
    close.style.marginLeft = "8px";
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
    this._timer = window.setInterval(() => {
      try { this.refreshProgress(); } catch (e) { /* ignore */ }
    }, 400);
  }
  onClose() {
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
    if (!job || job.status === "idle" || job.status === "done") {
      box.createEl("p", { text: "当前没有进行中的推送任务" });
    } else {
      const total = Math.max(1, (job.paths || []).length);
      const cur = job.phase === "wikilinks" ? (job.wikiCursor || 0) : (job.cursor || 0);
      const shown = Math.min(cur, total);
      const pct = Math.min(100, Math.round((shown / total) * 100));
      const phaseText = job.phase === "wikilinks" ? "写入双链" : "上传文档";
      const statusText = job.status === "paused" ? "已暂停 ⏸" : (job.status === "running" ? "进行中 ▶️" : job.status);
      box.createEl("p", { text: `状态：${statusText} · ${job.label || ""}` });
      box.createEl("p", { text: `进度：${phaseText} ${shown}/${total}（${pct}%）` });

      const bar = box.createDiv({ cls: "si-push-progress-bar" });
      const fill = bar.createDiv({ cls: "si-push-progress-fill" });
      fill.style.width = pct + "%";

      if (job.paths && job.paths[Math.min(shown, total - 1)]) {
        box.createEl("p", {
          cls: "si-push-doc-preview",
          text: (job.status === "running" ? "正在处理：" : "当前/下一篇：") + job.paths[Math.min(shown, total - 1)],
        });
      }
      box.createEl("p", {
        text: `本轮 ✅${(job.results && job.results.synced) || 0}  ❌${(job.results && job.results.failed) || 0}` +
          ((job.results && job.results.assets) ? `  🖼️${job.results.assets}` : ""),
      });
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
      }).open();
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
      new StartFromSuggestModal(this.app, paths, (path) => this.plugin.restartPushFrom(path)).open();
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
    mkBtn(more, "测试思源连接").onclick = () => this.plugin.testConnection();

    const close = contentEl.createEl("button", { text: "关闭" });
    close.style.cssText = "display:block;margin:16px auto 0";
    close.onclick = () => this.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 搜索拉回弹窗
// ═══════════════════════════════════════════════════════════════════
class SearchPullModal extends Modal {
  constructor(app, api, nb) { super(app); this.api = api; this.nb = nb; this.result = null; this._resolve = null; }
  onOpen() {
    this.modalEl.addClass("si-push-wide-modal");
    const { contentEl } = this;
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "🔍 搜索思源文档并拉回 Obsidian" });
    const inp = contentEl.createEl("input", { type: "text", placeholder: "关键词搜索（留空列全部已关联）" });
    Object.assign(inp.style, { width:"100%", margin:"8px 0", padding:"8px" });
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
          li.createEl("div", { text: (b.content||"").substring(0,60), cls: "si-push-doc-preview" });
          li.onclick = () => { this.result = b; this.close(); };
        }
      } catch(e) { box.empty(); box.createEl("div", { text: "失败: " + e.message, cls: "si-push-error" }); }
    };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
    inp.focus();
  }
  onClose() { this.contentEl.empty(); if (this._resolve) this._resolve(this.result); }
  openAndGetResult() { return new Promise(r => { this._resolve = r; this.open(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// 主插件
// ═══════════════════════════════════════════════════════════════════
/** 思源默认不允许超过 7 层文档；超深路径压平，避免 createDocWithMd 失败 */
/** 思源在第 7 层文档下不能再建子文档；默认按 6 层压平更稳妥 */
const SIYUAN_MAX_DOC_DEPTH = 7;
const SIYUAN_SAFE_DOC_DEPTH = 6;

function buildPath(defaultPath, fileOrTitle, preserveFolder, maxDepth) {
  const prefix = (defaultPath || "/Obsidian/").replace(/\/+$/, "");
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
        // 保留靠前的目录，把多出来的路径段合并进最后一层文档名
        const keep = Math.max(0, maxParts - 1);
        const head = parts.slice(0, keep);
        const leaf = safeTitle(parts.slice(keep).join("__"));
        parts = head.concat(leaf);
        console.log("[SiPush] 路径超深已压平:", fileOrTitle.path, "→", prefix + "/" + parts.join("/"));
      }
      return prefix + "/" + parts.join("/");
    }
    return prefix + "/" + safeTitle(fileOrTitle.basename);
  }
  return prefix + "/" + safeTitle(String(fileOrTitle || "untitled"));
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
      callback: () => new FolderSuggestModal(this.app, (p) => this.pushFolder(p)).open() });
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

    this.addSettingTab(new SiPushSettingTab(this.app, this));
    this.migrateFailedQueueFromHistory();
    // 上次异常退出时若任务停在 running，改为 paused，方便继续
    if (this.settings.pushJob && this.settings.pushJob.status === "running") {
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

  refreshStatusBar() {
    const job = this.settings.pushJob;
    if (job && (job.status === "running" || job.status === "paused")) {
      const total = (job.paths || []).length;
      const cur = job.phase === "wikilinks" ? (job.wikiCursor || 0) : (job.cursor || 0);
      const tag = job.status === "paused" ? "已暂停" : (job.phase === "wikilinks" ? "双链" : "上传");
      this.setStatusBarText(`${tag} ${Math.min(cur, total)}/${total}`);
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

  openPushControl() {
    if (this._controlModal) {
      try { this._controlModal.refreshProgress(); } catch (e) { /* ignore */ }
      return;
    }
    new PushControlModal(this.app, this).open();
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
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId);
    const doc = await m.openAndGetResult();
    if (!doc) { new Notice("已取消"); return; }
    let md = content; if (!this.settings.pushFrontmatter) md = stripFM(md);
    new Notice("正在追加...");
    try { await this.api.appendToDoc(doc.id, md.trim()); new Notice("✅ 追加成功！"); }
    catch(e) { new Notice("❌ 追加失败: " + e.message, 6000); }
  }

  /** 第二遍：按已收集的思源文档 ID，把 [[笔记]] 写成 ((id "锚文本")) */
  async rewriteVaultWikilinks(files) {
    if (this.settings.rewriteWikilinks === false) return 0;
    await this.ensureSiDocMap(files);
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
    new StartFromSuggestModal(this.app, paths, (path) => this.restartPushFrom(path)).open();
  }

  async startPushJob({ paths, label, startPath }) {
    if (!this.ensureConfigured()) return;
    if (!paths || !paths.length) { new Notice("没有可推送的笔记"); return; }

    if (this._jobLoopRunning) {
      // 正在跑：登记为暂停后重启，避免直接开新任务失败
      this._pendingRestart = { paths, label, startPath };
      this._pauseRequested = true;
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
      results: { synced: 0, failed: 0, conflicts: 0, deleted: 0, skipped: 0, assets: 0, details: [] },
      createdAt: utcSec(),
      updatedAt: utcSec(),
    };
    this._pauseRequested = false;
    this._pendingRestart = null;
    await this.saveSettings();
    this.refreshStatusBar();
    // 打开/聚焦控制台，便于实时跟进进度
    this.openPushControl();
    new Notice(`开始${label || "推送"}：共 ${paths.length} 篇` + (startPath ? `（从 ${startPath} 起）` : ""), 5000);
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
    if (job.status === "running" && this._jobLoopRunning) {
      new Notice("推送已在进行中");
      return;
    }
    if (!this.ensureConfigured()) return;
    job.status = "running";
    job.updatedAt = utcSec();
    this._pauseRequested = false;
    await this.saveSettings();
    this.refreshStatusBar();
    this.openPushControl();
    new Notice(`继续推送：${job.phase === "wikilinks" ? "双链" : "上传"} ${job.phase === "wikilinks" ? job.wikiCursor : job.cursor}/${job.paths.length}`);
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
    if (job) {
      job.status = "idle";
      job.updatedAt = utcSec();
      await this.saveSettings();
    }
    this.isSyncing = false;
    this.refreshStatusBar();
    new Notice("已取消推送任务（已完成的不会回滚）");
  }

  async runPushJobLoop() {
    if (this._jobLoopRunning) return;
    const job = this.settings.pushJob;
    if (!job || job.status !== "running") return;

    this._jobLoopRunning = true;
    this.isSyncing = true;
    if (!this._assetCache) this._assetCache = new Map();
    if (!this._siDocMap) this._siDocMap = { byPath: new Map(), byName: new Map() };

    // 从「双链阶段」恢复时，必须先重建文档 ID 映射
    if (job.phase === "wikilinks" && this.settings.rewriteWikilinks !== false) {
      const mapFiles = job.paths
        .map(p => this.app.vault.getAbstractFileByPath(p))
        .filter(f => f instanceof TFile);
      await this.ensureSiDocMap(mapFiles);
    }

    try {
      // 阶段 1：上传
      while (job.status === "running" && job.phase === "upload" && job.cursor < job.paths.length) {
        if (this._pauseRequested) {
          job.status = "paused";
          job.updatedAt = utcSec();
          await this.saveSettings();
          this.refreshStatusBar();
          new Notice(`已暂停：上传 ${job.cursor}/${job.paths.length}`);
          break;
        }

        const filePath = job.paths[job.cursor];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        this.setStatusBarText(`上传 ${job.cursor + 1}/${job.paths.length}`);

        try {
          if (!(file instanceof TFile)) throw new Error("文件不存在");
          const pushId = await this.getOrCreatePushId(file);
          let md = await this.app.vault.read(file);
          if (!this.settings.pushFrontmatter) md = stripFM(md);
          const prepared = await this.prepareMarkdownForPush(file, md, { skipWikilinks: true });
          job.results.assets += prepared.assetCount || 0;
          const siPath = pluginBuildPath(this, file);
          const docId = await this.pushToSiYuan(file, siPath, prepared.md, pushId, file.basename, { quiet: true, prepared: true });
          if (docId) this.registerSiDoc(file, docId);
          job.results.synced++;
          job.results.details.push({
            title: file.path,
            status: "success",
            direction: "已推送" + (prepared.assetCount ? ` (资源 ${prepared.assetCount})` : ""),
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
          // 双链前先建立「全部任务文件 → 思源 ID」映射，否则同批互链会失败
          const mapFiles = job.paths
            .map(p => this.app.vault.getAbstractFileByPath(p))
            .filter(f => f instanceof TFile);
          await this.ensureSiDocMap(mapFiles);
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
          new Notice(`已暂停：双链 ${job.wikiCursor}/${job.paths.length}`);
          break;
        }

        const filePath = job.paths[job.wikiCursor];
        const file = this.app.vault.getAbstractFileByPath(filePath);
        this.setStatusBarText(`双链 ${job.wikiCursor + 1}/${job.paths.length}`);
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
        if (job.wikiCursor % 10 === 0) await this.saveSettings();
      }

      if (
        job.status === "running" &&
        (job.phase === "done" ||
          (job.phase === "wikilinks" && (this.settings.rewriteWikilinks === false || job.wikiCursor >= job.paths.length)))
      ) {
        job.phase = "done";
        job.status = "done";
        job.updatedAt = utcSec();
        await this.saveSettings();
        await this.logSyncHistory(job.results);
        this.refreshStatusBar();
        new SyncReportModal(this.app, job.results, this).open();
        new Notice(`推送完成：✅ ${job.results.synced} / ❌ ${job.results.failed}`, 6000);
      }
    } finally {
      this._jobLoopRunning = false;
      this.isSyncing = false;
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
    if (this.settings.syncAssets !== false) {
      const r = await this.rewriteAndUploadAssets(sourceFile, out);
      out = r.md;
      assetCount = r.count;
    }
    // 第一遍建文档时可跳过双链；第二遍再用文档 ID 写成 ((id "锚文本"))
    if (!opts.skipWikilinks && this.settings.rewriteWikilinks !== false) {
      out = this.rewriteWikilinks(sourceFile, out);
    }
    return { md: out, assetCount };
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
    for (const file of list) {
      if (this._siDocMap.byPath.has(file.path)) continue;
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
    for (const p of tryPaths) {
      const resolved = this.app.metadataCache.getFirstLinkpathDest(p, sourceFile.path);
      if (resolved instanceof TFile) return resolved;
      const byPath = this.app.vault.getAbstractFileByPath(p);
      if (byPath instanceof TFile) return byPath;
    }
    return null;
  }

  async uploadVaultFile(file) {
    if (!this._assetCache) this._assetCache = new Map();
    if (this._assetCache.has(file.path)) return this._assetCache.get(file.path);
    const data = await this.app.vault.readBinary(file);
    // 带上 MIME，避免部分环境下音视频被当成无名二进制后无法播放
    const mime = guessAssetMime(file.extension);
    const blob = mime ? new Blob([data], { type: mime }) : new Blob([data]);
    const uploadName = uniqueAssetName(file);
    const assetsDir = resolveAssetsDirPath(this.settings.assetsDirPath);
    const assetPath = await this.api.uploadAsset(blob, uploadName, assetsDir);
    if (!assetPath) throw new Error("资源上传无返回路径: " + file.path);
    this._assetCache.set(file.path, assetPath);
    return assetPath;
  }

  async rewriteAndUploadAssets(sourceFile, md) {
    let count = 0;
    let out = md;

    // 1) ![[任意附件]] — 嵌入：图片 / PDF / 音频 / 视频 / 文档 全部上传
    const embedRe = /!\[\[([^\]]+)\]\]/g;
    const embeds = [...out.matchAll(embedRe)];
    for (const m of embeds) {
      const raw = m[1];
      const { path: linkPath, alias } = parseWikiTarget(raw);
      const file = this.resolveVaultFile(sourceFile, linkPath);
      if (!file || !isAssetFile(file)) continue;
      try {
        const assetPath = await this.uploadVaultFile(file);
        count++;
        out = out.split(m[0]).join(formatAssetMarkdown(file, assetPath, alias));
      } catch (e) {
        console.warn("[SiPush] 嵌入资源上传失败:", file.path, e.message);
      }
    }

    // 2) [[附件.ext]] — 无 ! 的资源双链（非 md）也必须上传，否则思源打不开
    const wikiAssetRe = /(?<!!)\[\[([^\]]+)\]\]/g;
    const wikiAssets = [...out.matchAll(wikiAssetRe)];
    for (const m of wikiAssets) {
      const raw = m[1];
      const { path: linkPath, alias } = parseWikiTarget(raw);
      // 看起来像带扩展名的附件，或能解析到非 md 文件
      const file = this.resolveVaultFile(sourceFile, linkPath);
      if (!file || !isAssetFile(file)) continue;
      try {
        const assetPath = await this.uploadVaultFile(file);
        count++;
        out = out.split(m[0]).join(formatAssetMarkdown(file, assetPath, alias));
      } catch (e) {
        console.warn("[SiPush] 附件双链上传失败:", file.path, e.message);
      }
    }

    // 3) ![alt](本地路径) — Markdown 内联媒体
    const mdImgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const imgs = [...out.matchAll(mdImgRe)];
    for (const m of imgs) {
      const alt = m[1] || "";
      const link = decodeUriPath(m[2].replace(/^<|>$/g, ""));
      if (isRemoteUrl(link) || shouldReuseAssetLink(link)) continue;
      const file = this.resolveVaultFile(sourceFile, link);
      if (!file || !isAssetFile(file)) continue;
      try {
        const assetPath = await this.uploadVaultFile(file);
        count++;
        out = out.split(m[0]).join(formatAssetMarkdown(file, assetPath, alt || null));
      } catch (e) {
        console.warn("[SiPush] Markdown 资源上传失败:", file.path, e.message);
      }
    }

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
      try {
        const assetPath = await this.uploadVaultFile(file);
        count++;
        out = out.split(m[0]).join(formatAssetMarkdown(file, assetPath, text || null));
      } catch (e) {
        console.warn("[SiPush] 附件上传失败:", file.path, e.message);
      }
    }

    return { md: out, count };
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
    try { siDoc = await this.api.findDoc(pushId); }
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
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId);
    const doc = await m.openAndGetResult();
    if (!doc) { new Notice("已取消"); return; }
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

  // ── 获取或生成 pushId：写在文末极小字，一次写盘清掉顶部 frontmatter ──
  async getOrCreatePushId(file) {
    let content = "";
    try { content = await this.app.vault.read(file); } catch (e) { content = ""; }
    const { id, md, changed } = applyPushIdFooterMigration(content, { createIfMissing: true });
    if (changed) {
      await this.app.vault.modify(file, md);
    }
    return id;
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
    let existingDoc = null;
    try { existingDoc = await this.api.findDoc(pushId); } catch(e) {}

    if (existingDoc) {
      try {
        await this.api.updateDoc(existingDoc.id, finalMd);
        await this.api.setSyncInfo(existingDoc.id, hash, mtime);
        await this.api.setAttrs(existingDoc.id, { "custom-si-push-id": pushId, title: title });
        if (file) this.registerSiDoc(file, existingDoc.id);
        if (!opts.quiet) new Notice("📤 → 思源 ✅ 推送更新成功!");
        return existingDoc.id;
      } catch(e) {
        if (!opts.quiet) new Notice("❌ 更新失败: " + e.message, 6000);
        throw e;
      }
    } else {
      try {
        const res = await this.api.createDoc(this.settings.defaultNotebookId, path, finalMd);
        const docId = typeof res === "string" ? res : (res && (res.id || res.rootID)) || res;
        await this.api.setSyncInfo(docId, hash, mtime);
        await this.api.setAttrs(docId, { "custom-si-push-id": pushId, title: title });
        if (file) this.registerSiDoc(file, docId);
        if (!opts.quiet) new Notice("📤 → 思源 ✅ 推送新建成功!");
        return docId;
      } catch(e) {
        if (!opts.quiet) new Notice("❌ 推送失败: " + e.message, 6000);
        throw e;
      }
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
    if (this.isSyncing) { new Notice("同步进行中..."); return; }
    if (!this.ensureConfigured()) return;
    const queue = [...(this.settings.failedQueue || [])];
    if (!queue.length) { new Notice("失败队列为空，无需重试"); return; }

    this.isSyncing = true;
    this._assetCache = new Map();
    this._siDocMap = { byPath: new Map(), byName: new Map() };
    this.setStatusBarText("重试失败项…");
    new Notice(`正在重试 ${queue.length} 篇失败笔记…`, 4000);

    const results = { synced: 0, failed: 0, conflicts: 0, deleted: 0, skipped: 0, assets: 0, details: [] };

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const file = this.app.vault.getAbstractFileByPath(item.path);
      try {
        this.setStatusBarText(`重试 ${i + 1}/${queue.length}`);
        if (!(file instanceof TFile)) {
          results.failed++;
          results.details.push({ title: item.path, status: "error", direction: "异常", detail: "文件已不存在" });
          continue;
        }
        const pushId = await this.getOrCreatePushId(file);
        let md = await this.app.vault.read(file);
        if (!this.settings.pushFrontmatter) md = stripFM(md);
        const prepared = await this.prepareMarkdownForPush(file, md, { skipWikilinks: true });
        results.assets += prepared.assetCount || 0;
        const path = pluginBuildPath(this, file);
        const docId = await this.pushToSiYuan(file, path, prepared.md, pushId, file.basename, { quiet: true, prepared: true });
        if (docId) this.registerSiDoc(file, docId);
        results.synced++;
        results.details.push({ title: file.path, status: "success", direction: "重试成功" });
      } catch (e) {
        results.failed++;
        results.details.push({
          title: item.path,
          status: "error",
          direction: "异常",
          detail: (e.message || String(e)).substring(0, 120),
        });
        // 增加重试计数
        const q = this.settings.failedQueue || [];
        const hit = q.find(x => x.path === item.path);
        if (hit) hit.retries = (hit.retries || 0) + 1;
      }
    }

    // 重试成功后再补双链
    const okFiles = results.details
      .filter(d => d.status === "success")
      .map(d => this.app.vault.getAbstractFileByPath(d.title))
      .filter(f => f instanceof TFile);
    if (okFiles.length && this.settings.rewriteWikilinks !== false) {
      await this.rewriteVaultWikilinks(okFiles);
    }

    this.isSyncing = false;
    this._assetCache = null;
    this._siDocMap = null;
    await this.logSyncHistory(results);
    this.refreshStatusBar();
    new SyncReportModal(this.app, results, this).open();
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
    new Setting(containerEl).setName("默认路径前缀").setDesc("思源中文档的存放路径")
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
      .setDesc("推送时尽量按 Obsidian 相对路径建文档；超过思源最大深度时自动压平")
      .addToggle(t => t.setValue(this.plugin.settings.preserveFolderStructure !== false)
        .onChange(async v => { this.plugin.settings.preserveFolderStructure = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("思源文档最大深度")
      .setDesc("建议 ≤6。思源在第 7 层下不能再建子文档；超深路径会自动压平")
      .addText(t => t.setPlaceholder("6").setValue(String(this.plugin.settings.maxDocDepth || 6))
        .onChange(async v => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxDocDepth = Number.isFinite(n) && n > 0 ? Math.min(n, 7) : 6;
          await this.plugin.saveSettings();
        }));

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
      .setDesc("图片、PDF、音视频、Office、压缩包(zip/rar/7z…)等本地引用一律上传到思源 assets")
      .addToggle(t => t.setValue(this.plugin.settings.syncAssets !== false)
        .onChange(async v => { this.plugin.settings.syncAssets = v; await this.plugin.saveSettings(); }));

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
