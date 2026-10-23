/**
 * 存储层：目录、文件名、`_config.md`、原子写。
 *
 * 全部函数只依赖一个极小的 IO 端口（stat / readText / writeText / listDir / mkdir），
 * 因此可以离线测试；插件里再用 ctx.fs 适配这个端口。
 *
 * 规格要点：
 * - 每次手动保存生成独立文件，`YYYY-MM-DD_HHmmss.md`，同秒追加 `_2`、`_3`，绝不覆盖；
 * - 文件名只用数字、连字符、下划线；
 * - `_config.md` 的 front matter 只允许 memory_format / format_version，
 *   其余配置是 `## 配置项` 下的 `- key: value`，值一律字符串；
 * - 缺项取内置默认并标 config_default_used，未知项保留并标 config_unknown_key。
 */

export const MEMORY_FORMAT = 'dsh-memory';
export const FORMAT_VERSION = 1;
export const MEMORY_DIR_NAME = '记忆';
export const CONFIG_FILE = '_config.md';
export const INDEX_FILE = '_index.md';
export const AUDIT_FILE = '_audit.md';

/**
 * 插件自己的文件（配置 / 索引缓存 / 审计）统一放在这个子目录里，
 * 免得在记忆根目录里被当成"没用的文件"删掉。
 */
export const SYSTEM_DIR = '_系统';

/** 系统文件的完整路径 */
export function systemPath(root, name) {
  return `${root}/${SYSTEM_DIR}/${name}`;
}

/** 记忆文件名：2026-10-23_152912.md / 2026-10-23_152912_2.md */
export const SUMMARY_SUFFIX = '(ZJB)';

/** 总结版文件名带 (ZJB) 后缀，例如 2026-10-23_171028(ZJB).md；重复保存追加 _2 */
export const MEMORY_FILE_RE = /^(\d{4}-\d{2}-\d{2})_(\d{6})(?:\((ZJB|diff|full)\))?(?:_(\d+))?\.md$/;

/** 内置默认配置；顺序即写盘顺序 */
export const DEFAULT_CONFIG = {
  memory_root: '',
  active_workspace: '',
  timezone: 'Asia/Shanghai',
  summary_char_budget: 600,
  startup_token_budget: 800,
  full_weight_days: 20,
  purge_after_days: 20,
  half_life_days: 30,
  weight_floor: 5,
  max_file_bytes: 262144,
  max_file_lines: 2000,
  period_chain_threshold: 10,
  default_memory_class: 'chat',
};

const NUMERIC_KEYS = new Set(
  Object.keys(DEFAULT_CONFIG).filter((key) => typeof DEFAULT_CONFIG[key] === 'number'),
);

export function resolveMemoryRoot({ configured, workspace }) {
  if (configured && String(configured).trim() !== '') return String(configured).trim();
  return `${String(workspace).replace(/[\\/]+$/, '')}/${MEMORY_DIR_NAME}`;
}

/** 文件名解析；非记忆文件返回 null */
export function parseMemoryFileName(name) {
  const match = MEMORY_FILE_RE.exec(name);
  if (!match) return null;
  return {
    name,
    date: match[1],
    stamp: match[2],
    part: match[4] === undefined ? 1 : Number(match[4]),
    tag: match[3] || '',
    summary: match[3] === 'ZJB',
    diff: match[3] === 'diff',
    full: match[3] === 'full',
    sortKey: `${match[1]}_${match[2]}`,
  };
}

/**
 * 目录里属于记忆的文件，按时间倒序（最新在前）。
 *
 * 支持一层子目录：`记忆/作业1/2026-10-23_170043.md`。
 * 返回的 `name` 是**相对记忆根的路径**（含子目录），调用方直接用 `${root}/${name}` 即可。
 */
export async function listMemoryFiles(io, root) {
  const entries = await io.listDir(root);
  const files = [];

  for (const entry of entries) {
    if (entry.type === 'file') {
      const parsed = parseMemoryFileName(entry.name);
      if (parsed) files.push({ ...parsed, dir: '', size: entry.size });
      continue;
    }
    if (entry.type !== 'directory') continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

    let children;
    try {
      children = await io.listDir(`${root}/${entry.name}`);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.type !== 'file') continue;
      const parsed = parseMemoryFileName(child.name);
      if (!parsed) continue;
      files.push({ ...parsed, name: `${entry.name}/${child.name}`, dir: entry.name, size: child.size });
    }
  }

  files.sort((a, b) => (a.sortKey === b.sortKey ? b.part - a.part : a.sortKey < b.sortKey ? 1 : -1));
  return files;
}

/** 列出已有的记忆文件夹（一层） */
export async function listMemoryFolders(io, root) {
  let entries;
  try {
    entries = await io.listDir(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

/** Windows 保留设备名，不能当目录名 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 文件夹名清洗。
 *
 * Windows 会**剥掉目录名末尾的点和空格**：如果按 "xxx." 建目录，
 * 资源管理器按 "xxx" 打不开，等于把记忆写进了一个打不开的文件夹。
 * 所以这里必须把末尾的点和空格去掉，并挡掉保留设备名。
 */
export function sanitizeFolderName(raw, fallback = '未命名') {
  let cleaned = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    // 末尾的点与空格一律去掉（关键：否则目录在资源管理器里打不开）
    .replace(/[. ]+$/g, '')
    .trim();

  if (!cleaned) return fallback;
  if (RESERVED_NAMES.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned;
}

/** 确保目录存在 */
export async function ensureRoot(io, root) {
  const existing = await io.stat(root);
  if (existing && existing.type === 'directory') return root;
  if (existing && existing.type !== 'directory') {
    throw new Error(`记忆路径被占用且不是目录: ${root}`);
  }
  await io.mkdir(root);
  const after = await io.stat(root);
  if (!after || after.type !== 'directory') throw new Error(`无法创建记忆目录: ${root}`);
  return root;
}

/** 判断"目标已存在"这类错误，用于同名重试 */
export function isExistsError(error) {
  const code = error && error.code;
  if (code === 'EEXIST' || code === 'FS_EXISTS' || code === 'FS_ALREADY_EXISTS') return true;
  return /exist|已存在/i.test(String((error && error.message) || error));
}

/**
 * 分配一个尚未被占用的文件名。
 * 只判断"当前是否存在"，真正的防覆盖靠写入时的 createIfAbsent。
 */
export async function allocateName(io, root, base, maxAttempts = 99) {
  for (let part = 1; part <= maxAttempts; part += 1) {
    const name = part === 1 ? `${base}.md` : `${base}_${part}.md`;
    const found = await io.stat(`${root}/${name}`);
    if (!found) return name;
  }
  throw new Error(`同名文件过多，拒绝继续: ${base}`);
}

/**
 * 写一个新记忆文件，永不覆盖。
 * 冲突时自动换下一个序号重试（存在性检查与写入之间可能有并发）。
 */
export async function writeNewMemoryFile(io, root, base, content, options = {}) {
  const maxAttempts = options.maxAttempts ?? 99;
  await ensureRoot(io, root);
  for (let part = 1; part <= maxAttempts; part += 1) {
    const name = part === 1 ? `${base}.md` : `${base}_${part}.md`;
    try {
      await io.writeText(`${root}/${name}`, content, { kind: 'createIfAbsent' });
      return { name, path: `${root}/${name}`, part };
    } catch (error) {
      if (isExistsError(error)) continue;
      throw error;
    }
  }
  throw new Error(`同名文件过多，拒绝继续: ${base}`);
}

// ---------------------------------------------------------------- config

/** 解析 `_config.md` */
export function parseConfigText(text) {
  const issues = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');

  let index = 0;
  let frontMatter = { format: undefined, version: undefined, extra: [] };
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (/^---\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end < 0) {
      issues.push({ code: 'CONFIG_FM_UNTERMINATED', message: 'front matter 没有结束标记' });
    } else {
      for (const line of lines.slice(1, end)) {
        if (line.trim() === '') continue;
        const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) {
          issues.push({ code: 'CONFIG_FM_UNPARSED', message: `无法解析的 front matter 行: ${line}` });
          continue;
        }
        const key = match[1];
        const value = match[2].trim().replace(/^["']|["']$/g, '');
        if (key === 'memory_format') frontMatter.format = value;
        else if (key === 'format_version') frontMatter.version = value;
        else {
          frontMatter.extra.push({ key, value });
          issues.push({ code: 'CONFIG_FM_UNEXPECTED_KEY', message: `front matter 只允许两个字段，已保留: ${key}` });
        }
      }
      index = end + 1;
    }
  } else {
    issues.push({ code: 'CONFIG_NO_FRONT_MATTER', message: '配置缺少 front matter' });
  }

  const entries = [];
  const extraSectionsRaw = [];
  let current = null;
  let inConfig = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      inConfig = /配置项/.test(title);
      current = null;
      if (!inConfig) {
        current = { title, lines: [line] };
        extraSectionsRaw.push(current);
      } else {
        extraSectionsRaw.push(null);
      }
      continue;
    }
    if (current) {
      current.lines.push(line);
      continue;
    }
    if (!inConfig) continue;
    if (line.trim() === '') continue;
    const match = /^-\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      issues.push({ code: 'CONFIG_UNPARSED_LINE', message: `配置项格式不对: ${line}` });
      continue;
    }
    entries.push({ key: match[1], value: match[2].trim() });
  }

  const sections = extraSectionsRaw.filter(Boolean).map((section) => section.lines.join('\n'));
  return { frontMatter, entries, extraSections: sections, issues };
}

function coerceValue(key, raw, issues) {
  if (NUMERIC_KEYS.has(key)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      issues.push({ code: 'CONFIG_VALUE_INVALID', message: `${key} 不是数字，已回退默认: ${raw}` });
      return { value: DEFAULT_CONFIG[key], used: true };
    }
    return { value, used: false };
  }
  return { value: raw, used: false };
}

/**
 * 读取配置并与默认值合并。
 * @returns {{values: object, defaultsUsed: string[], unknownKeys: string[], issues: object[], exists: boolean, extraSections: string[]}}
 */
export async function loadConfig(io, root) {
  const path = systemPath(root, CONFIG_FILE);
  const found = await io.stat(path);
  if (!found) {
    return {
      values: { ...DEFAULT_CONFIG },
      defaultsUsed: Object.keys(DEFAULT_CONFIG),
      unknownKeys: [],
      issues: [{ code: 'CONFIG_MISSING', message: '配置文件不存在，全部使用内置默认' }],
      exists: false,
      extraSections: [],
    };
  }
  const parsed = parseConfigText(await io.readText(path));
  const issues = [...parsed.issues];
  const byKey = new Map(parsed.entries.map((entry) => [entry.key, entry.value]));
  const values = {};
  const defaultsUsed = [];
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (byKey.has(key)) {
      const { value, used } = coerceValue(key, byKey.get(key), issues);
      values[key] = value;
      if (used) defaultsUsed.push(key);
    } else {
      values[key] = DEFAULT_CONFIG[key];
      defaultsUsed.push(key);
    }
  }
  const unknownKeys = parsed.entries.filter((entry) => !(entry.key in DEFAULT_CONFIG)).map((entry) => entry.key);
  for (const key of unknownKeys) {
    issues.push({ code: 'CONFIG_UNKNOWN_KEY', message: `未知配置项已保留: ${key}` });
  }
  return { values, defaultsUsed, unknownKeys, issues, exists: true, extraSections: parsed.extraSections };
}

/** 生成 `_config.md` 文本（值一律字符串） */
export function renderConfigText(values, options = {}) {
  const lines = ['---', `memory_format: ${MEMORY_FORMAT}`, `format_version: ${FORMAT_VERSION}`];
  for (const extra of options.frontExtra || []) lines.push(`${extra.key}: ${extra.value}`);
  lines.push('---', '', '## 配置项', '');

  const merged = { ...values };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (merged[key] === undefined) merged[key] = DEFAULT_CONFIG[key];
  }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const raw = merged[key];
    lines.push(`- ${key}: ${raw === null || raw === undefined ? '' : String(raw)}`);
  }
  for (const key of Object.keys(merged)) {
    if (key in DEFAULT_CONFIG) continue;
    lines.push(`- ${key}: ${merged[key] === null || merged[key] === undefined ? '' : String(merged[key])}`);
  }

  for (const section of options.extraSections || []) {
    lines.push('', section);
  }
  return lines.join('\n') + '\n';
}

/** 写入配置：已存在则整份替换（配置是插件自有文件，不做版本守卫） */
export async function saveConfig(io, root, values, options = {}) {
  await ensureRoot(io, root);
  const path = systemPath(root, CONFIG_FILE);
  await io.writeText(path, renderConfigText(values, options));
  return path;
}
