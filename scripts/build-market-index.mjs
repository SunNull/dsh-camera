/**
 * 生成并校验市场索引：market/index.json
 * 用的是 DSH 自带的官方 parser，所以"能过"就是真的能过。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const MARKET_INDEX = 'file:///D:/soft/deepseek_harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
const { parseMarketIndex, marketInstallTarget } = await import(MARKET_INDEX)

const here = process.cwd()
const icon = await readFile(path.join(here, 'icon.svg'))
const iconDataUrl = `data:image/svg+xml;base64,${icon.toString('base64')}`

const index = {
  format: 1,
  title: { en: 'SunNull plugins', zh: 'SunNull 插件源' },
  description: {
    en: 'Plugins published straight from git — no npm account needed.',
    zh: '直接从 git 发布的插件，不需要 npm 账号。',
  },
  metadata: {
    categories: { tools: { title: { en: 'Tools', zh: '工具' } }, vision: { title: { en: 'Vision', zh: '视觉' } } },
  },
  plugins: [
    {
      name: 'dsh-camera',
      title: { en: 'Camera Capture', zh: '摄像头拍照' },
      description: {
        en: 'camera_photo / camera_clip / camera_devices: hand real-world images to the model via ffmpeg (laptop webcam or USB action camera).',
        zh: 'camera_photo / camera_clip / camera_devices：用 ffmpeg 拍笔记本摄像头或 USB 运动相机，画面直接进对话。',
      },
      icon: iconDataUrl,
      author: 'SunNull',
      homepage: 'https://github.com/SunNull/dsh-camera#readme',
      repository: { url: 'https://github.com/SunNull/dsh-camera' },
      metadata: { category: 'tools', keywords: ['camera', 'webcam', 'ffmpeg', 'vision'], labels: [] },
      versions: [
        {
          version: '1.0.0',
          publishTimestamp: 1793283631,
          source: {
            type: 'git',
            url: 'https://github.com/SunNull/dsh-camera',
            commit: 'aa4660db2167a0262b7e3d3413b58c7dda15ac92',
          },
          engines: { dsh: '>=0.2.1-rc.2' },
        },
      ],
    },
  ],
}

await mkdir(path.join(here, 'market'), { recursive: true })
const file = path.join(here, 'market', 'index.json')
await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

const indexUrl = 'https://raw.githubusercontent.com/SunNull/dsh-camera/main/market/index.json'
const parsed = parseMarketIndex(index, indexUrl)

const plugin = parsed.plugins[0]
const version = plugin.versions[0]
const target = marketInstallTarget(plugin.name, version)
console.log('✓ 索引通过官方 parser 校验')
console.log('  index   :', parsed.title, '| format', parsed.format, '| plugins', parsed.plugins.length)
console.log('  plugin  :', plugin.name, plugin.versions.map((v) => v.version).join(','))
console.log('  icon    :', plugin.icon.startsWith('data:') ? `data URL (${plugin.icon.length} chars)` : plugin.icon)
console.log('  安装 spec:', target.spec)
console.log('  registry :', target.registry ?? '(无，走 git)')
console.log('  写入     :', file)
