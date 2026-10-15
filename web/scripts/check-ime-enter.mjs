import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = join(process.cwd(), 'src')
const files = []

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(path)
  }
}

function containsGuard(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'isEnterWithoutComposition') return true
  return ts.forEachChild(node, containsGuard) ?? false
}

function isEnterKeyComparison(node) {
  if (!ts.isBinaryExpression(node) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false
  const isKey = value => ts.isPropertyAccessExpression(value) && value.name.text === 'key'
  const isEnter = value => ts.isStringLiteral(value) && value.text === 'Enter'
  return (isKey(node.left) && isEnter(node.right)) || (isEnter(node.left) && isKey(node.right))
}

collect(root)
const failures = []
for (const path of files) {
  if (relative(root, path).replaceAll('\\', '/') === 'lib/keyboard.ts') continue
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  function visit(node) {
    if (isEnterKeyComparison(node)) {
      let owner = node.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      if (!owner || !containsGuard(owner)) failures.push(`${relative(root, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (failures.length) {
  console.error(`未通过输入法回车保护检查：\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('输入法回车保护检查通过')
}
