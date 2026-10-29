#!/usr/bin/env node
/**
 * 一条命令改包名，顺带把 patch 行名和文档里的旧名字一起换掉。
 *
 * DSH 的 Loader 是按**包名**解析 patch 里那一行插件的，所以
 * `package.json` 的 name 与 `cordis.patch.yml` 里的 name 必须一模一样；
 * 少改一处 → 插件在列表里有、工具一个都不出现。这个脚本把这件事一次做完。
 *
 * 用法：
 *   node scripts/rename.mjs dsh-camera
 *   node scripts/rename.mjs @yourname/dsh-camera
 *
 * 改名之后记得重装（Loader 按新名字查找）：
 *   plugin_manager remove_bundle  → 旧名字
 *   plugin_manager install_bundle → 这个包的绝对路径
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** npm 允许的包名（含 scope）。 */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

const next = process.argv[2]?.trim()

if (next === undefined || next === '' || !NAME_PATTERN.test(next)) {
  console.error('用法: node scripts/rename.mjs <新包名>')
  console.error('示例: node scripts/rename.mjs dsh-camera')
  console.error('      node scripts/rename.mjs @yourname/dsh-camera')
  process.exit(1)
}

const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const previous = pkg.name

if (previous === next) {
  console.log(`包名已经是 ${next}，没有变化。`)
  process.exit(0)
}

pkg.name = next
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`package.json      ${previous} -> ${next}`)

for (const relative of ['cordis.patch.yml', 'README.md', 'docs/PUBLISHING.md']) {
  const file = path.join(root, relative)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    continue
  }
  if (!text.includes(previous)) continue
  await writeFile(file, text.split(previous).join(next), 'utf8')
  console.log(`${relative.padEnd(17)} 同步替换`)
}

console.log('');
console.log('下一步:');
console.log(`  plugin_manager remove_bundle  target = ${previous}`);
console.log(`  plugin_manager install_bundle target = ${root}`);
