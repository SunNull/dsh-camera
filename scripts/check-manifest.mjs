#!/usr/bin/env node
/**
 * bundle 自检：把 DSH 对 bundle 的硬性要求逐条验证一遍。
 *
 * 不联网、不装依赖，本地和 CI 跑同一份逻辑：
 *   node scripts/check-manifest.mjs
 *
 * 检查项都来自 bundle 的安装/激活契约：
 *   - package.json 是 ESM 且声明 dsh.bundle.patch
 *   - patch 里引用的文件真实存在
 *   - patch 里那行的 name 与包名一致（Loader 按包名解析，写错就静默不生效）
 *   - 导出 ./icon 且图标不超过 256 KiB
 *   - locale 里有 meta.title / meta.description（插件管理器的展示信息）
 *   - files 覆盖所有运行时文件（npm 发布/归档时不漏东西）
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))

let pkg
try {
  pkg = readJson('package.json')
} catch (error) {
  console.error(`✗ package.json 读不了: ${error.message}`)
  process.exit(1)
}

// 1. 基础形态
if (pkg.type !== 'module') problems.push('package.json: type 必须是 "module"')
if (!pkg.exports?.['.']) problems.push('package.json: 缺 exports["."]')
if (pkg.main === undefined) notes.push('package.json 没有 main 字段（有 exports 也行）')

// 2. bundle patch
const patchEntries = pkg.dsh?.bundle?.patch
const patches = Array.isArray(patchEntries) ? patchEntries : patchEntries ? [patchEntries] : []
if (patches.length === 0) problems.push('package.json: 缺 dsh.bundle.patch，DSH 不会把它当 bundle')
for (const patch of patches) {
  if (!patch.startsWith('.')) problems.push(`dsh.bundle.patch 必须是包内相对路径: ${patch}`)
  else if (!existsSync(path.join(root, patch))) problems.push(`patch 文件不存在: ${patch}`)
}

// 3. patch 行名 == 包名
const mainPatch = patches.find((patch) => patch.endsWith('.yml') || patch.endsWith('.yaml'))
if (mainPatch !== undefined && existsSync(path.join(root, mainPatch))) {
  const text = read(mainPatch)
  if (!text.includes(`name: '${pkg.name}'`) && !text.includes(`name: "${pkg.name}"`)) {
    problems.push(`${mainPatch} 里没有 name: '${pkg.name}' —— Loader 按包名解析，两处必须一致（跑 scripts/rename.mjs）`)
  }
  for (const match of text.matchAll(/name:\s*['"]?([^'"\n]+)['"]?/g)) {
    const name = match[1].trim()
    if (name === pkg.name) continue
    if (name.startsWith('@') || name.startsWith('dsh') || name.includes('/')) {
      // 允许别名/子路径行，但提醒一次
      notes.push(`${mainPatch} 里还有一行插件名: ${name}`)
    }
  }
}

// 4. 图标
if (!pkg.exports?.['./icon']) problems.push('package.json: 缺 exports["./icon"]，插件管理器会退回默认图')
else {
  const iconPath = pkg.exports['./icon'].replace(/^\.\//, '')
  if (!existsSync(path.join(root, iconPath))) problems.push(`图标文件不存在: ${iconPath}`)
  else {
    const size = statSync(path.join(root, iconPath)).size
    if (size > 256 * 1024) problems.push(`图标 ${size} 字节，超过 256 KiB 上限`)
    else notes.push(`图标 ${iconPath} ${size} 字节`)
  }
}

// 5. locale 展示信息
for (const locale of ['locale/en.json', 'locale/zh.json']) {
  if (!existsSync(path.join(root, locale))) {
    problems.push(`缺 ${locale}`)
    continue
  }
  try {
    const data = readJson(locale)
    if (!data.meta?.title) problems.push(`${locale}: 缺 meta.title`)
    if (!data.meta?.description) problems.push(`${locale}: 缺 meta.description`)
  } catch (error) {
    problems.push(`${locale}: JSON 解析失败 (${error.message})`)
  }
}

// 6. files 覆盖运行时文件
const required = ['index.js', 'cordis.patch.yml', 'icon.svg']
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of required) {
  if (!files.some((pattern) => pattern === entry || pattern.startsWith(entry.split('/')[0]))) {
    problems.push(`files 里没有覆盖 ${entry}（npm 发布/归档会漏文件）`)
  }
}
if (!files.some((pattern) => pattern === 'lib/*.js' || pattern === 'lib')) problems.push('files 里没有覆盖 lib/')
if (!files.some((pattern) => pattern.startsWith('locale/'))) problems.push('files 里没有覆盖 locale/')
for (const pattern of files) {
  const base = pattern.split('/')[0]
  if (base.includes('*') || base.includes('.')) continue
  if (!existsSync(path.join(root, base))) problems.push(`files 里列了不存在的路径: ${pattern}`)
}

// 汇总
for (const note of notes) console.log(`· ${note}`)
if (problems.length === 0) {
  console.log(`✓ bundle 自检通过: ${pkg.name}@${pkg.version}`)
  process.exit(0)
}
for (const problem of problems) console.error(`✗ ${problem}`)
console.error(`\n共 ${problems.length} 个问题`)
process.exit(1)
