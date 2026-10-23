/** 极简测试工具：同步/异步用例、汇总报告。 */
export function createSuite(title) {
  let passed = 0;
  const failures = [];

  function test(name, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('异步用例请用 testAsync');
      passed += 1;
    } catch (error) {
      failures.push({ name, error });
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push({ name, error });
    }
  }

  function report() {
    console.log(`\n[${title}] passed: ${passed}, failed: ${failures.length}`);
    for (const failure of failures) {
      const stack = String((failure.error && failure.error.stack) || failure.error).split('\n').slice(0, 4).join('\n');
      console.log(`\nFAIL: ${failure.name}\n${stack}`);
    }
    return failures.length;
  }

  return { test, testAsync, report };
}

/** 内存文件系统，只实现 store.js 需要的五个方法。 */
export function memoryIO(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(['/']);

  const dirname = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

  return {
    files,
    dirs,
    async stat(path) {
      if (dirs.has(path)) return { type: 'directory' };
      if (files.has(path)) return { type: 'file', size: String(files.get(path)).length };
      return undefined;
    },
    async readText(path) {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    async writeText(path, content, intent) {
      if (intent && intent.kind === 'createIfAbsent' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`);
        error.code = 'EEXIST';
        throw error;
      }
      files.set(path, String(content));
    },
    async listDir(path) {
      const prefix = path === '/' ? '/' : `${path}/`;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      }
      for (const key of dirs) {
        if (key === path || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) names.add(rest);
      }
      return [...names].sort().map((name) => {
        const child = `${prefix}${name}`;
        if (dirs.has(child)) return { name, type: 'directory' };
        return { name, type: 'file', size: String(files.get(child)).length };
      });
    },
    async mkdir(path) {
      dirs.add(path);
      const parent = dirname(path);
      if (parent !== path) dirs.add(parent);
    },
  };
}
