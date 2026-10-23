/**
 * 提示词生成器自测。
 * 运行: node test/prompt.test.js
 */
import assert from 'node:assert/strict';
import { buildPrompt, buildChatPrompt, buildWorkPrompt, promptFileName } from '../src/prompt.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const chatFiles = [
  { name: '2026-10-23_180000(ZJB).md', tag: 'ZJB' },
  { name: '2026-10-23_190000(ZJB).md', tag: 'ZJB' },
  { name: '2026-10-23_190000(full).md', tag: 'full' },
];

test('文件名：聊天与工作各自固定名', () => {
  assert.equal(promptFileName('chat'), '提示词.md');
  assert.equal(promptFileName('work'), '工作流程提示词.md');
});

test('聊天提示词：指向最新日期的总结版', () => {
  const text = buildChatPrompt({
    session: { title: '作业1', sessionId: 's1' },
    folder: '作业1',
    files: chatFiles,
    timezone: 'Asia/Shanghai',
    savedAt: '2026-10-23T19:00:00+08:00',
  });
  assert.ok(text.includes('作业1'), '应含会话名');
  assert.ok(text.includes('2026-10-23_190000(ZJB).md'), '应指向最新的 ZJB');
  assert.ok(!text.includes('读取本目录**最新日期的总结版**') || text.includes('2026-10-23_190000(ZJB).md'));
  assert.ok(text.includes('(full)'), '应说明细节回查完整版');
  assert.ok(text.includes('无可用记忆'), '应要求找不到就说没有');
});

test('聊天提示词：没有总结版时不崩、给出占位', () => {
  const text = buildChatPrompt({
    session: { title: '空会话', sessionId: 's2' },
    folder: '空会话',
    files: [{ name: '2026-10-23_180000(full).md', tag: 'full' }],
    timezone: 'Asia/Shanghai',
    savedAt: '2026-10-23T19:00:00+08:00',
  });
  assert.ok(text.includes('暂无'), text);
});

test('工作提示词：列出逐字卷与 diff，并要求自己读同目录', () => {
  const text = buildWorkPrompt({
    session: { title: '插件开发', sessionId: 's3' },
    folder: '插件开发',
    files: [
      { name: '2026-10-23_180000.md', tag: 'work' },
      { name: '2026-10-23_180000_2.md', tag: 'work' },
      { name: '2026-10-23_180000(diff).md', tag: 'diff' },
    ],
    timezone: 'Asia/Shanghai',
    savedAt: '2026-10-23T19:00:00+08:00',
  });
  assert.ok(text.includes('2026-10-23_180000.md'));
  assert.ok(text.includes('2026-10-23_180000(diff).md'));
  assert.ok(text.includes('同级'), '应说明文件在同级目录');
  assert.ok(text.includes('工作流'), '应含工作流步骤');
});

test('buildPrompt: 按类型分派', () => {
  const input = {
    session: { title: 'x', sessionId: 's4' },
    folder: 'x',
    files: chatFiles,
    timezone: 'Asia/Shanghai',
    savedAt: '2026-10-23T19:00:00+08:00',
  };
  assert.ok(buildPrompt('chat', input).includes('聊天记忆'));
  assert.ok(buildPrompt('work', input).includes('工作记忆'));
});

console.log(`\n[prompt] passed: ${passed}, failed: ${failures.length}`);
for (const failure of failures) {
  console.log(`\nFAIL: ${failure.name}`);
  console.log(String(failure.error && failure.error.stack ? failure.error.stack : failure.error).split('\n').slice(0, 4).join('\n'));
}
if (failures.length > 0) process.exitCode = 1;
