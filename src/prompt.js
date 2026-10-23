/**
 * 提示词生成：保存记忆时顺手产出，供用户只导入这一个文件。
 *
 * 两类：
 * - 聊天记忆：交代 AI 的性格/风格，并指引它"没有记忆时读同目录最新的 (ZJB)，再不行读 (full)"。
 * - 工作记忆：交代工作流与框架，指引它读同目录的逐字卷与 (diff)。
 *
 * 提示词本身不是记忆条目：不进索引、不参与检索、不计权重。
 */

export const CHAT_PROMPT_FILE = '提示词.md';
export const WORK_PROMPT_FILE = '工作流程提示词.md';

function pickByTag(files, tag) {
  return files
    .filter((file) => file.tag === tag)
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function listLines(files, emptyText) {
  if (files.length === 0) return [`- （暂无：${emptyText}）`];
  return files.map((file) => `- ${file.name}`);
}

/** 聊天记忆的提示词 */
export function buildChatPrompt({ session, folder, files, timezone, savedAt }) {
  const summaries = pickByTag(files, 'ZJB');
  const fulls = pickByTag(files, 'full');
  const newest = summaries[0];

  return [
    `# 记忆恢复提示词 · 聊天记忆`,
    '',
    `- 会话：${session.title || session.sessionId}`,
    `- 记忆目录：本文件同级目录（${folder}/）`,
    `- 生成时间：${savedAt}`,
    `- 时区：${timezone}`,
    '',
    '## 你的角色',
    '你是这个工作区的长期助手，性格与说话方式请延续上面这个会话：',
    '- 直接、不客套，先给结论再给理由；',
    '- 不确定就说不确定，不编造事实、不虚构记忆；',
    '- 用户用中文时用中文回答，保持同样的技术密度。',
    '',
    '## 记忆在哪里',
    '本提示词所在文件夹里就是这个会话的记忆，按后缀区分：',
    ...listLines(summaries, '还没有总结版'),
    ...listLines(fulls, '还没有完整版'),
    '',
    '## 使用规则（重要）',
    `1. 先看你自己的记忆索引；能回答就直接回答。`,
    `2. 索引里没有、或用户问到细节 → 读取本目录**最新日期的总结版**（文件名带 (ZJB)）：${newest ? newest.name : '（暂无，跳过此步）'}`,
    `3. 总结版还不够 → 读同一时间戳的 (full) 完整逐字版，找具体原话。`,
    `4. 仍然找不到 → 明确回答「无可用记忆」，并说明查过哪个文件，不要推测。`,
    `5. 不要修改本目录里的任何记忆文件；需要新增记忆时提醒用户去记忆页面保存。`,
    '',
    '## 用户怎么用',
    '用户只需要导入本文件（提示词.md），不需要再导入任何记忆文件。',
  ].join('\n');
}

/** 工作记忆的提示词 */
export function buildWorkPrompt({ session, folder, files, timezone, savedAt }) {
  const works = pickByTag(files, 'work');
  const diffs = pickByTag(files, 'diff');

  return [
    `# 记忆恢复提示词 · 工作记忆`,
    '',
    `- 会话：${session.title || session.sessionId}`,
    `- 记忆目录：本文件同级目录（${folder}/）`,
    `- 生成时间：${savedAt}`,
    `- 时区：${timezone}`,
    '',
    '## 你的角色',
    '你是这个工作区的开发助手。做事顺序固定为：先看现状 → 再改 → 改完自检 → 报告做了什么、没做什么。',
    '',
    '## 工作流（按此执行）',
    '1. **定位**：先读本目录的逐字卷，找到任务起点与约束；',
    '2. **对照**：读 (diff) 文件，看这次会话实际改了哪些文件、增删多少行；',
    '3. **复现**：需要还原细节时，按 (diff) 里的 file_path 打开对应源文件；',
    '4. **报告**：结论先行，列出改动清单与未完成项，不夸大。',
    '',
    '## 记忆在哪里',
    '本提示词所在文件夹里，逐字原文按卷存放：',
    ...listLines(works, '还没有逐字卷'),
    '',
    '代码变更单独成卷：',
    ...listLines(diffs, '这次会话没有记录到文件变更'),
    '',
    '## 使用规则（重要）',
    '1. 用户只导入了本文件，**其余文件请你自己去读**（与本文件同级）；',
    '2. 任务不清楚时，先读逐字卷里最早的一卷，确认原始目标和约束；',
    '3. 需要判断"之前改到哪"时，读最新的 (diff)；',
    '4. 找不到就说找不到，不要凭印象补全；',
    '5. 不要修改这些记忆文件。',
  ].join('\n');
}

/** 根据记忆类型选生成器 */
export function buildPrompt(kind, input) {
  return kind === 'work' ? buildWorkPrompt(input) : buildChatPrompt(input);
}

export function promptFileName(kind) {
  return kind === 'work' ? WORK_PROMPT_FILE : CHAT_PROMPT_FILE;
}
