import assert from 'node:assert/strict';
import { createSuite, memoryIO } from './harness.js';
import { isoSeconds, fileStamp } from '../src/time.js';
import {
  DEFAULT_CONFIG,
  MEMORY_DIR_NAME,
  resolveMemoryRoot,
  parseMemoryFileName,
  listMemoryFiles,
  listMemoryFolders,
  sanitizeFolderName,
  ensureRoot,
  allocateName,
  writeNewMemoryFile,
  parseConfigText,
  loadConfig,
  renderConfigText,
  saveConfig,
} from '../src/store.js';

const { test, testAsync, report } = createSuite('store');

const ROOT = `/ws/${MEMORY_DIR_NAME}`;

// ---------------------------------------------------------------- path

test('resolveMemoryRoot: 默认落在工作区下的记忆目录', () => {
  assert.equal(resolveMemoryRoot({ configured: '', workspace: 'D:\\ws' }), 'D:\\ws/记忆');
  assert.equal(resolveMemoryRoot({ configured: '', workspace: 'D:\\ws\\' }), 'D:\\ws/记忆');
});

test('resolveMemoryRoot: 显式配置优先', () => {
  assert.equal(resolveMemoryRoot({ configured: 'E:\\mem', workspace: 'D:\\ws' }), 'E:\\mem');
});

test('parseMemoryFileName: (full) 后缀与三种 tag 互斥', () => {
  const full = parseMemoryFileName('2026-10-23_181044(full).md');
  assert.equal(full.full, true);
  assert.equal(full.summary, false);
  assert.equal(full.diff, false);
  assert.equal(full.tag, 'full');
  const summary = parseMemoryFileName('2026-10-23_181044(ZJB).md');
  assert.equal(summary.tag, 'ZJB');
  const diff = parseMemoryFileName('2026-10-23_181044(diff)_2.md');
  assert.equal(diff.tag, 'diff');
  assert.equal(diff.part, 2);
});

test('parseMemoryFileName: (diff) 后缀与分卷组合', () => {
  const base = parseMemoryFileName('2026-10-23_180909(diff).md');
  assert.equal(base.diff, true);
  assert.equal(base.summary, false);
  assert.equal(base.part, 1);
  const part = parseMemoryFileName('2026-10-23_180909(diff)_3.md');
  assert.equal(part.diff, true);
  assert.equal(part.part, 3);
  assert.equal(parseMemoryFileName('2026-10-23_180909.md').diff, false);
});

test('parseMemoryFileName: 总结版带 (ZJB) 后缀', () => {
  const zjb = parseMemoryFileName('2026-10-23_152912(ZJB).md');
  assert.equal(zjb.summary, true);
  assert.equal(zjb.part, 1);
  const part = parseMemoryFileName('2026-10-23_152912(ZJB)_2.md');
  assert.equal(part.summary, true);
  assert.equal(part.part, 2);
  assert.equal(parseMemoryFileName('2026-10-23_152912.md').summary, false);
});

test('parseMemoryFileName: 只认数字/连字符/下划线', () => {
  assert.deepEqual(
    { ...parseMemoryFileName('2026-10-23_152912.md'), name: undefined },
    { name: undefined, date: '2026-10-23', stamp: '152912', part: 1, sortKey: '2026-10-23_152912', tag: '', summary: false, diff: false, full: false },
  );
  assert.equal(parseMemoryFileName('2026-10-23_152912_2.md').part, 2);
  assert.equal(parseMemoryFileName('_config.md'), null);
  assert.equal(parseMemoryFileName('_index.md'), null);
  assert.equal(parseMemoryFileName('2026-10-23_152912_work.md'), null, '带字母的后缀不属于记忆文件');
});

await testAsync('listMemoryFiles: 只列记忆文件且最新在前', async () => {
  const io = memoryIO({
    [`${ROOT}/2026-10-21_090000.md`]: 'a',
    [`${ROOT}/2026-10-23_152912.md`]: 'bb',
    [`${ROOT}/2026-10-23_152912_2.md`]: 'ccc',
    [`${ROOT}/_系统/_config.md`]: 'x',
    [`${ROOT}/notes.txt`]: 'y',
  });
  const files = await listMemoryFiles(io, ROOT);
  assert.deepEqual(files.map((file) => file.name), [
    '2026-10-23_152912_2.md',
    '2026-10-23_152912.md',
    '2026-10-21_090000.md',
  ]);
});

// ---------------------------------------------------------------- write

await testAsync('ensureRoot: 目录不存在时创建', async () => {
  const io = memoryIO({});
  await ensureRoot(io, ROOT);
  assert.equal((await io.stat(ROOT)).type, 'directory');
});

await testAsync('ensureRoot: 路径被文件占用时报错', async () => {
  const io = memoryIO({ [ROOT]: 'oops' });
  await assert.rejects(() => ensureRoot(io, ROOT), /不是目录/);
});

await testAsync('allocateName: 同秒已占用则追加序号', async () => {
  const io = memoryIO({ [`${ROOT}/2026-10-23_152912.md`]: 'a', [`${ROOT}/2026-10-23_152912_2.md`]: 'b' });
  assert.equal(await allocateName(io, ROOT, '2026-10-23_152912'), '2026-10-23_152912_3.md');
});

await testAsync('writeNewMemoryFile: 绝不覆盖已有文件', async () => {
  const io = memoryIO({ [`${ROOT}/2026-10-23_152912.md`]: 'OLD' });
  const result = await writeNewMemoryFile(io, ROOT, '2026-10-23_152912', 'NEW');
  assert.equal(result.name, '2026-10-23_152912_2.md');
  assert.equal(io.files.get(`${ROOT}/2026-10-23_152912.md`), 'OLD');
  assert.equal(io.files.get(`${ROOT}/2026-10-23_152912_2.md`), 'NEW');
});

await testAsync('writeNewMemoryFile: 并发抢同一名字时重试到下一个序号', async () => {
  const io = memoryIO({});
  // 让存在性检查全部落空，只在写入时报冲突，模拟并发
  const racing = {
    ...io,
    async stat(path) { return path.endsWith('.md') ? undefined : io.stat(path); },
    async writeText(path, content, intent) {
      if (path.endsWith('_152912.md')) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
      return io.writeText(path, content, intent);
    },
    async listDir(path) { return io.listDir(path); },
  };
  const result = await writeNewMemoryFile(racing, ROOT, '2026-10-23_152912', 'NEW');
  assert.equal(result.name, '2026-10-23_152912_2.md');
});

// ---------------------------------------------------------------- config

test('parseConfigText: 分节 + 键值列表', () => {
  const parsed = parseConfigText([
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    '---',
    '',
    '## 配置项',
    '',
    '- timezone: Asia/Shanghai',
    '- summary_char_budget: 500',
    '- 自定义键: 保留我',
  ].join('\n'));
  assert.equal(parsed.frontMatter.format, 'dsh-memory');
  assert.deepEqual(parsed.entries.map((entry) => entry.key), ['timezone', 'summary_char_budget']);
  assert.equal(parsed.entries[0].value, 'Asia/Shanghai');
});

test('parseConfigText: front matter 多余字段被标记但保留', () => {
  const parsed = parseConfigText('---\nmemory_format: dsh-memory\nformat_version: 1\nextra: 1\n---\n');
  assert.equal(parsed.frontMatter.extra.length, 1);
  assert.ok(parsed.issues.some((issue) => issue.code === 'CONFIG_FM_UNEXPECTED_KEY'));
});

await testAsync('loadConfig: 配置缺失时全部取默认并标注', async () => {
  const io = memoryIO({});
  const loaded = await loadConfig(io, ROOT);
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.defaultsUsed.sort(), Object.keys(DEFAULT_CONFIG).sort());
  assert.equal(loaded.values.summary_char_budget, DEFAULT_CONFIG.summary_char_budget);
  assert.ok(loaded.issues.some((issue) => issue.code === 'CONFIG_MISSING'));
});

await testAsync('loadConfig: 缺项取默认、未知项保留、非法数字回退', async () => {
  const io = memoryIO({
    [`${ROOT}/_系统/_config.md`]: [
      '---', 'memory_format: dsh-memory', 'format_version: 1', '---', '',
      '## 配置项', '',
      '- timezone: Asia/Tokyo',
      '- summary_char_budget: 不准',
      '- my_key: keep-me',
    ].join('\n'),
  });
  const loaded = await loadConfig(io, ROOT);
  assert.equal(loaded.values.timezone, 'Asia/Tokyo');
  assert.equal(loaded.values.summary_char_budget, DEFAULT_CONFIG.summary_char_budget);
  assert.ok(loaded.defaultsUsed.includes('summary_char_budget'));
  assert.ok(!loaded.defaultsUsed.includes('timezone'));
  assert.deepEqual(loaded.unknownKeys, ['my_key']);
  assert.ok(loaded.issues.some((issue) => issue.code === 'CONFIG_UNKNOWN_KEY'));
  assert.ok(loaded.issues.some((issue) => issue.code === 'CONFIG_VALUE_INVALID'));
});

await testAsync('saveConfig -> loadConfig 往返一致，未知键不丢', async () => {
  const io = memoryIO({});
  const values = { ...DEFAULT_CONFIG, timezone: 'Asia/Tokyo', summary_char_budget: 480, my_key: 'keep' };
  await saveConfig(io, ROOT, values);
  const loaded = await loadConfig(io, ROOT);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.values.timezone, 'Asia/Tokyo');
  assert.equal(loaded.values.summary_char_budget, 480);
  assert.deepEqual(loaded.unknownKeys, ['my_key']);
  assert.deepEqual(loaded.defaultsUsed, []);
});

test('renderConfigText: 值一律写成字符串', () => {
  const text = renderConfigText({ ...DEFAULT_CONFIG, summary_char_budget: 480 });
  assert.ok(text.includes('- summary_char_budget: 480'));
  assert.ok(text.includes('memory_format: dsh-memory'));
  assert.ok(!/\[|\{/.test(text), '不应出现 YAML 数组或对象');
});

// ---------------------------------------------------------------- time

test('isoSeconds: 带时区偏移，精确到秒', () => {
  const date = new Date('2026-10-23T07:29:12Z');
  assert.equal(isoSeconds(date, 'Asia/Shanghai'), '2026-10-23T15:29:12+08:00');
  assert.equal(isoSeconds(date, 'UTC'), '2026-10-23T07:29:12+00:00');
});

test('fileStamp: YYYY-MM-DD_HHmmss', () => {
  assert.equal(fileStamp(new Date('2026-10-23T07:29:12Z'), 'Asia/Shanghai'), '2026-10-23_152912');
});

await testAsync('listMemoryFiles: 支持一层子目录，name 是相对路径', async () => {
  const io = memoryIO({
    [`${ROOT}/作业1/2026-10-23_170000.md`]: 'a',
    [`${ROOT}/作业1/2026-10-23_170100.md`]: 'b',
    [`${ROOT}/2026-10-22_090000.md`]: 'c',
    [`${ROOT}/_index.md`]: 'x',
  });
  await io.mkdir(`${ROOT}/作业1`);
  const files = await listMemoryFiles(io, ROOT);
  assert.deepEqual(files.map((f) => f.name), [
    '作业1/2026-10-23_170100.md',
    '作业1/2026-10-23_170000.md',
    '2026-10-22_090000.md',
  ]);
  assert.equal(files[0].dir, '作业1');
  assert.equal(files[2].dir, '');
});

await testAsync('listMemoryFolders: 只返回目录，忽略点目录', async () => {
  const io = memoryIO({ [`${ROOT}/a/x.md`]: 'x' });
  await io.mkdir(`${ROOT}/a`);
  await io.mkdir(`${ROOT}/.cache`);
  const folders = await listMemoryFolders(io, ROOT);
  assert.deepEqual(folders, ['a']);
  assert.equal(sanitizeFolderName('作业 1/2'), '作业 12');
});

test('sanitizeFolderName: 末尾的点与空格会被去掉（否则 Windows 打不开）', () => {
  assert.equal(sanitizeFolderName('你来开发一个你自己用的插件.'), '你来开发一个你自己用的插件');
  assert.equal(sanitizeFolderName('  作业1 . . '), '作业1');
  assert.equal(sanitizeFolderName('a/b:c'), 'abc');
  assert.equal(sanitizeFolderName('CON'), 'CON_');
  assert.equal(sanitizeFolderName('   '), '未命名');
  assert.equal(sanitizeFolderName('...'), '未命名');
});

process.exitCode = report() > 0 ? 1 : 0;
