/**
 * 平台后端层：把「列设备 / 列档位 / 拼输入参数」关在一个地方。
 *
 * Windows 走 DirectShow（dshow），macOS 走 AVFoundation，Linux 走 V4L2。
 * 抓屏分别用 gdigrab / avfoundation / x11grab。
 * Windows 之外的路径没有实机验证，逻辑尽量薄，出问题交给 ffmpeg 的原始报错。
 */
import { readdir } from 'node:fs/promises'
import { run } from './ffmpeg.js'

export const ROLE_LABELS = {
  laptop: '笔记本内置',
  action: '运动相机',
  virtual: '虚拟设备',
  other: '其他',
}

export function backendName() {
  if (process.platform === 'win32') return 'dshow'
  if (process.platform === 'darwin') return 'avfoundation'
  return 'v4l2'
}

export function classifyName(deviceName, cfg) {
  const name = String(deviceName).toLowerCase()
  const hit = (list) => list.some((needle) => needle.length > 0 && name.includes(needle))
  if (hit(cfg.actionMatch)) return 'action'
  if (hit(cfg.laptopMatch)) return 'laptop'
  if (hit(cfg.virtualMatch)) return 'virtual'
  return 'other'
}

// ---------------------------------------------------------------------------
// 设备枚举
// ---------------------------------------------------------------------------

export function parseDshowDevices(text) {
  const devices = []
  let last
  for (const line of text.split(/\r?\n/)) {
    const device = line.match(/"([^"]+)"\s+\((video|audio)\)\s*$/)
    if (device) {
      if (device[2] === 'video') {
        last = { name: device[1], input: device[1] }
        devices.push(last)
      } else {
        last = undefined
      }
      continue
    }
    const alternative = line.match(/Alternative name\s+"([^"]+)"/)
    if (alternative && last && last.alternativeName === undefined) {
      last.alternativeName = alternative[1]
    }
  }
  return devices
}

export function parseDshowModes(text) {
  const modes = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(?:vcodec|pixel_format)=(\S+)\s+min s=(\d+)x(\d+)\s+fps=([\d.]+)\s+max s=(\d+)x(\d+)\s+fps=([\d.]+)/)
    if (!match) continue
    const mode = { codec: match[1], width: Number(match[5]), height: Number(match[6]), fps: Number(match[7]) }
    const duplicate = modes.some(
      (item) => item.width === mode.width && item.height === mode.height && item.codec === mode.codec,
    )
    if (!duplicate) modes.push(mode)
  }
  return modes
}

export function parseAvfoundationDevices(text) {
  const devices = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (!match) continue
    const name = match[2].trim()
    if (name.length === 0) continue
    devices.push({ name, input: match[1], index: Number(match[1]) })
  }
  return devices
}

export function parseV4l2Modes(text) {
  const modes = []
  for (const line of text.split(/\r?\n/)) {
    const kind = line.match(/^\s*(Raw|Compressed)\s*:\s*(\w+)/)
    if (!kind) continue
    for (const size of line.matchAll(/(\d+)x(\d+)/g)) {
      const mode = { codec: kind[2], width: Number(size[1]), height: Number(size[2]), fps: 0 }
      const duplicate = modes.some((item) => item.width === mode.width && item.height === mode.height)
      if (!duplicate) modes.push(mode)
    }
  }
  return modes
}

const deviceCache = new Map()

export async function listVideoDevices({ exe, backend, signal, refresh = false, cfg }) {
  const cached = deviceCache.get(backend)
  if (!refresh && cached !== undefined && Date.now() - cached.at < 3000) {
    return cached.devices.map((device) => ({ ...device, role: classifyName(device.name, cfg) }))
  }

  let devices = []
  try {
    if (backend === 'dshow') {
      const { stdout, stderr } = await run(
        exe,
        ['-hide_banner', '-nostdin', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { timeoutMs: 15000, signal },
      )
      devices = parseDshowDevices(`${stdout}\n${stderr}`)
    } else if (backend === 'avfoundation') {
      const { stdout, stderr } = await run(
        exe,
        ['-hide_banner', '-nostdin', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
        { timeoutMs: 15000, signal },
      )
      devices = parseAvfoundationDevices(`${stdout}\n${stderr}`)
    } else {
      const entries = await readdir('/dev')
      devices = entries
        .filter((entry) => /^video\d+$/.test(entry))
        .sort()
        .map((entry) => ({ name: `/dev/${entry}`, input: `/dev/${entry}` }))
    }
  } catch {
    devices = []
  }

  deviceCache.set(backend, { at: Date.now(), devices })
  return devices.map((device) => ({ ...device, role: classifyName(device.name, cfg) }))
}

const modeCache = new Map()

export async function listModes({ exe, backend, device, signal, refresh = false }) {
  const key = `${backend}:${device.input}`
  const cached = modeCache.get(key)
  if (!refresh && cached !== undefined && Date.now() - cached.at < 60000) return cached.modes

  let modes = []
  try {
    if (backend === 'dshow') {
      const { stdout, stderr } = await run(
        exe,
        ['-hide_banner', '-nostdin', '-list_options', 'true', '-f', 'dshow', '-i', `video=${device.input}`],
        { timeoutMs: 15000, signal },
      )
      modes = parseDshowModes(`${stdout}\n${stderr}`)
    } else if (backend === 'v4l2') {
      const { stdout, stderr } = await run(
        exe,
        ['-hide_banner', '-nostdin', '-f', 'v4l2', '-list_formats', 'all', '-i', device.input],
        { timeoutMs: 15000, signal },
      )
      modes = parseV4l2Modes(`${stdout}\n${stderr}`)
    }
  } catch {
    modes = []
  }
  modeCache.set(key, { at: Date.now(), modes })
  return modes
}

// ---------------------------------------------------------------------------
// 机位选择
// ---------------------------------------------------------------------------

const ROLE_ALIASES = {
  laptop: ['laptop', '笔记本', '内置', '内置摄像头', '前置', 'front', 'webcam'],
  action: ['action', '相机', '运动相机', '运动像机', 'insta360', '影石', 'ace', 'acepro', 'gopro'],
}

export function describeDevices(devices) {
  return devices
    .map((device, index) => `${index}. ${device.name} [${ROLE_LABELS[device.role] ?? device.role}]`)
    .join('\n')
}

export function pickDevice(devices, wanted, cfg) {
  if (devices.length === 0) {
    throw new Error(
      '没有检测到任何视频设备。检查：1) 系统隐私设置允许桌面应用访问相机；2) 运动相机已切到「USB 摄像头 / Webcam 模式」；3) 没有其它程序（会议软件、ToDesk）独占摄像头。',
    )
  }
  const alias = String(wanted ?? 'auto').trim().toLowerCase()
  const firstByRole = (role) => devices.find((device) => device.role === role)

  if (alias === '' || alias === 'auto' || alias === '默认') {
    return firstByRole('action') ?? firstByRole('laptop') ?? firstByRole('other') ?? devices[0]
  }
  if (ROLE_ALIASES.laptop.includes(alias)) {
    return firstByRole('laptop') ?? firstByRole('other') ?? devices[0]
  }
  if (ROLE_ALIASES.action.includes(alias)) {
    const found = firstByRole('action')
    if (found) return found
    throw new Error(`没有找到运动相机。当前设备：\n${describeDevices(devices)}`)
  }
  if (/^\d+$/.test(alias)) {
    const index = Number(alias)
    if (index >= 0 && index < devices.length) return devices[index]
    throw new Error(`设备序号 ${index} 超出范围（共 ${devices.length} 个）。当前设备：\n${describeDevices(devices)}`)
  }
  const exact = devices.find((device) => device.name.toLowerCase() === alias)
  if (exact) return exact
  const partial = devices.find((device) => device.name.toLowerCase().includes(alias))
  if (partial) return partial
  throw new Error(`没有找到名为「${wanted}」的摄像头。当前设备：\n${describeDevices(devices)}`)
}

// ---------------------------------------------------------------------------
// 输入参数
// ---------------------------------------------------------------------------

/** 摄像头输入：返回 `-i` 之前的参数和输入源，便于调用方插入自己的 extraInputArgs。 */
export function cameraSource({ backend, device, mode = {}, cfg }) {
  const args = []
  if (backend === 'dshow') {
    args.push('-f', 'dshow')
    if (cfg.rtbufsize) args.push('-rtbufsize', cfg.rtbufsize)
    if (mode.size) args.push('-video_size', mode.size)
    if (mode.codec) args.push('-vcodec', mode.codec)
    return { args, input: `video=${device.input}` }
  }
  if (backend === 'avfoundation') {
    args.push('-f', 'avfoundation')
    if (cfg.framerate > 0) args.push('-framerate', String(cfg.framerate))
    if (mode.size) args.push('-video_size', mode.size)
    return { args, input: `${device.input}:none` }
  }
  args.push('-f', 'v4l2')
  if (mode.size) args.push('-video_size', mode.size)
  if (cfg.framerate > 0) args.push('-framerate', String(cfg.framerate))
  return { args, input: device.input }
}

/** 抓屏输入，同上。 */
export function screenSource({ backend, cfg, region }) {
  const framerate = String(cfg.screenFramerate)
  if (backend === 'dshow') {
    const args = ['-f', 'gdigrab', '-framerate', framerate]
    if (region) {
      args.push('-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.width}x${region.height}`)
    }
    return { args, input: cfg.screenDisplay || 'desktop' }
  }
  if (backend === 'avfoundation') {
    const args = ['-f', 'avfoundation', '-framerate', framerate]
    if (region) args.push('-video_size', `${region.width}x${region.height}`)
    return { args, input: cfg.screenDisplay || 'Capture screen 0' }
  }
  const display = cfg.screenDisplay || ':0.0'
  const args = ['-f', 'x11grab', '-framerate', framerate]
  if (region) args.push('-video_size', `${region.width}x${region.height}`)
  return { args, input: region ? `${display}+${region.x},${region.y}` : display }
}

/** 解析 "x,y,w,h"。 */
export function parseRegion(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const parts = text.split(/[,x\s]+/).map((part) => Number(part.trim()))
  if (parts.length < 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`region 需要 "x,y,w,h" 四个数字，收到 "${text}"`)
  }
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) throw new Error('region 的宽高必须大于 0')
  return { x, y, width, height }
}
