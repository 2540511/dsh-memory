/**
 * 长记忆插件 · 宿主半。
 *
 * 路由（全部同源校验）：
 * - GET  /memory/api/state     探测 + 记忆目录概览
 * - GET  /memory/api/sessions  可保存会话列表（按最后活动倒序）
 * - GET  /memory/api/preview   保存前的目标文件名预览
 * - POST /memory/api/save      保存一个会话为独立记忆文件
 *
 * 通道设计：`webServer.register({kind:'exact'})` 的精确路由优先级高于
 * `/api` 前缀栅栏，所以必须自己做同源校验。规则照搬 dsh-market 的
 * lib/http.js：Host 必须是 loopback，Origin 若存在必须与 Host 一致，
 * `sec-fetch-site: cross-site` 直接拒绝。
 */
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import { isoSeconds, fileStamp, resolveTimeZone } from './src/time.js';
import {
  DEFAULT_CONFIG,
  allocateName,
  ensureRoot,
  INDEX_FILE,
  isExistsError,
  listMemoryFiles,
  listMemoryFolders,
  sanitizeFolderName,
  loadConfig,
  resolveMemoryRoot,
  saveConfig,
  systemPath,
  SYSTEM_DIR,
} from './src/store.js';
import { parseMemoryFile, serializeMemoryFile, setEntryBody, setEntryField } from './src/format.js';
import { extractDigest } from './src/extract.js';
import { extractMessages, summarizeEvents } from './src/sessions.js';
import { searchEntries } from './src/search.js';
import { buildLongTermEntries, extractLongTerm, findConflicts, markPending } from './src/longterm.js';
import { applyResolution, readConflict } from './src/conflicts.js';
import {
  MAX_PROPOSALS,
  buildProposalEntries,
  buildProposalFileText,
  validateProposal,
} from './src/proposals.js';
import { applyDescription, buildMediaEntries, extractMediaFromEvents } from './src/media.js';
import { findDuplicates } from './src/dedupe.js';
import { buildStartupIndex, computeWeight, purgeDetail, shouldPurge } from './src/weight.js';
import { estimateTokens } from './src/format.js';
import { buildDiffEntries, buildWorkEntries, buildWorkFileText, packVolumes } from './src/workmem.js';
import {
  AUDIT_FILE,
  buildExportDocument,
  buildImportFileText,
  fingerprint,
  planImport,
  renderAuditEntry,
  selectEntries,
} from './src/portability.js';
import { buildMemoryFileText, PURGE_HEADING } from './src/compose.js';
import { buildPrompt, promptFileName } from './src/prompt.js';

/** 删除先移到这里，不直接抹掉 */
const TRASH_DIR = '_回收站';

const VERSION = '0.1.0';
const SESSION_LIMIT = 25;

function loopbackAuthority(host) {
  if (host === undefined) return false;
  const lower = String(host).toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function sameOrigin(request) {
  const host = request.headers.host;
  if (host !== undefined && !loopbackAuthority(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, maxBytes = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createFsPort(ctx, workspace) {
  const resolve = (path) => ctx.fs.resolve(path);
  const policy = { mode: 'workspace-write', workspaceRoot: workspace };
  return {
    async stat(path) {
      try {
        const info = await nodeFs.stat(path);
        const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
        return { type, size: info.size };
      } catch {
        return undefined;
      }
    },
    async readText(path) {
      return ctx.fs.readText(await resolve(path));
    },
    async listDir(path) {
      const list = await ctx.fs.listDir(await resolve(path));
      return list.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size }));
    },
    async writeText(path, content, intent) {
      await ctx.fs.writeText(await resolve(path), content, intent, undefined, policy);
    },
    async mkdir(path) {
      await nodeFs.mkdir(path, { recursive: true });
    },
  };
}

/** 可选工作区列表（注册表优先，退回到工作目录） */
function listWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const out = [];
  if (registry) {
    try {
      for (const item of registry.list() || []) {
        if (item && item.path) out.push({ path: item.path, title: item.title || item.path });
      }
    } catch {
      // 忽略，退回下一级
    }
  }
  if (out.length === 0) {
    const workingDirectory = ctx.get('workingDirectory');
    const path = (workingDirectory && workingDirectory.defaultDirectory) || process.cwd();
    out.push({ path, title: path });
  }
  return out;
}

function resolveWorkspace(ctx) {
  const list = listWorkspaces(ctx);
  return list[0].path;
}

/**
 * 解析出记忆根目录 + 配置。
 *
 * 记忆库的选择是"两段式"：
 * 1. 指针配置里的 `active_workspace` 决定当前用哪个工作区的记忆库；
 * 2. 该记忆库自己的 `memory_root` 可以再指向任意绝对路径。
 *
 * 指针配置**不能**假设"第一个工作区"稳定：重启后顺序可能变，会把记忆库切丢。
 * 所以这里扫描所有工作区，谁的 _config.md 写了 active_workspace 就以谁为准。
 */
/**
 * 把旧版放在记忆根目录的三个系统文件挪进 _系统/。
 * 幂等：目标已存在或源不存在就跳过。
 */
async function migrateSystemFiles(port, root) {
  try {
    await port.mkdir(`${root}/${SYSTEM_DIR}`);
    for (const name of ['_config.md', '_index.md', '_audit.md']) {
      const from = `${root}/${name}`;
      const to = systemPath(root, name);
      if (!(await port.stat(from))) continue;

      if (await port.stat(to)) {
        // 两边都在：旧文件是用户真实配置，优先保留；旧文件另存备份
        if (name === '_config.md') {
          await port.writeText(to, await port.readText(from));
        }
        await nodeFs.rename(from, systemPath(root, `_legacy${name}`));
        continue;
      }
      await nodeFs.rename(from, to);
    }
  } catch {
    // 迁移失败不影响主流程
  }
}

/**
 * A5 隐私分级：默认 device_local；命中敏感词升到 private，命中口令类升到 secret。
 * 只写字段，不改变存储位置（全部仍然只在本机工作区）。
 */
const SECRET_HINTS = /(密码|口令|密钥|api[ _-]?key|token|secret|私钥|身份证|银行卡)/i;
const PRIVATE_HINTS = /(手机号|邮箱|住址|家庭|工资|薪资|病历|隐私|权限)/i;

function gradePrivacy(text) {
  const value = String(text || '');
  if (SECRET_HINTS.test(value)) return 'secret';
  if (PRIVATE_HINTS.test(value)) return 'private';
  return 'device_local';
}

async function openMemory(ctx) {
  const workspaces = listWorkspaces(ctx);
  const timezone = resolveTimeZone();

  // 先把旧版散落在根目录的系统文件迁进 _系统/，再读配置
  for (const ws of workspaces) {
    const wsPort = createFsPort(ctx, ws.path);
    await migrateSystemFiles(wsPort, resolveMemoryRoot({ configured: '', workspace: ws.path }));
  }

  let pointer = null;
  for (const ws of workspaces) {
    const port = createFsPort(ctx, ws.path);
    const root = resolveMemoryRoot({ configured: '', workspace: ws.path });
    const cfg = await loadConfig(port, root);
    if (!pointer) pointer = { workspace: ws.path, port, root, config: cfg };
    if (cfg.values.active_workspace) {
      pointer = { workspace: ws.path, port, root, config: cfg };
      break;
    }
  }

  const chosen = workspaces.find((item) => item.path === pointer.config.values.active_workspace);
  const workspace = chosen ? chosen.path : pointer.workspace;

  const port = createFsPort(ctx, workspace);
  let root = resolveMemoryRoot({ configured: pointer.config.values.memory_root, workspace });
  let config = root === pointer.root ? pointer.config : await loadConfig(port, root);

  let configCreated = false;
  await ensureRoot(port, root);
  if (!config.exists) {
    await saveConfig(port, root, config.values);
    config = await loadConfig(port, root);
    configCreated = true;
  }

  return {
    workspace,
    workspaces,
    port,
    timezone,
    root,
    config,
    configCreated,
    pointer: { port: pointer.port, root: pointer.root, config: pointer.config },
  };
}

/**
 * 读最近一条**聊天**记忆里的要点行，作为本次摘要的承接。
 * 工作记忆文件里没有 session_digest 条目，必须跳过，否则链会断在它身上。
 */
async function loadCarried(port, root) {
  const files = await listMemoryFiles(port, root);
  for (const file of files.slice(0, 10)) {
    try {
      const doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
      const digest = doc.entries.find((entry) => entry.fieldMap.type === 'session_digest');
      if (!digest) continue;
      const carried = [];
      let inPoints = false;
      for (const line of digest.bodyLines) {
        if (/^要点[:：]/.test(line)) { inPoints = true; continue; }
        if (inPoints) {
          if (/^###\s/.test(line) || /^>[ \t]*\[!/.test(line) || line.trim() === '') break;
          const match = /^-\s*\[[^\]]+\]\s*(.+)$/.exec(line);
          if (match) carried.push(match[1].trim());
        }
      }
      return { carried: carried.slice(0, 8), from: digest.id };
    } catch {
      continue;
    }
  }
  return { carried: [], from: null };
}

/**
 * 从磁盘枚举会话 ID：DSH 把每个会话存成
 *   ~/.dsh/sessions/--<工作区路径转义>--/session-<uuid>/session.v4.jsonl.zstd
 * 这里只取目录名（ID），标题与消息数仍走按 ID 的接口。
 */
async function listSessionIdsFromDisk(workspace) {
  const homes = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : '',
    (() => { try { return os.homedir(); } catch { return ''; } })(),
  ].filter(Boolean);

  if (homes.length === 0) {
    debugLog('disk-sessions', new Error('找不到 home 目录'));
    return [];
  }

  const escaped = String(workspace).replace(/:/g, '').replace(/[\\/]/g, '-');
  const errors = [];
  for (const home of homes) {
    const dir = `${home}/.dsh/sessions/--${escaped}--`;
    try {
      const entries = await nodeFs.readdir(dir, { withFileTypes: true });
      const ids = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => entry.name);
      if (ids.length > 0) return ids;
      errors.push(`${dir}: 空`);
    } catch (error) {
      errors.push(`${dir}: ${String((error && error.message) || error)}`);
    }
  }
  debugLog('disk-sessions', new Error(errors.join(' | ')));
  return [];
}

async function listSessions(ctx, timezone) {
  const query = ctx.sessionQuery;

  const normalize = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;
    if (raw && Array.isArray(raw.sessions)) return raw.sessions;
    return [];
  };

  // 依次尝试三种取法：列表 → 过滤（空条件＝全部）→ 检索（空词）
  let records = [];
  for (const attempt of [
    async () => normalize(await query.listSessions()),
    async () => normalize(await query.filterSessions([])),
    async () => normalize((await query.searchSessions({ query: '', limit: SESSION_LIMIT })).items),
  ]) {
    try {
      const found = await attempt();
      if (found.length > 0) { records = found.slice(0, SESSION_LIMIT); break; }
    } catch {
      // 换下一种
    }
  }

  // 服务层取不到时直接从磁盘枚举 ID
  if (records.length === 0) {
    for (const ws of listWorkspaces(ctx)) {
      const ids = await listSessionIdsFromDisk(ws.path);
      for (const id of ids) records.push({ header: { id, createdAt: Date.now() }, live: false, persisted: true });
    }
    records = records.slice(0, SESSION_LIMIT);
  }
  if (records.length === 0) return { sessions: [], truncated: false, total: 0 };

  const ids = records.map((record) => record.header.id);
  let titles = new Map();
  try {
    const observations = await query.readTitleSnapshots(ids);
    titles = new Map(observations.map((item) => [
      item.sessionId,
      item.status === 'fulfilled' && item.value.title ? item.value.title.title : null,
    ]));
  } catch {
    titles = new Map();
  }

  const sessions = [];
  for (const record of records) {
    const id = record.header.id;
    let summary = { messageCount: 0, startTime: null, endTime: null };
    try {
      summary = summarizeEvents(await query.listEvents(id));
    } catch {
      // 单个会话读取失败不影响列表
    }
    sessions.push({
      sessionId: id,
      title: titles.get(id) || `会话 ${String(id).slice(0, 8)}`,
      messageCount: summary.messageCount,
      createdAt: isoSeconds(new Date(record.header.createdAt), timezone),
      startsAt: summary.startTime ? isoSeconds(new Date(summary.startTime), timezone) : null,
      endsAt: summary.endTime ? isoSeconds(new Date(summary.endTime), timezone) : null,
      live: Boolean(record.live),
      lastActivityMs: summary.endTime || record.header.createdAt,
    });
  }

  sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return { sessions, truncated: records.length > SESSION_LIMIT, total: records.length };
}

async function findSession(ctx, sessionId) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId);
  return snapshot;
}

function toIso(timezone) {
  return (ms) => isoSeconds(new Date(ms), timezone);
}

/** 同一会话已有的 current 摘要（用于 supersede） */
async function findPreviousDigests(port, root, sessionId) {
  const files = await listMemoryFiles(port, root);
  const found = [];
  for (const file of files.slice(0, 30)) {
    let doc;
    try {
      doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
    } catch {
      continue;
    }
    for (const entry of doc.entries) {
      if (entry.fieldMap.type !== 'session_digest') continue;
      if (entry.fieldMap.session_id !== sessionId) continue;
      if (entry.fieldMap.status !== 'current') continue;
      found.push({ file: file.name, id: entry.id });
    }
  }
  return found;
}

/**
 * 把旧摘要标成 superseded 并写回双向链接。
 * 先写新文件、后改旧文件：如果这一步失败，新记忆仍然有效，只在响应里告警。
 */
async function markSuperseded(port, root, previous, newId, at) {
  const byFile = new Map();
  for (const item of previous) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item.id);
  }

  const updated = [];
  for (const [file, ids] of byFile) {
    const path = `${root}/${file}`;
    const doc = parseMemoryFile(await port.readText(path));
    let changed = false;
    for (const entry of doc.entries) {
      if (!ids.includes(entry.id)) continue;
      setEntryField(entry, 'status', 'superseded');
      setEntryField(entry, 'superseded_by', newId);
      setEntryField(entry, 'updated_at', at);
      setEntryBody(entry, [
        ...entry.bodyLines,
        '',
        `> [!superseded] 被 ${newId} 取代于 ${at}；原文与时间戳保留，可用 superseded_by 追回。`,
      ]);
      changed = true;
    }
    if (changed) {
      await port.writeText(path, serializeMemoryFile(doc));
      updated.push(file);
    }
  }
  return updated;
}

/** 统计待确认冲突与被替代条目 */
async function collectConflictStats(port, root, files) {
  let pending = 0;
  let superseded = 0;
  let conflictBlocks = 0;
  for (const file of files.slice(0, 50)) {
    let doc;
    try {
      doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
    } catch {
      continue;
    }
    for (const entry of doc.entries) {
      if (entry.fieldMap.status === 'pending') pending += 1;
      if (entry.fieldMap.status === 'superseded') superseded += 1;
      conflictBlocks += (entry.blocks || []).filter((block) => block.tag === 'conflict').length;
    }
  }
  return { pending, superseded, conflictBlocks };
}

/** 读出全部条目（导入去重、导出筛选都用它） */
async function readAllDocs(port, root) {
  const files = (await listMemoryFiles(port, root)).slice(0, 200);
  const docs = [];
  for (const file of files) {
    try {
      const doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
      for (const entry of doc.entries) docs.push({ file: file.name, entry });
    } catch {
      // 单个文件坏了不影响其余
    }
  }
  return { files, docs };
}

/** 追加一条审计流水（整份文件原子重写） */
async function appendAudit(port, root, input) {
  const path = systemPath(root, AUDIT_FILE);
  let existing = '# 审计流水\n\n';
  if (await port.stat(path)) {
    try {
      existing = await port.readText(path);
    } catch {
      existing = '# 审计流水\n\n';
    }
  }
  const text = `${existing.replace(/\s*$/, '\n\n')}${renderAuditEntry(input)}`;
  await port.mkdir(`${root}/${SYSTEM_DIR}`);
  await port.writeText(path, text);
}

/** 在指定文件里改一个条目并原子写回 */
/** 一次检索命中 = 一次访问：+10 权重（单条封顶 20），并记录 last_accessed_at */
async function applyAccessBoost(port, root, hits, savedAt) {
  let changed = 0;
  const nowMs = Date.now();

  for (const hit of hits) {
    if (!hit || !hit.file || !hit.id) continue;
    if (hit.type === 'work_record' || hit.type === 'work_diff') continue;

    try {
      let skipped = false;
      await updateEntryInFile(port, root, hit.file, hit.id, (entry) => {
        const fieldMap = entry.fieldMap || {};
        const last = fieldMap.last_accessed_at ? Date.parse(fieldMap.last_accessed_at) : 0;
        // 一小时内重复检索不重复加权
        if (last && nowMs - last < 3600 * 1000) { skipped = true; return; }
        const boost = Math.min(20, (Number(fieldMap.weight_boost) || 0) + 10);
        const base = Number(fieldMap.weight_base) || (fieldMap.type === 'long_term' ? 100 : 60);
        const decay = Number(fieldMap.weight_decay) || 1;
        const weight = Math.max(0, Math.min(100, Math.round(base * decay + boost)));
        setEntryField(entry, 'weight_boost', String(boost));
        setEntryField(entry, 'weight', String(weight));
        setEntryField(entry, 'last_accessed_at', savedAt);
      });
      if (!skipped) changed += 1;
    } catch {
      // 单条失败不影响检索
    }
  }
  return changed;
}

/**
 * L2 阶段总结：把最近若干条 L1 摘要的「要点」压成一条 period_digest。
 * 只做聚合与去重，不引入新事实。
 */
function buildPeriodEntry({ items, savedAt, timezone, stamp, seq, chainFrom, chainLength }) {
  const points = [];
  const seen = new Set();
  for (const item of items) {
    for (const line of item.points) {
      const clean = line.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      points.push(clean);
    }
  }

  const fields = [
    ['type', 'period_digest'],
    ['digest_level', '2'],
    ['source_files', items.map((item) => item.id).join(',')],
    ['chain_from', chainFrom || ''],
    ['chain_length', String(chainLength || items.length)],
    ['session_id', items[0] && items[0].sessionId ? items[0].sessionId : ''],
    ['event_time', items[items.length - 1].eventTime || savedAt],
    ['recorded_at', savedAt],
    ['updated_at', savedAt],
    ['timezone', timezone],
    ['time_source', 'system_clock'],
    ['confidence', '0.7'],
    ['privacy', 'device_local'],
    ['status', 'current'],
    ['tags', 'period,digest'],
    ['seq', String(seq)],
    ['weight', '70'],
    ['weight_base', '70'],
    ['weight_decay', '1'],
    ['purge_after', savedAt],
    ['details_purged', 'false'],
  ];

  return {
    id: `PD-${String(stamp).replace('_', '-')}`,
    title: `阶段总结 · 汇总 ${items.length} 条会话`,
    fields,
    bodyLines: ['要点：', ...points.slice(0, 12).map((line) => `- ${line}`)],
  };
}

/** 从旧摘要文件里抠出「要点」行 */
function readDigestPoints(doc) {
  const entry = doc.entries.find((item) => item.fieldMap.type === 'session_digest');
  if (!entry) return { points: [], id: '', eventTime: '', sessionId: '' };
  const lines = entry.bodyLines;
  const start = lines.findIndex((line) => line.trim().startsWith('要点'));
  const points = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^#{2,4}\s/.test(line.trim())) break;
      if (line.trim().startsWith('-')) points.push(line.trim().replace(/^-[\s]*/, ''));
    }
  }
  return {
    points,
    id: entry.id,
    eventTime: entry.fieldMap.event_time || '',
    sessionId: entry.fieldMap.session_id || '',
  };
}

async function updateEntryInFile(port, root, file, id, mutate) {
  const path = `${root}/${file}`;
  const doc = parseMemoryFile(await port.readText(path));
  const entry = doc.entries.find((item) => item.id === id);
  if (!entry) return null;
  mutate(entry);
  entry.dirty = true;
  await port.writeText(path, serializeMemoryFile(doc));
  return entry;
}

/** 选一个所有分卷都没被占用的基名 */
async function allocateVolumeBase(port, root, stamp, count) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const base = attempt === 1 ? stamp : `${stamp}_${attempt}`;
    let free = true;
    for (let index = 0; index < count; index += 1) {
      const name = index === 0 ? `${base}.md` : `${base}_${index + 1}.md`;
      if (await port.stat(`${root}/${name}`)) { free = false; break; }
    }
    if (free) return base;
  }
  throw new Error('同名文件过多，保存失败');
}

/** 收集本会话的工作区变更；只取最近 10 次，总量封顶 400KB */
async function collectDiffs(hostCtx, sessionId, events) {
  const changes = hostCtx.get('workspaceChanges');
  if (!changes) return [];
  const seqs = (events || [])
    .filter((event) => event && event.type === 'workspace/changes')
    .slice(-10);
  if (seqs.length === 0) return [];

  const signal = new AbortController().signal;
  const diffs = [];
  let bytes = 0;

  for (const event of seqs) {
    let summary;
    try {
      summary = changes.summary(sessionId, event.seq);
    } catch {
      continue;
    }
    if (!summary || !Array.isArray(summary.files)) continue;

    for (let index = 0; index < summary.files.length; index += 1) {
      if (bytes > 400 * 1024) break;
      const file = summary.files[index];
      let diff;
      try {
        diff = await changes.diff(sessionId, event.seq, index, signal);
      } catch {
        continue;
      }
      if (!diff) continue;
      const common = {
        path: file.path,
        display: file.display,
        added: file.added,
        deleted: file.deleted,
        eventTime: isoSeconds(new Date(event.time), resolveTimeZone()),
      };
      if (diff.kind === 'text') {
        const size = (diff.hunks || []).reduce((sum, hunk) => sum + (hunk.lines || []).join('\n').length, 0);
        bytes += size;
        diffs.push({ ...common, kind: 'text', hunks: diff.hunks || [] });
      } else {
        diffs.push({ ...common, kind: diff.kind });
      }
    }
  }
  return diffs;
}

/** 工作记忆：逐字条目 + diff 条目 + 分卷写入 */
async function saveWorkMemory({ hostCtx, port, root, dir, folder, timezone, config, session, messages, snapshot, stamp, savedAt }) {
  const entries = buildWorkEntries({ messages, savedAt, timezone, stamp });
  const diffs = await collectDiffs(hostCtx, session.sessionId, snapshot.events);
  const diffEntries = buildDiffEntries({ diffs, savedAt, timezone, stamp, seqStart: entries.length + 1 });
  const all = [...entries, ...diffEntries];

  const limits = {
    maxBytes: Number(config.values.max_file_bytes) || undefined,
    maxLines: Number(config.values.max_file_lines) || undefined,
  };
  // 逐字条目与 diff 分成两组卷：diff 的文件名带 (diff)，便于精确排查
  const groups = [
    { kind: 'work', suffix: '', items: entries },
    { kind: 'diff', suffix: '(diff)', items: diffEntries },
  ].filter((group) => group.items.length > 0);

  const files = [];

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    files.length = 0;
    try {
      let recordPart = 0;
      let diffPart = 0;
      for (const group of groups) {
        const volumes = packVolumes(group.items, limits);
        const total = volumes.length;
        const base = await allocateVolumeBase(port, dir, `${stamp}${group.suffix}`, total);
        for (let index = 0; index < total; index += 1) {
          const name = index === 0 ? `${base}.md` : `${base}_${index + 1}.md`;
          const partEntries = volumes[index].entries.map((item) => item.entry);
          const built = buildWorkFileText({
            session,
            entries: partEntries,
            savedAt,
            stamp: base,
            timezone,
            part: index + 1,
            totalParts: total,
            volumeKind: group.kind,
          });
          await port.writeText(`${dir}/${name}`, built.text, { kind: 'createIfAbsent' });
          files.push({
            name,
            kind: group.kind,
            part: index + 1,
            totalParts: total,
            entries: partEntries.length,
            bytes: Buffer.byteLength(built.text, 'utf8'),
          });
        }
        if (group.kind === 'work') recordPart += total;
        if (group.kind === 'diff') diffPart += total;
      }
      let promptFile = null;
      try {
        const promptText = buildPrompt('work', {
          session,
          folder,
          files: files.map((file) => ({ name: file.name, tag: file.kind === 'diff' ? 'diff' : 'work' })),
          timezone,
          savedAt,
        });
        const promptName = promptFileName('work');
        await port.writeText(`${dir}/${promptName}`, promptText);
        promptFile = `${folder}/${promptName}`;
      } catch (error) {
        // 提示词失败不影响记忆保存
      }

      return {
        ok: true,
        memoryClass: 'work',
        folder,
        files,
        promptFile,
        path: `${dir}/${files[0].name}`,
        entries: all.length,
        volumes: files.length,
        workVolumes: recordPart,
        diffVolumes: diffPart,
        diffs: diffEntries.length,
        summaryStatus: 'navigation_only',
        conflicts: 0,
        warnings: [],
      };
    } catch (error) {
      if (isExistsError(error) && attempt < 5) continue;
      throw error;
    }
  }
  throw new Error('同名文件过多，保存失败');
}

/**
 * 确认 / 拒绝 pending 条目。工具与页面路由共用这一份逻辑。
 * accept：转 current；若与现有长期要点冲突则保持 pending 并标冲突。
 * reject：转 deprecated。
 */
async function confirmPending(hostCtx, ids, decision, source = 'chat', refresh = null) {
  const wanted = (ids || []).map(String);
  if (wanted.length === 0) return { ok: false, error: '缺少 ids' };

  const { port, root, config, timezone } = await openMemory(hostCtx);
  const at = isoSeconds(new Date(), timezone);
  const before = await readAllDocs(port, root);
  const pendingDocs = before.docs.filter((doc) => wanted.includes(doc.entry.id) && doc.entry.fieldMap.status === 'pending');
  if (pendingDocs.length === 0) return { ok: false, error: '这些 id 没有 pending 状态的条目' };

  const existingLongTerm = before.docs.filter((doc) => doc.entry.fieldMap.type === 'long_term' && doc.entry.fieldMap.status === 'current');
  const conflicts = [];
  const done = [];

  const byFile = new Map();
  for (const doc of pendingDocs) {
    if (!byFile.has(doc.file)) byFile.set(doc.file, []);
    byFile.get(doc.file).push(doc.entry.id);
  }

  for (const [file, entryIds] of byFile) {
    const path = `${root}/${file}`;
    const doc = parseMemoryFile(await port.readText(path));
    let changed = false;
    for (const entry of doc.entries) {
      if (!entryIds.includes(entry.id)) continue;
      if (decision === 'reject') {
        setEntryField(entry, 'status', 'deprecated');
        setEntryField(entry, 'updated_at', at);
        setEntryBody(entry, [...entry.bodyLines, '', `> [!rejected] 用户于 ${at} 拒绝这条提案。`]);
        done.push(entry.id);
      } else {
        const found = findConflicts([entry], existingLongTerm);
        if (found.length > 0) {
          markPending(entry, found[0].against, { at });
          conflicts.push({ id: entry.id, against: found[0].against.id });
        } else {
          setEntryField(entry, 'status', 'current');
          setEntryField(entry, 'updated_at', at);
          setEntryBody(entry, entry.bodyLines.map((line) => (line.startsWith('> [!proposed]') ? `> [!confirmed] 用户于 ${at} 确认；本条已生效。` : line)));
          done.push(entry.id);
        }
      }
      changed = true;
    }
    if (changed) {
      for (const entry of doc.entries) if (entryIds.includes(entry.id)) entry.dirty = true;
      await port.writeText(path, serializeMemoryFile(doc));
    }
  }

  const after = await readAllDocs(port, root);
  let indexError = null;
  if (typeof refresh === 'function') {
    try {
      await refresh(after.docs);
    } catch (error) {
      indexError = String((error && error.message) || error);
    }
  }
  await appendAudit(port, root, {
    op: 'confirm', at, actor: 'user', result: indexError ? 'partial' : 'ok', entries: done.length, source,
    detail: `decision=${decision} ids=${done.join(',')} conflicts=${conflicts.length}${indexError ? ` indexError=${indexError}` : ''}`,
  });

  return { ok: true, decision, done, conflicts, at, indexError };
}

export function apply(ctx) {
  // 临时诊断：把激活阶段的错误落到文件，便于定位
  const debugLog = (stage, error) => {
    try {
      const line = `[${new Date().toISOString()}] ${stage}: ${(error && (error.stack || error.message)) || 'ok'}\n`;
      nodeFs.appendFile(new URL('./apply-error.log', import.meta.url), line).catch(() => {});
    } catch {
      // 诊断失败不影响主流程
    }
  };
  // 低 token 启动包缓存：prompt context 是同步的，只能读缓存，写盘时刷新
  let indexCache = { text: '', at: null };

  async function refreshIndex(port, root, config, docs) {
    const index = buildStartupIndex(docs, {
      now: Date.now(),
      budget: Number(config.values.startup_token_budget) || 800,
      estimateTokens,
    });
    indexCache = { text: index.text, at: new Date().toISOString(), tokens: index.tokens };
    return index;
  }

  ctx.inject(['webServer', 'fs', 'sessionQuery', 'tools', 'systemPrompt'], (hostCtx) => {
    try {
    const routeFailures = [];
    const route = (methods, path, handler) => {
      const allowed = Array.isArray(methods) ? methods : [methods];
      try {
        return hostCtx.effect(() => hostCtx.webServer.register({
          kind: 'exact',
          path,
          handler: async (request, response) => {
            if (!allowed.includes(request.method)) {
              response.writeHead(405, { allow: allowed.join(', ') });
              response.end();
              return;
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { ok: false, error: 'untrusted origin' });
              return;
            }
            try {
              sendJson(response, 200, await handler(request));
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String((error && error.message) || error) });
            }
          },
        }), `dsh-memory: ${path}`);
      } catch (error) {
        // 热重载时上一次失败实例可能残留同名路由；记录并继续，不要拖垮整个插件
        routeFailures.push({ path, error: String((error && error.message) || error) });
        debugLog('route-duplicate', `${path} ${(error && error.message) || error}`);
        return undefined;
      }
    };

    route('GET', '/memory/api/workspaces', async () => {
      const mem = await openMemory(hostCtx);
      const items = [];
      for (const ws of mem.workspaces) {
        const port = createFsPort(hostCtx, ws.path);
        const root = resolveMemoryRoot({ configured: '', workspace: ws.path });
        let fileCount = 0;
        let dirExists = false;
        try {
          const info = await port.stat(root);
          dirExists = Boolean(info && info.type === 'directory');
        } catch {
          dirExists = false;
        }
        if (dirExists) {
          try {
            fileCount = (await listMemoryFiles(port, root)).length;
          } catch {
            fileCount = 0;
          }
        }
        items.push({
          path: ws.path,
          title: ws.title,
          memoryRoot: root,
          hasMemory: dirExists,
          dirExists,
          fileCount,
          active: ws.path === mem.workspace,
        });
      }
      return { ok: true, workspaces: items, active: mem.workspace };
    });

    route('POST', '/memory/api/workspace', async (request) => {
      const body = await readJsonBody(request);
      const path = String((body && body.path) || '');
      const mem = await openMemory(hostCtx);
      if (!mem.workspaces.some((ws) => ws.path === path)) {
        return { ok: false, error: '不是已注册的工作区' };
      }
      await ensureRoot(mem.pointer.port, mem.pointer.root);
      await saveConfig(mem.pointer.port, mem.pointer.root, {
        ...mem.pointer.config.values,
        active_workspace: path,
      });
      indexCache = { text: '', at: null };

      const after = await openMemory(hostCtx);
      const refreshed = await readAllDocs(after.port, after.root);
      await refreshIndex(after.port, after.root, after.config, refreshed.docs);
      await appendAudit(after.port, after.root, {
        op: 'workspace', at: isoSeconds(new Date(), after.timezone), actor: 'user',
        result: 'ok', entries: 0, source: 'page', detail: `active=${path}`,
      });
      return { ok: true, active: after.workspace, memoryRoot: after.root };
    });

    route('POST', '/memory/api/archive', async () => {
      const { port, root, config, timezone } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const loose = files.filter((file) => file.dir === '');
      const moved = [];
      const skipped = [];

      for (const file of loose) {
        let sessionName = '';
        let meta = {};
        try {
          const doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
          meta = doc.frontMatter.data || {};
          sessionName = meta.session_name || meta.session_id || '';
        } catch {
          skipped.push({ file: file.name, reason: '解析失败' });
          continue;
        }

        // 没有会话名时按类别归：提案 / 导入 / 未归类
        let folder;
        if (sessionName) {
          folder = sanitizeFolderName(sessionName, '未归类');
        } else if (meta.imported === 'true') {
          folder = '导入';
        } else if (meta.memory_class === 'proposal') {
          folder = '提案';
        } else {
          folder = '未归类';
        }
        const dir = `${root}/${folder}`;
        await port.mkdir(dir);

        let dest = `${dir}/${file.name}`;
        let part = 2;
        while (await port.stat(dest)) {
          dest = `${dir}/${file.name.replace(/\.md$/, `_${part}.md`)}`;
          part += 1;
        }
        try {
          await nodeFs.rename(`${root}/${file.name}`, dest);
          moved.push({ file: file.name, to: `${folder}/${dest.split('/').pop()}` });
        } catch (error) {
          skipped.push({ file: file.name, reason: String((error && error.message) || error) });
        }
      }

      const after = await readAllDocs(port, root);
      await refreshIndex(port, root, config, after.docs);
      await appendAudit(port, root, {
        op: 'archive', at: isoSeconds(new Date(), timezone), actor: 'user',
        result: 'ok', entries: moved.length, source: 'page',
        detail: `moved=${moved.length} skipped=${skipped.length}`,
      });

      return {
        ok: true,
        moved: moved.length,
        skipped,
        folders: await listMemoryFolders(port, root),
      };
    });

    // 清空回收站（这里才是真正的删除）
    route('POST', '/memory/api/trash/empty', async () => {
      const { port, root, timezone } = await openMemory(hostCtx);
      const trash = `${root}/${TRASH_DIR}`;
      const info = await port.stat(trash).catch(() => undefined);
      if (!info) return { ok: true, removed: 0 };
      let count = 0;
      const walk = async (dir) => {
        const entries = await port.listDir(dir).catch(() => []);
        for (const entry of entries) {
          const full = `${dir}/${entry.name}`;
          if (entry.type === 'directory') {
            await walk(full);
          } else {
            count += 1;
          }
        }
      };
      await walk(trash);
      await nodeFs.rm(trash, { recursive: true, force: true });
      await appendAudit(port, root, {
        op: 'trash_empty', at: isoSeconds(new Date(), timezone), actor: 'user', result: 'ok',
        entries: count, source: 'page', detail: 'cleared',
      });
      return { ok: true, removed: count };
    });

    // 给所有历史文件夹补生成提示词
    route('POST', '/memory/api/prompt/rebuild', async () => {
      const { port, root, timezone } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const byFolder = new Map();
      for (const file of files) {
        const folder = file.dir || '';
        if (!folder) continue;
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push({
          name: file.name.split('/').pop(),
          tag: file.summary ? 'ZJB' : file.diff ? 'diff' : file.full ? 'full' : 'work',
        });
      }

      const written = [];
      for (const [folder, list] of byFolder) {
        const kind = list.some((item) => item.tag === 'ZJB' || item.tag === 'full') ? 'chat' : 'work';
        const session = { title: folder, sessionId: '' };
        const text = buildPrompt(kind, {
          session,
          folder,
          files: list,
          timezone,
          savedAt: isoSeconds(new Date(), timezone),
        });
        const name = promptFileName(kind);
        await port.writeText(`${root}/${folder}/${name}`, text);
        written.push(`${folder}/${name}`);
      }

      const at = isoSeconds(new Date(), timezone);
      await appendAudit(port, root, {
        op: 'prompt_rebuild', at, actor: 'user', result: 'ok', entries: written.length, source: 'page',
        detail: `folders=${written.length}`,
      });
      return { ok: true, written };
    });

    // 清理没有任何文件的空文件夹
    route('POST', '/memory/api/prune-empty', async () => {
      const { port, root, timezone } = await openMemory(hostCtx);
      const folders = await listMemoryFolders(port, root);
      const removed = [];
      for (const folder of folders) {
        let entries;
        try {
          entries = await port.listDir(`${root}/${folder}`);
        } catch {
          continue;
        }
        if (entries.length > 0) continue;
        try {
          await nodeFs.rmdir(`${root}/${folder}`);
          removed.push(folder);
        } catch {
          // 删不掉就跳过
        }
      }
      if (removed.length > 0) {
        const at = isoSeconds(new Date(), timezone);
        await appendAudit(port, root, {
          op: 'prune_empty', at, actor: 'user', result: 'ok', entries: removed.length, source: 'page',
          detail: removed.join(','),
        });
      }
      return { ok: true, removed };
    });

    // 合并两个文件夹（把 from 里的文件搬进 to，重名自动加序号）
    route('POST', '/memory/api/folders/merge', async (request) => {
      const body = await readJsonBody(request);
      const from = sanitizeFolderName(body && body.from, '');
      const to = sanitizeFolderName(body && body.to, '');
      if (!from || !to) return { ok: false, error: '需要 from 和 to' };
      if (from === to) return { ok: false, error: '两个名字相同' };

      const { port, root, timezone } = await openMemory(hostCtx);
      const src = await port.stat(`${root}/${from}`).catch(() => undefined);
      if (!src || src.type !== 'directory') return { ok: false, error: `${from} 不存在` };
      await port.mkdir(`${root}/${to}`);

      const entries = await port.listDir(`${root}/${from}`).catch(() => []);
      const moved = [];
      const skipped = [];
      for (const entry of entries) {
        if (entry.type !== 'file') { skipped.push(entry.name); continue; }
        let dest = `${root}/${to}/${entry.name}`;
        let part = 2;
        while (await port.stat(dest)) {
          dest = `${root}/${to}/${entry.name.replace(/(\.[^.]+)$/, `_${part}$1`)}`;
          part += 1;
        }
        try {
          await nodeFs.rename(`${root}/${from}/${entry.name}`, dest);
          moved.push(entry.name);
        } catch (error) {
          skipped.push(entry.name);
        }
      }

      let removed = false;
      try {
        const left = await port.listDir(`${root}/${from}`);
        if (left.length === 0) { await nodeFs.rmdir(`${root}/${from}`); removed = true; }
      } catch {
        removed = false;
      }

      await appendAudit(port, root, {
        op: 'merge_folders', at: isoSeconds(new Date(), timezone), actor: 'user', result: 'ok',
        entries: moved.length, source: 'page', detail: `${from}->${to} skipped=${skipped.length}`,
      });

      return { ok: true, from, to, moved: moved.length, skipped, removed };
    });

    // 删除选中的记忆文件（只允许记忆目录内的记忆文件）
    route('POST', '/memory/api/delete', async (request) => {
      const body = await readJsonBody(request);
      const list = Array.isArray(body && body.paths)
        ? body.paths
        : (body && body.path ? [body.path] : []);
      if (list.length === 0) return { ok: false, error: '没有选择文件' };

      const { port, root, config, timezone } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const allowed = new Set(files.map((file) => file.name));

      // 硬性保护：一次超过 10 个必须显式确认；否则只处理前 10 个并如实告知
      const confirmedAll = Boolean(body && body.confirmAll === true);
      const targets = confirmedAll ? list : list.slice(0, 10);

      const deleted = [];
      const skipped = [];
      const trashStamp = isoSeconds(new Date(), timezone).replace(/[:+]/g, '').replace('T', '_').slice(0, 15);
      const trashDir = `${root}/${TRASH_DIR}/${trashStamp}`;

      for (const rel of targets) {
        if (typeof rel !== 'string' || !allowed.has(rel)) {
          skipped.push({ file: String(rel), reason: '不在记忆目录内或不是记忆文件' });
          continue;
        }
        try {
          // 不直接删：移到 记忆/_回收站/<时间>/<原路径>
          const dest = `${trashDir}/${rel}`;
          await port.mkdir(dest.slice(0, dest.lastIndexOf('/')));
          await nodeFs.rename(`${root}/${rel}`, dest);
          deleted.push(rel);
        } catch (error) {
          skipped.push({ file: rel, reason: String((error && error.message) || error) });
        }
      }

      if (!confirmedAll && list.length > 10) {
        skipped.push({ file: '其余 ' + (list.length - 10) + ' 个', reason: '一次最多删 10 个，确认后可全部处理' });
      }

      const after = await readAllDocs(port, root);
      await refreshIndex(port, root, config, after.docs);
      await appendAudit(port, root, {
        op: 'delete', at: isoSeconds(new Date(), timezone), actor: 'user', result: 'ok',
        entries: deleted.length, source: 'page',
        detail: `deleted=${deleted.length} skipped=${skipped.length}${deleted.length ? ' files=' + deleted.join(',') : ''}`,
      });

      return { ok: true, deleted, skipped };
    });

    // 记忆库浏览：列出所有会话文件夹与文件
    route('GET', '/memory/api/prompt', async (request) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const sessionId = url.searchParams.get('sessionId') || '';
      const wanted = url.searchParams.get('folder') || '';
      const { port, root } = await openMemory(hostCtx);

      let folder = wanted;
      if (!folder && sessionId) {
        const title = await hostCtx.sessionQuery.readTitle(sessionId).catch(() => undefined);
        folder = sanitizeFolderName((title && title.title) || sessionId.slice(0, 8), '未命名');
      }
      if (!folder) return { ok: false, error: '需要 sessionId 或 folder' };

      const candidates = [promptFileName('chat'), promptFileName('work')];
      const found = [];

      const collect = async (folderName) => {
        for (const name of candidates) {
          const rel = `${folderName}/${name}`;
          const info = await port.stat(`${root}/${rel}`);
          if (!info || info.type !== 'file') continue;
          if (found.some((item) => item.name === rel)) continue;
          found.push({ name: rel, text: await port.readText(`${root}/${rel}`) });
        }
      };

      await collect(folder);

      // 会话名文件夹里没有时，扫一遍所有文件夹：提示词里写着「会话：<标题>」
      if (found.length === 0 && sessionId) {
        const title = await hostCtx.sessionQuery.readTitle(sessionId).catch(() => undefined);
        const wantedTitle = (title && title.title) || '';
        const folders = await listMemoryFolders(port, root);
        for (const other of folders) {
          if (wantedTitle) {
            for (const name of candidates) {
              const rel = `${other}/${name}`;
              const info = await port.stat(`${root}/${rel}`);
              if (!info || info.type !== 'file') continue;
              const text = await port.readText(`${root}/${rel}`);
              if (text.includes(wantedTitle)) { found.push({ name: rel, text }); break; }
            }
          } else {
            await collect(other);
          }
        }
      }

      if (found.length === 0) {
        return { ok: false, error: `${folder} 里还没有提示词，先保存一次记忆` };
      }
      return { ok: true, folder: found[0].name.split('/')[0], files: found };
    });

    route('GET', '/memory/api/library', async () => {
      const { port, root } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const byFolder = new Map();
      for (const file of files) {
        const full = `${root}/${file.name}`;
        let entries = 0;
        let sessionName = '';
        let savedAt = '';
        try {
          const doc = parseMemoryFile(await port.readText(full));
          entries = doc.entries.length;
          sessionName = doc.frontMatter.data.session_name || '';
          savedAt = doc.frontMatter.data.saved_at || '';
        } catch {
          entries = -1;
        }
        const folder = file.dir || '（根目录）';
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push({
          path: file.name,
          name: file.name.split('/').pop(),
          tag: file.summary ? 'ZJB' : file.diff ? 'diff' : file.full ? 'full' : 'work',
          part: file.part,
          size: file.size,
          entries,
          sessionName,
          savedAt,
        });
      }
      // 提示词文件（不是记忆条目，但要能在页面上看到）
      const promptNames = ['提示词.md', '工作流程提示词.md'];
      for (const folder of await listMemoryFolders(port, root)) {
        for (const name of promptNames) {
          const rel = `${folder}/${name}`;
          const info = await port.stat(`${root}/${rel}`).catch(() => undefined);
          if (!info || info.type !== 'file') continue;
          if (!byFolder.has(folder)) byFolder.set(folder, []);
          byFolder.get(folder).push({
            path: rel,
            name,
            tag: 'prompt',
            part: 1,
            size: info.size,
            entries: 0,
            sessionName: '',
            savedAt: '',
          });
        }
      }

      const folders = [...byFolder.entries()]
        .map(([folder, list]) => ({
          folder,
          files: list.sort((a, b) => (a.path < b.path ? 1 : -1)),
          count: list.length,
        }))
        .sort((a, b) => (a.folder < b.folder ? 1 : -1));
      return { ok: true, folders, totalFiles: files.length };
    });

    // 读一个记忆文件的条目（只允许记忆目录内的记忆文件）
    route('GET', '/memory/api/read', async (request) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const rel = url.searchParams.get('path') || '';
      const { port, root } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const target = files.find((file) => file.name === rel);
      const isPrompt = ['提示词.md', '工作流程提示词.md'].some((name) => rel.endsWith('/' + name));
      if (!target && !isPrompt) return { ok: false, error: '文件不存在或不在记忆目录内' };

      if (isPrompt) {
        const info = await port.stat(`${root}/${rel}`).catch(() => undefined);
        if (!info || info.type !== 'file') return { ok: false, error: '提示词文件不存在' };
        const text = await port.readText(`${root}/${rel}`);
        const preview = text.split('\n').filter((line) => line.trim()).slice(0, 40).join('\n');
        return {
          ok: true,
          path: rel,
          frontMatter: {},
          issues: 0,
          prompt: true,
          entries: [{ id: rel, type: 'prompt', title: '提示词全文（前 40 行）', status: 'file', eventTime: '', body: preview }],
        };
      }

      const doc = parseMemoryFile(await port.readText(`${root}/${rel}`));
      return {
        ok: true,
        path: rel,
        frontMatter: doc.frontMatter.data,
        issues: doc.issues.length,
        entries: doc.entries.map((entry) => ({
          id: entry.id,
          type: entry.fieldMap.type,
          title: entry.title,
          status: entry.fieldMap.status,
          eventTime: entry.fieldMap.event_time,
          body: entry.bodyLines.join('\n').slice(0, 4000),
        })),
      };
    });

    route(['GET', 'POST'], '/memory/api/settings', async (request) => {
      if (request.method === 'GET') {
        const mem = await openMemory(hostCtx);
        return {
          ok: true,
          memoryRoot: mem.root,
          workspace: mem.workspace,
          values: mem.config.values,
          defaults: DEFAULT_CONFIG,
          defaultsUsed: mem.config.defaultsUsed,
          unknownKeys: mem.config.unknownKeys,
        };
      }

      const body = await readJsonBody(request);
      const patch = (body && body.patch) || {};
      const mem = await openMemory(hostCtx);
      const values = { ...mem.config.values };
      const applied = [];
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_CONFIG)) continue; // 未知键只在文件里保留，接口不写
        if (key === 'memory_root' || key === 'active_workspace') continue; // 走各自的入口
        values[key] = value;
        applied.push(key);
      }
      if (applied.length === 0) return { ok: false, error: '没有可写回的配置项' };
      await saveConfig(mem.port, mem.root, values);

      const after = await openMemory(hostCtx);
      const refreshed = await readAllDocs(after.port, after.root);
      await refreshIndex(after.port, after.root, after.config, refreshed.docs);
      await appendAudit(after.port, after.root, {
        op: 'config', at: isoSeconds(new Date(), after.timezone), actor: 'user',
        result: 'ok', entries: 0, source: 'page', detail: applied.join(','),
      });
      return { ok: true, applied, values: after.config.values };
    });

    route('GET', '/memory/api/state', async () => {
      const { workspace, port, timezone, root, config, configCreated } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const conflicts = await collectConflictStats(port, root, files);

      // 页面首次打开时把启动包缓存热起来（之后由 maintain 刷新）
      if (!indexCache.text) {
        const { docs } = await readAllDocs(port, root);
        await refreshIndex(port, root, config, docs);
      }

      let indexInfo = { exists: false, tokens: 0, entries: 0, generatedAt: null };
      try {
        const indexPath = systemPath(root, INDEX_FILE);
        if (await port.stat(indexPath)) {
          const parsedIndex = parseMemoryFile(await port.readText(indexPath));
          indexInfo = {
            exists: true,
            tokens: Number(parsedIndex.frontMatter.data.index_tokens_est) || 0,
            entries: Number(parsedIndex.frontMatter.data.entries) || 0,
            generatedAt: parsedIndex.frontMatter.data.index_generated_at || null,
          };
        }
      } catch {
        // 索引坏了不影响状态接口
      }

      return {
        ok: true,
        plugin: 'dsh-memory',
        version: VERSION,
        serverTime: new Date().toISOString(),
        pid: process.pid,
        workspace,
        timezone,
        memoryRoot: root,
        fileCount: files.length,
        bytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
        files: files.slice(0, 20).map((file) => ({ name: file.name, dir: file.dir, size: file.size, part: file.part })),
        folders: await listMemoryFolders(port, root),
        conflicts,
        index: indexInfo,
        routeFailures,
        config: {
          exists: config.exists,
          created: configCreated,
          defaultsUsed: config.defaultsUsed.length,
          unknownKeys: config.unknownKeys,
          issues: config.issues.slice(0, 12).map((issue) => ({ code: issue.code, message: issue.message })),
        },
      };
    });

    route('GET', '/memory/api/sessions', async () => {
      const { timezone } = await openMemory(hostCtx);
      const result = await listSessions(hostCtx, timezone);
      return { ok: true, ...result };
    });

    route('GET', '/memory/api/preview', async (request) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return { ok: false, error: '缺少 sessionId' };
      const { port, root, timezone } = await openMemory(hostCtx);
      const snapshot = await findSession(hostCtx, sessionId);
      const summary = summarizeEvents(snapshot.events);
      const title = await hostCtx.sessionQuery.readTitle(sessionId).catch(() => undefined);
      const sessionName = (title && title.title) || `会话 ${String(sessionId).slice(0, 8)}`;
      // 默认文件夹＝会话名（清洗过）；用户可在页面上改
      const suggestedFolder = sanitizeFolderName(sessionName, String(sessionId).slice(0, 8));
      const name = await allocateName(port, `${root}/${suggestedFolder}`, `${fileStamp(new Date(), timezone)}(ZJB)`);
      return {
        ok: true,
        sessionId,
        sessionName,
        folder: suggestedFolder,
        folders: await listMemoryFolders(port, root),
        fileName: `${suggestedFolder}/${name}`,
        messageCount: summary.messageCount,
        messageRange: `1-${summary.messageCount}`,
        memoryClass: 'chat',
      };
    });

    route('GET', '/memory/api/search', async (request) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const query = (url.searchParams.get('q') || '').trim();
      if (!query) return { ok: true, query, terms: [], hits: [], message: '无可用记忆' };

      const { port, root, config, timezone } = await openMemory(hostCtx);
      const files = (await listMemoryFiles(port, root)).slice(0, 200);

      const docs = [];
      const broken = [];
      for (const file of files) {
        try {
          const doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
          for (const entry of doc.entries) docs.push({ file: file.name, entry });
        } catch (error) {
          broken.push({ file: file.name, error: String((error && error.message) || error) });
        }
      }

      const started = Date.now();
      const result = searchEntries(docs, query, {
        limit: Number(url.searchParams.get('limit')) || 20,
        type: url.searchParams.get('type') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        freshDays: Number(config.values.full_weight_days) || 20,
      });

      // A6：命中项若处于冲突中，把双方值一起返回，不隐藏 pending
      const enriched = result.hits.map((hit) => {
        const doc = docs.find((item) => item.entry.id === hit.id);
        if (!doc) return hit;
        const conflict = readConflict(doc.entry);
        if (!conflict) return hit;
        return {
          ...hit,
          conflict: {
            pending: doc.entry.fieldMap.status === 'pending',
            oldId: conflict.oldId,
            oldValue: conflict.oldValue,
            newValue: conflict.newValue,
            reason: conflict.reason,
          },
        };
      });

      // 命中即记一次访问（内部有 1 小时节流），失败不影响返回
      if (result.hits.length > 0) {
        applyAccessBoost(port, root, result.hits, isoSeconds(new Date(), timezone)).catch(() => {});
      }

      return {
        ok: true,
        query,
        terms: result.terms,
        hits: enriched,
        scanned: { files: files.length, entries: result.scanned },
        total: result.total ?? result.hits.length,
        broken,
        message: result.hits.length === 0 ? '无可用记忆' : undefined,
        tookMs: Date.now() - started,
      };
    });

    route('POST', '/memory/api/maintain', async () => {
      const { port, root, timezone, config } = await openMemory(hostCtx);
      const files = await listMemoryFiles(port, root);
      const now = Date.now();
      const fullDays = Number(config.values.full_weight_days) || 20;
      const halfLife = Number(config.values.half_life_days) || 30;
      const floor = Number(config.values.weight_floor) || 5;
      const purgeDays = Number(config.values.purge_after_days) || 20;
      const at = isoSeconds(new Date(), timezone);

      let reweighted = 0;
      let purged = 0;
      let rewritten = 0;
      const docs = [];

      for (const file of files) {
        const path = `${root}/${file.name}`;
        const doc = parseMemoryFile(await port.readText(path));
        let changed = false;

        for (const entry of doc.entries) {
          const type = entry.fieldMap && entry.fieldMap.type;
          if (type === 'session_digest' || type === 'period_digest') {
            const calc = computeWeight({
              base: type === 'period_digest' ? 70 : 60,
              eventTime: entry.fieldMap.event_time,
              now,
              fullDays,
              halfLifeDays: halfLife,
              floor,
            });
            if (entry.fieldMap.weight !== String(calc.weight) || entry.fieldMap.weight_bucket !== calc.bucket) {
              setEntryField(entry, 'weight', String(calc.weight));
              setEntryField(entry, 'weight_bucket', calc.bucket);
              setEntryField(entry, 'weight_computed_at', at);
              reweighted += 1;
              changed = true;
            }
            if (entry.fieldMap.details_purged !== 'true' && shouldPurge(entry.fieldMap.event_time, now, purgeDays)) {
              const result = purgeDetail(entry.bodyLines, { at, days: purgeDays });
              if (result.purged) {
                setEntryBody(entry, result.bodyLines);
                setEntryField(entry, 'details_purged', 'true');
                setEntryField(entry, 'updated_at', at);
                purged += 1;
                changed = true;
              }
            }
          }
          docs.push({ file: file.name, entry });
        }

        if (changed) {
          await port.writeText(path, serializeMemoryFile(doc));
          rewritten += 1;
        }
      }

      // 去重合并：同一 kind+value 的长期要点只留一条 current，其余标 superseded
      const dupGroups = findDuplicates(docs);
      let deduped = 0;
      for (const group of dupGroups) {
        const keeperId = group.keeper.entry.id;
        const byFile = new Map();
        for (const item of group.duplicates) {
          if (!byFile.has(item.file)) byFile.set(item.file, []);
          byFile.get(item.file).push(item.entry.id);
        }
        for (const [file, ids] of byFile) {
          const path = `${root}/${file}`;
          const doc = parseMemoryFile(await port.readText(path));
          let changed = false;
          for (const entry of doc.entries) {
            if (!ids.includes(entry.id)) continue;
            setEntryField(entry, 'status', 'superseded');
            setEntryField(entry, 'superseded_by', keeperId);
            setEntryField(entry, 'updated_at', at);
            setEntryBody(entry, [
              ...entry.bodyLines,
              '',
              `> [!duplicate] 与 ${keeperId} 内容重复，已合并保留对方；本条原文与时间戳不动。`,
            ]);
            changed = true;
            deduped += 1;
          }
          if (changed) {
            for (const entry of doc.entries) if (ids.includes(entry.id)) entry.dirty = true;
            await port.writeText(path, serializeMemoryFile(doc));
            rewritten += 1;
          }
        }
      }

      const fresh = deduped > 0 ? await readAllDocs(port, root) : { docs };
      const index = await refreshIndex(port, root, config, fresh.docs);

      const indexText = [
        '---',
        'memory_format: dsh-memory',
        'format_version: 1',
        `saved_at: ${at}`,
        `index_generated_at: ${at}`,
        `entries: ${index.included.length}`,
        `index_tokens_est: ${index.tokens}`,
        '---',
        '',
        index.text,
      ].join('\n');
      await port.writeText(systemPath(root, INDEX_FILE), indexText);

      await appendAudit(port, root, {
        op: 'maintain', at, actor: 'user', result: 'ok',
        entries: index.included.length, source: 'local',
        detail: `reweighted=${reweighted} purged=${purged} deduped=${deduped} rewritten=${rewritten} indexTokens=${index.tokens}`,
      });

      return {
        ok: true,
        at,
        reweighted,
        purged,
        deduped,
        rewritten,
        indexTokens: index.tokens,
        included: index.included.length,
        skipped: index.skipped,
      };
    });
    route('GET', '/memory/api/conflicts', async () => {
      const { port, root } = await openMemory(hostCtx);
      const { docs } = await readAllDocs(port, root);
      const pending = [];
      for (const doc of docs) {
        const entry = doc.entry;
        if (entry.fieldMap.status !== 'pending') continue;
        const conflict = readConflict(entry);
        if (!conflict) continue;
        pending.push({
          id: entry.id,
          file: doc.file,
          kind: entry.fieldMap.kind,
          kindType: entry.fieldMap.type,
          oldId: conflict.oldId,
          oldValue: conflict.oldValue,
          newValue: conflict.newValue,
          eventTime: entry.fieldMap.event_time,
        });
      }
      return { ok: true, pending, total: pending.length };
    });

    route('GET', '/memory/api/proposals', async () => {
      const { port, root } = await openMemory(hostCtx);
      const { docs } = await readAllDocs(port, root);
      const proposals = docs
        .filter((doc) => doc.entry.fieldMap.status === 'pending'
          && String(doc.entry.fieldMap.tags || '').includes('proposed'))
        .map((doc) => ({
          id: doc.entry.id,
          file: doc.file,
          kind: doc.entry.fieldMap.kind,
          value: doc.entry.fieldMap.value,
          eventTime: doc.entry.fieldMap.event_time,
        }));
      return { ok: true, proposals, total: proposals.length };
    });

    route('POST', '/memory/api/confirm', async (request) => {
      const body = await readJsonBody(request);
      const ids = body && Array.isArray(body.ids) ? body.ids : [];
      const decision = body && body.action === 'reject' ? 'reject' : 'accept';
      return confirmPending(hostCtx, ids, decision, 'page', async (docs) => {
        const mem = await openMemory(hostCtx);
        await refreshIndex(mem.port, mem.root, mem.config, docs);
      });
    });

    route('POST', '/memory/api/resolve', async (request) => {
      const body = await readJsonBody(request);
      const id = body && body.id;
      const action = body && body.action === 'keep_old' ? 'keep_old' : 'accept_new';
      if (!id) return { ok: false, error: '缺少条目 id' };

      const { port, root, config, timezone } = await openMemory(hostCtx);
      const { docs } = await readAllDocs(port, root);
      const found = docs.find((doc) => doc.entry.id === id);
      if (!found) return { ok: false, error: '找不到这个条目' };
      if (!readConflict(found.entry)) return { ok: false, error: '这个条目没有待解决的冲突' };

      const at = isoSeconds(new Date(), timezone);
      const oldId = readConflict(found.entry).oldId;

      await updateEntryInFile(port, root, found.file, id, (entry) => {
        applyResolution(entry, action, { at, actor: 'user' });
      });

      let oldUpdated = false;
      if (action === 'accept_new' && oldId) {
        const old = docs.find((doc) => doc.entry.id === oldId);
        if (old) {
          await updateEntryInFile(port, root, old.file, oldId, (entry) => {
            setEntryField(entry, 'status', 'superseded');
            setEntryField(entry, 'superseded_by', id);
            setEntryField(entry, 'updated_at', at);
            setEntryBody(entry, [
              ...entry.bodyLines,
              '',
              `> [!superseded] 被 ${id} 取代于 ${at}（冲突解决：采用新值）；原文保留。`,
            ]);
          });
          oldUpdated = true;
        }
      }

      const refreshed = await readAllDocs(port, root);
      await refreshIndex(port, root, config, refreshed.docs);
      await appendAudit(port, root, {
        op: 'resolve', at, actor: 'user', result: 'ok', entries: 1, source: 'local',
        detail: `id=${id} action=${action} oldId=${oldId || 'none'} oldUpdated=${oldUpdated}`,
      });

      return { ok: true, id, action, oldId, oldUpdated, at };
    });

    route('GET', '/memory/api/export', async (request) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const kind = url.searchParams.get('scope') || 'all';
      const value = url.searchParams.get('value') || '';
      const { port, root, timezone } = await openMemory(hostCtx);
      const { docs, files } = await readAllDocs(port, root);
      const selected = selectEntries(docs, {
        kind,
        value,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      });
      const at = isoSeconds(new Date(), timezone);
      const built = buildExportDocument(selected, {
        exportedAt: at,
        scopeLabel: value ? `${kind}:${value}` : kind,
      });
      await appendAudit(port, root, {
        op: 'export', at, actor: 'user', result: 'ok',
        entries: built.entries, source: 'local',
        detail: `scope=${kind}${value ? ':' + value : ''} scanned=${files.length}`,
      });
      return { ok: true, exportedAt: at, ...built };
    });

    route('POST', '/memory/api/import', async (request) => {
      const body = await readJsonBody(request, 4 * 1024 * 1024);
      const text = body && body.text;
      if (!text || !String(text).trim()) return { ok: false, error: '缺少导入文本' };

      const { port, root, timezone } = await openMemory(hostCtx);
      const parsed = parseMemoryFile(String(text));
      const { docs } = await readAllDocs(port, root);
      const existingIds = new Set(docs.map((doc) => doc.entry.id));
      const existingFingerprints = new Map(docs.map((doc) => [doc.entry.id, fingerprint(doc.entry)]));

      const planned = planImport(parsed, { existingIds, existingFingerprints });
      const at = isoSeconds(new Date(), timezone);

      if (!planned.ok) {
        await appendAudit(port, root, { op: 'import', at, actor: 'user', result: 'failed', entries: 0, source: 'upload', detail: planned.error });
        return { ok: false, error: planned.error, report: planned.report };
      }

      const accepted = planned.plan.filter((item) => item.action === 'accept').map((item) => item.entry);
      // 导入目标：优先"选中的会话"，其次手填文件夹名，留空则进「导入」
      let requestedFolder = body && body.folder;
      const targetSessionId = body && body.sessionId;
      if (targetSessionId) {
        const title = await hostCtx.sessionQuery.readTitle(targetSessionId).catch(() => undefined);
        const name = (title && title.title) || `会话 ${String(targetSessionId).slice(0, 8)}`;
        requestedFolder = sanitizeFolderName(name, String(targetSessionId).slice(0, 8));
      }
      const folder = requestedFolder ? sanitizeFolderName(requestedFolder, '导入') : '导入';
      const dir = `${root}/${folder}`;
      let fileName = null;
      if (accepted.length > 0) {
        await port.mkdir(dir);
        const stamp = fileStamp(new Date(), timezone);
        const name = await allocateName(port, dir, stamp);
        await port.writeText(`${dir}/${name}`, buildImportFileText(accepted, { at, source: 'upload' }), {
          kind: 'createIfAbsent',
        });
        fileName = `${folder}/${name}`;
      }

      await appendAudit(port, root, {
        op: 'import', at, actor: 'user', result: 'ok',
        entries: accepted.length, source: 'upload',
        detail: `folder=${folder} skipped=${planned.report.skipped} conflicts=${planned.report.conflicts} rejected=${planned.report.rejected} failed=${planned.report.failed}`,
      });

      return {
        ok: true,
        file: fileName,
        folder,
        report: planned.report,
        plan: planned.plan.map((item) => ({ id: item.id, action: item.action, reason: item.reason })),
      };
    });

    route('POST', '/memory/api/save', async (request) => {
      const body = await readJsonBody(request);
      const sessionId = body && body.sessionId;
      if (!sessionId) return { ok: false, error: '缺少 sessionId' };
      const memoryClass = body.memoryClass === 'work' ? 'work' : 'chat';

      const { port, root, timezone, config } = await openMemory(hostCtx);
      const snapshot = await findSession(hostCtx, sessionId);
      const summary = summarizeEvents(snapshot.events);
      const messages = extractMessages(snapshot.events, toIso(timezone));
      if (messages.length === 0) return { ok: false, error: '该会话没有可保存的文本消息' };

      // 诊断：用户消息里到底有哪些内容块类型（媒体提取靠它排障）
      const blockTypes = {};
      const imageKeys = new Set();
      for (const event of snapshot.events || []) {
        if (!event || event.type !== 'user/message') continue;
        const content = event.data && event.data.content;
        if (!Array.isArray(content)) { blockTypes['(no-content)'] = (blockTypes['(no-content)'] || 0) + 1; continue; }
        for (const block of content) {
          const key = (block && block.type) || 'unknown';
          blockTypes[key] = (blockTypes[key] || 0) + 1;
          if (key === 'image' || key === 'file') {
            imageKeys.add(Object.keys(block).join(','));
            const a = block.attachment;
            imageKeys.add(`attachment:${a === null ? 'null' : typeof a}${a && typeof a === 'object' ? `(${Object.keys(a).join('|')})` : ''}`);
          }
        }
      }

      const now = new Date();
      const stamp = fileStamp(now, timezone);
      const savedAt = isoSeconds(now, timezone);
      const title = await hostCtx.sessionQuery.readTitle(sessionId).catch(() => undefined);
      const session = {
        sessionId,
        title: (title && title.title) || `会话 ${String(sessionId).slice(0, 8)}`,
        messageRange: `1-${summary.messageCount}`,
        coversFrom: summary.startTime ? isoSeconds(new Date(summary.startTime), timezone) : 'unknown',
        coversTo: summary.endTime ? isoSeconds(new Date(summary.endTime), timezone) : savedAt,
      };

      // 按会话分文件夹：用户指定的优先，否则用会话名（清洗过）
      const requested = body && body.folder;
      const folder = sanitizeFolderName(requested || session.title, String(sessionId).slice(0, 8));
      const dir = `${root}/${folder}`;
      await port.mkdir(dir);

      if (memoryClass === 'work') {
        return saveWorkMemory({ hostCtx, port, root, dir, folder, timezone, config, session, messages, snapshot, stamp, savedAt });
      }

      const carry = await loadCarried(port, root);
      const digest = extractDigest(messages, {
        charBudget: Number(config.values.summary_char_budget) || 600,
        carried: carry.carried,
      });
      digest.basis = carry.carried.length > 0 ? 'carried' : 'fresh';

      const previous = await findPreviousDigests(port, root, sessionId);
      // 承接链：链到上一条摘要，链长 = 上一条的 chain_length + 1
      let chainFrom = null;
      let chainLength = 1;
      if (previous.length > 0) {
        const last = previous[previous.length - 1];
        chainFrom = last.id;
        try {
          const prevDoc = parseMemoryFile(await port.readText(`${root}/${last.file}`));
          const prevEntry = prevDoc.entries.find((item) => item.id === last.id);
          chainLength = (Number(prevEntry && prevEntry.fieldMap.chain_length) || 1) + 1;
        } catch {
          chainLength = 2;
        }
      }
      const supersedes = previous.length > 0 ? previous[previous.length - 1].id : null;

      const purgeDays = Number(config.values.purge_after_days) || 20;
      const purgeAfter = isoSeconds(new Date(now.getTime() + purgeDays * 86400000), timezone);

      // 长期要点：独立成条，同 kind 值不同即 pending，不覆盖旧条目
      const longItems = extractLongTerm(messages);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const fileName = await allocateName(port, dir, `${stamp}(ZJB)`);
        // ID 必须带上文件的唯一名，否则同一秒保存两个会话会产生重复 ID
        // 条目 ID 不带 (ZJB)，保持干净
        const stampFor = fileName.replace(/\(ZJB\)/g, '').replace(/\.md$/, '');
        let extraEntries = [];
        let longConflicts = 0;
        if (longItems.length > 0) {
          const existing = await readAllDocs(port, root);
          // 去重：同一 kind + 同一 value 已经存在就不再写一遍（避免每次保存都复制一批）
          const seenLongTerm = new Set(existing.docs
            .filter((doc) => doc.entry.fieldMap.type === 'long_term' && doc.entry.fieldMap.status === 'current')
            .map((doc) => `${doc.entry.fieldMap.kind}:${doc.entry.fieldMap.value}`));
          const freshItems = longItems.filter((item) => !seenLongTerm.has(`${item.kind}:${item.value}`));
          extraEntries = buildLongTermEntries(freshItems, { savedAt, timezone, stamp: stampFor, seqStart: 2 });
          const conflicts = findConflicts(extraEntries, existing.docs);
          for (const conflict of conflicts) markPending(conflict.entry, conflict.against, { at: savedAt });
          longConflicts = conflicts.length;
        }
        const mediaItems = extractMediaFromEvents(snapshot.events);
        if (mediaItems.length > 0) {
          // 同一附件已经记过就不再写一遍
          const knownMedia = new Set((await readAllDocs(port, root)).docs
            .filter((doc) => doc.entry.fieldMap.type === 'media_summary')
            .map((doc) => doc.entry.fieldMap.media_source));
          const freshMedia = mediaItems.filter((item) => !knownMedia.has(item.mediaSource));
          if (freshMedia.length > 0) {
            const mediaEntries = buildMediaEntries(freshMedia, {
              savedAt, timezone, stamp: stampFor, seqStart: 2 + extraEntries.length, toIso: toIso(timezone),
            });
            extraEntries = [...extraEntries, ...mediaEntries];
          }
        }
        // A5：写盘前按内容分级（secret / private / device_local）
        try {
          const targets = [];
          for (const item of extraEntries) if (item && item.entry) targets.push(item.entry);
          for (const entry of targets) {
            const text = [entry.fieldMap && entry.fieldMap.value, (entry.bodyLines || []).join(' ')].filter(Boolean).join(' ');
            setEntryField(entry, 'privacy', gradePrivacy(text));
          }
        } catch {
          // 分级失败不影响保存
        }

        // L2 阶段总结：链长达到阈值时，把最近若干条 L1 的要点聚合成一条
        try {
          const threshold = Number(config.values.period_chain_threshold) || 10;
          if (chainLength >= threshold && chainLength % threshold === 0 && previous.length > 0) {
            // 聚合对象要包含已 superseded 的旧摘要，否则永远只有 1 条
            const allFiles = (await listMemoryFiles(port, root))
              .filter((file) => (file.dir === folder || !file.dir))
              .slice(0, 40);
            const candidates = [];
            for (const file of allFiles) {
              try {
                const doc = parseMemoryFile(await port.readText(`${root}/${file.name}`));
                const digest = doc.entries.find((item) => item.fieldMap.type === 'session_digest');
                if (!digest) continue;
                if (digest.fieldMap.session_id && digest.fieldMap.session_id !== session.sessionId) continue;
                candidates.push({ file: file.name, info: readDigestPoints(doc) });
              } catch {
                // 跳过坏文件
              }
            }
            const items = candidates
              .slice(0, threshold)
              .map((item) => item.info)
              .filter((info) => info.id && (info.points || []).length > 0);
            if (items.length >= 2) {
              extraEntries = [...extraEntries, buildPeriodEntry({
                items,
                savedAt,
                timezone,
                stamp: stampFor,
                seq: 2 + extraEntries.length,
                chainFrom: previous[previous.length - 1].id,
                chainLength,
              })];
            }
          }
        } catch {
          // 阶段总结失败不影响主保存
        }

        const built = buildMemoryFileText({
          digest, session, stamp: stampFor, savedAt, timezone, memoryClass, fileName, purgeAfter, purgeDays, supersedes,
          chainFrom, chainLength,
          extraEntries,
        });
        try {
          await port.writeText(`${dir}/${fileName}`, built.text, { kind: 'createIfAbsent' });
          const warnings = [...(digest.warnings || [])];
          let supersededFiles = [];
          if (previous.length > 0) {
            try {
              supersededFiles = await markSuperseded(port, root, previous, built.entryId, savedAt);
            } catch (error) {
              warnings.push(`supersede_failed: ${String((error && error.message) || error)}`);
            }
          }
          // 完整记忆版：逐字保存本次会话，供检索时回查细节（不进启动包）
          let fullFiles = [];
          try {
            const fullEntries = buildWorkEntries({
              messages, savedAt, timezone, stamp, idPrefix: 'FL',
            });
            if (fullEntries.length > 0) {
              const limits = {
                maxBytes: Number(config.values.max_file_bytes) || undefined,
                maxLines: Number(config.values.max_file_lines) || undefined,
              };
              const volumes = packVolumes(fullEntries, limits);
              const base = await allocateVolumeBase(port, dir, `${stamp}(full)`, volumes.length);
              for (let index = 0; index < volumes.length; index += 1) {
                const name = index === 0 ? `${base}.md` : `${base}_${index + 1}.md`;
                const partEntries = volumes[index].entries.map((item) => item.entry);
                const builtFull = buildWorkFileText({
                  session,
                  entries: partEntries,
                  savedAt,
                  stamp: base,
                  timezone,
                  part: index + 1,
                  totalParts: volumes.length,
                  volumeKind: 'full',
                });
                await port.writeText(`${dir}/${name}`, builtFull.text, { kind: 'createIfAbsent' });
                fullFiles.push(name);
              }
            }
          } catch (error) {
            warnings.push(`full_version_failed: ${String((error && error.message) || error)}`);
          }

          // 提示词：用户只需导入这一个文件，AI 按它去读同目录记忆
          let promptFile = null;
          try {
            const inFolder = (await listMemoryFiles(port, root)).filter((file) => file.dir === folder);
            const promptText = buildPrompt('chat', {
              session,
              folder,
              files: inFolder.map((file) => ({
                name: file.name.split('/').pop(),
                tag: file.summary ? 'ZJB' : file.diff ? 'diff' : file.full ? 'full' : 'work',
              })),
              timezone,
              savedAt,
            });
            const promptName = promptFileName('chat');
            await port.writeText(`${dir}/${promptName}`, promptText);
            promptFile = `${folder}/${promptName}`;
          } catch (error) {
            warnings.push(`prompt_failed: ${String((error && error.message) || error)}`);
          }

          const refreshed = await readAllDocs(port, root);
          await refreshIndex(port, root, config, refreshed.docs);
          return {
            ok: true,
            memoryClass,
            folder,
            fullFiles,
            promptFile,
            files: [{ name: fileName, part: 1, totalParts: 1 }],
            path: `${dir}/${fileName}`,
            entryId: built.entryId,
            entries: built.entries,
            longTerm: extraEntries.length,
            longTermConflicts: longConflicts,
            bytes: Buffer.byteLength(built.text, 'utf8'),
            summaryStatus: (digest.increments || []).length === 0 ? 'pending' : 'current',
            summaryChars: digest.stats.summaryChars,
            sourceChars: digest.stats.sourceChars,
            carriedFrom: carry.from,
            supersedes,
            superseded: previous.map((item) => item.id),
            supersededFiles,
            conflicts: longConflicts,
            warnings,
            blockTypes,
            imageKeys: [...imageKeys],
          };
        } catch (error) {
          if (isExistsError(error) && attempt < 5) continue;
          throw error;
        }
      }
      throw new Error('同名文件过多，保存失败');
    });

    // ---- 记忆工具：让模型主动检索，而不是把记忆全塞进上下文 ----
    const textBlock = (text) => [{ type: 'text', text }];

    // 工具结果必须是无损 JSON：undefined 字段会被判为非法，返回前统一清掉
    const cleanJson = (value) => {
      if (Array.isArray(value)) return value.map(cleanJson).filter((item) => item !== undefined);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined) continue;
          const cleaned = cleanJson(item);
          if (cleaned !== undefined) out[key] = cleaned;
        }
        return out;
      }
      return value;
    };

    const defineTool = (definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
      },
      async execute(args, exec) {
        return cleanJson(await definition.run(args || {}, exec));
      },
    });

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_search',
      description: '在本地长期记忆里检索。命中返回 id、标题、时间、时效、得分与摘录；工作记忆条目直接返回全文。无命中时 message 是「无可用记忆」，不要编造。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词、实体或主题' },
          limit: { type: 'number', description: '最多返回条数，默认 10' },
          type: { type: 'string', description: '只检索某类条目：session_digest / work_record / work_diff / long_term' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args) {
        const { port, root } = await openMemory(hostCtx);
        const { docs } = await readAllDocs(port, root);
        const result = searchEntries(docs, String(args.query || ''), {
          limit: Number(args.limit) || 10,
          type: args.type || undefined,
        });
        return {
          query: args.query,
          total: result.total ?? result.hits.length,
          hits: result.hits.map((hit) => ({
            id: hit.id,
            file: hit.file,
            title: hit.title,
            type: hit.type,
            eventTime: hit.eventTime,
            freshness: hit.freshness,
            status: hit.status,
            score: hit.score,
            full: hit.full,
            snippet: hit.snippet,
          })),
          message: result.hits.length === 0 ? '无可用记忆' : undefined,
        };
      },
    })), 'dsh-memory: tool memory_search');

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_get',
      description: '按 id 取出某条记忆的完整正文与字段。检索命中后需要细节时使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆条目 id，例如 SG-2026-10-23-155321' } },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args) {
        const id = String(args.id || '');
        const { port, root } = await openMemory(hostCtx);
        const { docs } = await readAllDocs(port, root);
        const found = docs.find((doc) => doc.entry.id === id);
        if (!found) return { found: false, id, message: '无可用记忆' };
        return {
          found: true,
          id,
          file: found.file,
          title: found.entry.title,
          fields: found.entry.fieldMap,
          body: found.entry.bodyLines.join('\n'),
        };
      },
    })), 'dsh-memory: tool memory_get');

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_status',
      description: '查看记忆库概况：目录、文件数、条目数、启动包 token、待确认冲突与已替代条目。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const { port, root, workspace } = await openMemory(hostCtx);
        const files = await listMemoryFiles(port, root);
        const { docs } = await readAllDocs(port, root);
        const conflicts = await collectConflictStats(port, root, files);
        return {
          memoryRoot: root,
          workspace,
          files: files.length,
          entries: docs.length,
          index: { tokens: indexCache.tokens || 0, generatedAt: indexCache.at },
          conflicts,
        };
      },
    })), 'dsh-memory: tool memory_status');

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_propose',
      description: '提议把用户的某句原话记为长期要点（偏好/约束/目标/事实）。必须逐字摘引：quote 要能在本会话用户原话里原样找到，value 必须是 quote 的子串。提案先落为 pending，用户确认后才生效。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '最多 5 条',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['preference', 'constraint', 'goal', 'fact'] },
                value: { type: 'string', description: '要点内容，必须是 quote 的子串' },
                quote: { type: 'string', description: '用户原话，逐字，不得改写' },
              },
              required: ['kind', 'value', 'quote'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      async run(args, exec) {
        const agentId = exec && exec.agent && exec.agent.id;
        if (!agentId) return { ok: false, error: '没有会话上下文，无法校验逐字摘引' };

        const { port, root, timezone, config } = await openMemory(hostCtx);
        const snapshot = await hostCtx.sessionQuery.readSession(agentId);
        const messages = extractMessages(snapshot.events, toIso(timezone));
        const corpus = messages.filter((message) => message.role === 'user').map((message) => message.text).join('\n');
        if (!corpus.trim()) return { ok: false, error: '本会话还没有用户发言，无法摘引' };

        const items = (Array.isArray(args.items) ? args.items : []).slice(0, MAX_PROPOSALS);
        const valid = [];
        const rejected = [];
        for (const item of items) {
          const verdict = validateProposal(item, corpus);
          if (verdict.ok) valid.push(verdict);
          else rejected.push({ item, reason: verdict.reason });
        }

        if (valid.length === 0) {
          return { ok: false, accepted: [], rejected, error: '没有一条通过逐字校验（quote 必须能在用户原话里找到）' };
        }

        const now = new Date();
        const at = isoSeconds(now, timezone);
        const base = fileStamp(now, timezone);
        const fileName = await allocateName(port, root, base);
        const stampFor = fileName.replace(/\.md$/, '');
        const entries = buildProposalEntries(valid, { savedAt: at, timezone, stamp: stampFor, seqStart: 1 });
        await port.writeText(`${root}/${fileName}`, buildProposalFileText(entries, { at }), { kind: 'createIfAbsent' });

        const refreshed = await readAllDocs(port, root);
        await refreshIndex(port, root, config, refreshed.docs);
        await appendAudit(port, root, {
          op: 'propose', at, actor: 'model', result: 'ok', entries: entries.length, source: 'session',
          detail: `ids=${entries.map((entry) => entry.id).join(',')} rejected=${rejected.length}`,
        });

        return {
          ok: true,
          file: fileName,
          accepted: entries.map((entry) => ({ id: entry.id, kind: entry.fieldMap.kind, value: entry.fieldMap.value })),
          rejected,
          note: '这些是 pending 提案，需要用户确认后才会生效（调用 memory_confirm）。',
        };
      },
    })), 'dsh-memory: tool memory_propose');

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_confirm',
      description: '确认或拒绝 pending 的记忆提案。accept 会转为 current，若与现有长期要点冲突则保持 pending 并标冲突；reject 会转为 deprecated。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '提案 / 记忆条目 id' },
          decision: { type: 'string', enum: ['accept', 'reject'] },
        },
        required: ['ids', 'decision'],
        additionalProperties: false,
      },
      async run(args) {
        const ids = (Array.isArray(args.ids) ? args.ids : []).map(String);
        const decision = args.decision === 'reject' ? 'reject' : 'accept';
        return confirmPending(hostCtx, ids, decision, 'chat', async (docs) => {
          const mem = await openMemory(hostCtx);
          await refreshIndex(mem.port, mem.root, mem.config, docs);
        });
      },
    })), 'dsh-memory: tool memory_confirm');

    hostCtx.effect(() => hostCtx.tools.register(defineTool({
      name: 'memory_describe_media',
      description: '为 pending 的多媒体记忆补一段文本描述。只写可观察到的事实与用户明确说明的意图；不推测图中未出现的内容、不编造细节。原始文件不会被保存。',
      parameters: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: '多媒体记忆的 media_source' },
          description: { type: 'string', description: '简要、客观的描述' },
          model: { type: 'string', description: '实际产出描述的模型标识，默认 deepseek-flash' },
        },
        required: ['attachmentId', 'description'],
        additionalProperties: false,
      },
      async run(args) {
        const { port, root, config, timezone } = await openMemory(hostCtx);
        const { docs } = await readAllDocs(port, root);
        const found = docs.find((doc) => doc.entry.fieldMap.type === 'media_summary'
          && doc.entry.fieldMap.media_source === String(args.attachmentId || ''));
        if (!found) return { ok: false, error: '找不到这个附件对应的记忆条目' };
        if (found.entry.fieldMap.media_desc_status === 'current') {
          return { ok: false, error: '这条已经有描述了', id: found.entry.id };
        }

        const at = isoSeconds(new Date(), timezone);
        await updateEntryInFile(port, root, found.file, found.entry.id, (entry) => {
          applyDescription(entry, args.description, { model: args.model || 'deepseek-flash', at });
        });
        const after = await readAllDocs(port, root);
        await refreshIndex(port, root, config, after.docs);
        await appendAudit(port, root, {
          op: 'describe', at, actor: 'model', result: 'ok', entries: 1, source: 'session',
          detail: `id=${found.entry.id} model=${args.model || 'deepseek-flash'}`,
        });
        return { ok: true, id: found.entry.id, at };
      },
    })), 'dsh-memory: tool memory_describe_media');

    // ---- 提示词：协议段 + 启动包（低 token 索引，每次装配都在） ----
    hostCtx.effect(() => hostCtx.systemPrompt.section({
      name: 'dsh-memory',
      order: 40,
      text: [
        '## 长期记忆',
        '你有本地长期记忆（Markdown，只存在用户设备的工作区里）。',
        '- 需要回忆过去的信息时调用 memory_search；命中后用 memory_get 取全文。',
        '- 检索无结果时直接回答「无可用记忆」，不要凭印象编造。',
        '- 记忆分两层：聊天记忆是抽取式摘要，工作记忆是逐字原文；后者命中时返回全文。',
        '- 用户明确说"记住…/以后都…/不要…"这类长期要求时，用 memory_propose 提议（必须逐字摘引用户原话，value 是 quote 的子串），再由用户确认。',
        '- 不要把推测写成记忆，也不要声称记得未被检索到的内容。',
      ].join('\n'),
    }), 'dsh-memory: prompt section');

    hostCtx.effect(() => hostCtx.systemPrompt.context({
      name: 'dsh-memory-index',
      order: 40,
      text: () => (indexCache.text
        ? `记忆索引（低 token 启动包，权威内容以条目正文为准）：\n${indexCache.text}`
        : '记忆为空：还没有保存过任何记忆。'),
    }), 'dsh-memory: prompt context');

    // 激活即预热启动包缓存：否则重载后的第一轮会误报「记忆为空」
    hostCtx.effect(() => {
      let alive = true;
      (async () => {
        try {
          // 装好插件就先给每个工作区建好「记忆」目录（已存在则跳过），
          // 这样用户第一次保存时一定有地方可写。
          for (const ws of listWorkspaces(hostCtx)) {
            try {
              const wsPort = createFsPort(hostCtx, ws.path);
              await ensureRoot(wsPort, resolveMemoryRoot({ configured: '', workspace: ws.path }));
            } catch (error) {
              debugLog('ensure-workspace-root', error);
            }
          }

          const { port, root, config } = await openMemory(hostCtx);
          const { docs } = await readAllDocs(port, root);
          if (alive) await refreshIndex(port, root, config, docs);
        } catch (error) {
          debugLog('warm-index', error);
        }
      })();
      return () => { alive = false; };
    }, 'dsh-memory: warm index');
    } catch (error) {
      debugLog('inject-body', error);
      throw error;
    }
  });
}

export { PURGE_HEADING };
