// 从 TypeScript 源码里取出一个函数并原样转译求值的工具。
//
// 为什么需要它：`desktop/src` 里有几段纯判定逻辑（登录落点、目录范围边界、
// 断点续采的起始页）是模块内私有函数，没有导出，也不适合为了测试而导出。
// 文本匹配只能证明"代码里出现过某个字符串"，证明不了行为；复制一份逻辑
// 又会跟实现漂移。所以这里把源码里的函数原样截出来、交给 TypeScript 编译器
// 转译，再求值成真实函数——测的是实现本身。

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');

// extractFunction 按花括号配平，从源码里取出一个函数声明（含 TS 类型标注）。
//
// 三个必须注意的点：
// 1. 必须带上 `async` 前缀。只截 `function name(...)` 会丢掉 async，
//    函数体里的 await 就成了语法错误，转译后整个函数消失。
// 2. 不能直接找第一个 `{`。参数里的类型标注（例如 `options: { maxMs?: number }`）
//    也含花括号，会把函数体截断；要先按圆括号配平跳过参数表。
// 3. 返回值类型标注也可能带花括号（`): { item: X | null } {`）。参数表之后的
//    第一个 `{` 若是这种类型字面量，它闭合后紧跟的 `{` 才是函数体。
function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start >= 0) {
    const exported = source.lastIndexOf('export ', start);
    if (exported >= 0 && source.slice(exported, start).trim() === 'export') start = exported;
  } else {
    start = source.indexOf(`function ${name}(`);
  }
  if (start < 0) throw new Error(`源码里找不到 function ${name}`);
  const paramsOpen = source.indexOf('(', start);
  if (paramsOpen <= start) throw new Error(`function ${name} 缺少参数表`);
  const paramsClose = matchingIndex(source, paramsOpen, '(', ')');
  if (paramsClose < 0) throw new Error(`function ${name} 的参数表没有配平`);
  let open = source.indexOf('{', paramsClose);
  if (open < 0) throw new Error(`function ${name} 缺少函数体`);
  // 候选 `{` 若是返回值类型字面量，它闭合之后紧跟的 `{` 才是函数体。
  const candidateClose = matchingIndex(source, open, '{', '}');
  if (candidateClose > open) {
    const next = source.slice(candidateClose + 1).match(/^\s*\{/);
    if (next) open = candidateClose + 1 + next[0].length - 1;
  }
  const close = matchingIndex(source, open, '{', '}');
  if (close < 0) throw new Error(`function ${name} 的花括号没有配平`);
  return source.slice(start, close + 1);
}

// matchingIndex 返回与 openIndex 处括号配对的那个下标，找不到返回 -1。
function matchingIndex(source, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// loadFunction 转译后求值，返回真实函数对象。
// prelude 用来补齐被依赖的模块内函数（例如 delay）。
function loadFunction(file, name, prelude = []) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const parts = prelude.map((dep) => extractFunction(source, dep));
  parts.push(extractFunction(source, name));
  const js = ts.transpileModule(parts.join('\n\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn ${name};`)();
}

// readSource 读一个源码文件，供只做文本断言的用例使用。
function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

module.exports = { ROOT, extractFunction, loadFunction, readSource };
