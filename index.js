/**
 * dsh-camera — 让任意会话随手看真实世界：摄像头拍照/录像、桌面抓屏/录屏。
 *
 * 分层：
 *   lib/ffmpeg.js    找 ffmpeg、跑进程、把报错翻译成人话
 *   lib/backends.js  平台后端（dshow / avfoundation / v4l2 + gdigrab / x11grab）
 *   lib/capture.js   采集（拍照档位阶梯、黑帧重试、录像、抓屏）
 *   index.js         五个工具的定义、配置、结果渲染
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveFfmpeg, ffmpegVersion } from './lib/ffmpeg.js'
import {
  ROLE_LABELS,
  backendName,
  listModes,
  listVideoDevices,
  parseRegion,
  pickDevice,
} from './lib/backends.js'
import {
  captureCameraPhoto,
  captureScreenPhoto,
  extractPoster,
  jpegDimensions,
  modeLabel,
  recordCameraClip,
  recordScreenClip,
} from './lib/capture.js'

export const name = 'dsh-camera'
export const inject = ['tools']

const LABELS = { ...ROLE_LABELS, screen: '桌面屏幕' }

const DEFAULTS = {
  ffmpegPath: '',
  saveDir: '',
  defaultCamera: 'auto',
  /** 抓多少帧、留最后一帧：等自动曝光/白平衡稳定。 */
  frames: 10,
  /** 黑帧重试时最多抓到多少帧。 */
  maxFrames: 40,
  jpegQuality: 2,
  /** 例如 "1920x1080"；空 = 自动选最高档。 */
  resolution: '',
  preferLargestMode: true,
  maxModeEdge: 4096,
  /** dshow 输入缓冲，4K 或高码率相机可加大。 */
  rtbufsize: '256M',
  /** 0 = 不指定帧率（dshow 忽略该项）。 */
  framerate: 0,
  timeoutMs: 25000,
  inlineImage: true,
  maxInlineBytes: 8 * 1024 * 1024,
  promptHint: true,
  /** 录像默认时长与上限（秒）。 */
  clipSeconds: 5,
  maxClipSeconds: 60,
  /** 录像 CRF，越小越清晰。 */
  clipQuality: 23,
  /** 抓屏帧率。 */
  screenFramerate: 15,
  /** 空 = 主屏（Windows: desktop，Linux: :0.0，macOS: Capture screen 0）。 */
  screenDisplay: '',
  /** 录像后是否抽第一帧当封面。 */
  poster: true,
  /** 桌面抓屏/录屏工具：默认关闭，只保留摄像头。要用就设 true 并重载插件。 */
  enableScreenTools: false,
  extraInputArgs: [],
  extraOutputArgs: [],
  laptopMatch: ['xiaomi webcam', 'integrated camera', 'integrated webcam', 'usb2.0 camera', 'usb camera', 'hd webcam', 'front camera', 'facetime', '笔记本', '内置'],
  actionMatch: ['insta360', 'ace pro', 'acepro', '影石', 'gopro', 'osmo', 'action cam', '运动相机'],
  virtualMatch: ['todesk', 'virtual', 'obs ', 'manycam', '组合摄像头', '虚拟'],
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toStringList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean)
    return list.length > 0 ? list : fallback
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  }
  return fallback
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue
      cfg[key] = value
    }
  }
  cfg.frames = clampInt(cfg.frames, 1, 120, DEFAULTS.frames)
  cfg.maxFrames = clampInt(cfg.maxFrames, cfg.frames, 240, Math.max(DEFAULTS.maxFrames, cfg.frames))
  cfg.jpegQuality = clampInt(cfg.jpegQuality, 1, 31, DEFAULTS.jpegQuality)
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 3000, 300000, DEFAULTS.timeoutMs)
  cfg.maxInlineBytes = clampInt(cfg.maxInlineBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULTS.maxInlineBytes)
  cfg.preferLargestMode = cfg.preferLargestMode !== false
  cfg.poster = cfg.poster !== false
  cfg.enableScreenTools = cfg.enableScreenTools === true
  cfg.maxModeEdge = clampInt(cfg.maxModeEdge, 640, 7680, DEFAULTS.maxModeEdge)
  cfg.framerate = clampInt(cfg.framerate, 0, 240, DEFAULTS.framerate)
  cfg.clipSeconds = clampInt(cfg.clipSeconds, 1, 300, DEFAULTS.clipSeconds)
  cfg.maxClipSeconds = clampInt(cfg.maxClipSeconds, cfg.clipSeconds, 300, DEFAULTS.maxClipSeconds)
  cfg.clipQuality = clampInt(cfg.clipQuality, 0, 51, DEFAULTS.clipQuality)
  cfg.screenFramerate = clampInt(cfg.screenFramerate, 1, 60, DEFAULTS.screenFramerate)
  cfg.laptopMatch = toStringList(cfg.laptopMatch, DEFAULTS.laptopMatch)
  cfg.actionMatch = toStringList(cfg.actionMatch, DEFAULTS.actionMatch)
  cfg.virtualMatch = toStringList(cfg.virtualMatch, DEFAULTS.virtualMatch)
  cfg.extraInputArgs = Array.isArray(cfg.extraInputArgs) ? cfg.extraInputArgs.map(String) : []
  cfg.extraOutputArgs = Array.isArray(cfg.extraOutputArgs) ? cfg.extraOutputArgs.map(String) : []
  cfg.ffmpegPath = typeof cfg.ffmpegPath === 'string' ? cfg.ffmpegPath.trim() : ''
  cfg.saveDir = typeof cfg.saveDir === 'string' ? cfg.saveDir.trim() : ''
  cfg.resolution = typeof cfg.resolution === 'string' ? cfg.resolution.trim() : ''
  cfg.rtbufsize = typeof cfg.rtbufsize === 'string' ? cfg.rtbufsize.trim() : ''
  cfg.screenDisplay = typeof cfg.screenDisplay === 'string' ? cfg.screenDisplay.trim() : ''
  cfg.defaultCamera = typeof cfg.defaultCamera === 'string' && cfg.defaultCamera.trim() ? cfg.defaultCamera.trim() : 'auto'
  return cfg
}

// ---------------------------------------------------------------------------
// 路径与时间
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0')
}

function timestamps(date = new Date()) {
  const local = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`
  return { local, iso }
}

function shotsRoot(cfg) {
  if (cfg.saveDir) return path.resolve(cfg.saveDir)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'camera')
}

function outputPath(cfg, { kind, role, extension, explicit, date = new Date() }) {
  if (explicit) return path.resolve(explicit)
  const { local } = timestamps(date)
  const suffix = role ? `-${role}` : ''
  return path.join(shotsRoot(cfg), `${kind}-${local}${suffix}${extension}`)
}

// ---------------------------------------------------------------------------
// 设备/档位缓存：一次采集只打开一次设备
//
// 每次枚举设备、列档位都要真的把设备打开一次（UVC 相机约 1.5–3s），
// 所以把结果落到 saveDir 下的隐藏 JSON，下次直接拿着名字去抓帧。
// 缓存不可信时（设备拔了/档位没了）抓取会失败，再退回完整枚举重试。
// ---------------------------------------------------------------------------

function cacheFile(cfg) {
  return path.join(shotsRoot(cfg), '.camera-cache.json')
}

async function loadCache(cfg) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(cfg), 'utf8'))
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      bestModes: parsed.bestModes && typeof parsed.bestModes === 'object' ? parsed.bestModes : {},
    }
  } catch {
    return { devices: [], bestModes: {} }
  }
}

async function saveCache(cfg, cache) {
  try {
    await mkdir(path.dirname(cacheFile(cfg)), { recursive: true })
    await writeFile(cacheFile(cfg), JSON.stringify({ ...cache, updatedAt: Date.now() }), 'utf8')
  } catch { /* 缓存写失败不影响采集 */ }
}

function cacheKey(backend, device) {
  return `${backend}:${device.input ?? device.name}`
}

function slimDevice(device) {
  return {
    name: device.name,
    input: device.input,
    role: device.role,
    ...(device.alternativeName === undefined ? {} : { alternativeName: device.alternativeName }),
  }
}

/** 先信缓存，缓存不可用时再真枚举。返回的 devices 仅在完整枚举时存在。 */
async function prepareDevice({ exe, backend, cfg, wanted, signal, forceFull = false }) {
  const cache = await loadCache(cfg)
  if (!forceFull && cache.devices.length > 0) {
    try {
      const device = pickDevice(cache.devices, wanted, cfg)
      return { device, overrideMode: cache.bestModes[cacheKey(backend, device)], fromCache: true }
    } catch { /* 缓存里的设备对不上，走完整枚举 */ }
  }
  const devices = await listVideoDevices({ exe, backend, signal, cfg })
  const device = pickDevice(devices, wanted, cfg)
  await saveCache(cfg, { backend, devices: devices.map(slimDevice), bestModes: cache.bestModes })
  return { device, overrideMode: cache.bestModes[cacheKey(backend, device)], fromCache: false, devices }
}

/** 记住这次成功的档位，下次直接复用，省掉一次列档位的设备打开。 */
async function rememberMode({ cfg, backend, device, mode, devices }) {
  const cache = await loadCache(cfg)
  const bestModes = { ...cache.bestModes }
  if (mode && (mode.size || mode.codec)) bestModes[cacheKey(backend, device)] = { size: mode.size, codec: mode.codec }
  await saveCache(cfg, { backend, devices: devices ? devices.map(slimDevice) : cache.devices, bestModes })
}

// ---------------------------------------------------------------------------
// 图片内联（与 read_image 同一套附件管线）
// ---------------------------------------------------------------------------

async function routeSupportsImage(ctx, exec) {
  try {
    const llm = ctx.get?.('llm')
    if (!llm?.resolveModelInfo) return true
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!provider || !model) return true
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!Array.isArray(info?.inputModalities)) return true
    return info.inputModalities.includes('image')
  } catch {
    return true
  }
}

async function inlineImage(ctx, bytes, fileName) {
  const attachments = ctx.get?.('attachments')
  if (!attachments?.saveImage) return undefined
  try {
    const ref = await attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: 'image/jpeg',
      name: fileName,
    })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

function stillEnvelope(value) {
  const size = value.width && value.height ? `${value.width}x${value.height} px, ` : ''
  const source = value.kind === 'screen'
    ? '<source>桌面屏幕</source>'
    : `<source>${value.device} (${LABELS[value.camera] ?? value.camera})</source>`
  return `<path>${value.path}</path>
${source}
<time>${value.capturedAt}</time>
<content>image/jpeg ${size}${value.bytes} bytes</content>`
}

function stillContent(args, value) {
  const blocks = [{ type: 'text', text: stillEnvelope(value) }]
  if (value?.image?.attachmentId) {
    blocks.push({ type: 'image', attachment: value.image })
  } else if (value?.path) {
    const reason = args?.inline === false
      ? '按 inline=false 的要求只落盘'
      : '（当前模型不走 image 输入，或单张超过内联上限）'
    blocks.push({ type: 'text', text: `图片没有内联进对话：${reason}。需要看画面时用 read_image 读上面的 path。` })
  }
  return blocks
}

function clipContent(value) {
  const size = value.width && value.height ? `${value.width}x${value.height} px, ` : ''
  const source = value.kind === 'screen' ? '桌面屏幕' : `${value.device} (${LABELS[value.camera] ?? value.camera})`
  const lines = [
    `<path>${value.path}</path>`,
    `<source>${source}</source>`,
    `<time>${value.capturedAt}</time>`,
    `<content>video/mp4 ${size}${value.bytes} bytes, ${value.seconds}s</content>`,
  ]
  if (value.posterPath) lines.push(`<poster>${value.posterPath}</poster>`)
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  if (value?.posterImage?.attachmentId) {
    blocks.push({ type: 'text', text: '封面帧（视频第一帧）：' })
    blocks.push({ type: 'image', attachment: value.posterImage })
  }
  return blocks
}

function devicesContent(value) {
  const lines = []
  lines.push(`平台后端: ${value.backend}`)
  lines.push(`ffmpeg: ${value.ffmpeg.path || '(未找到)'}${value.ffmpeg.version ? ` — ${value.ffmpeg.version}` : ''}`)
  if (value.default) {
    lines.push(`默认机位: ${value.default.name} (${LABELS[value.default.camera] ?? value.default.camera})`)
  }
  lines.push('设备:')
  if (value.devices.length === 0) lines.push('  (没有检测到视频设备)')
  for (const [index, device] of value.devices.entries()) {
    const marks = []
    if (value.default && value.default.name === device.name) marks.push('默认')
    const formats = device.formats && device.formats.length > 0
      ? ` — ${[...new Set(device.formats.map((format) => `${format.width}x${format.height}`))].slice(0, 8).join(', ')}`
      : ''
    lines.push(`  ${index}. ${device.name} [${LABELS[device.camera] ?? device.camera}]${formats}${marks.length ? `  ← ${marks.join(' / ')}` : ''}`)
  }
  lines.push(`保存目录: ${value.saveDir}`)
  if (value.hints.length > 0) {
    lines.push('提示:')
    for (const hint of value.hints) lines.push(`  - ${hint}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// 互斥：一台相机同一时刻只能被一个 ffmpeg 打开
// ---------------------------------------------------------------------------

let cameraQueue = Promise.resolve()

function withCameraLock(task) {
  const queued = cameraQueue.then(task, task)
  cameraQueue = queued.then(() => undefined, () => undefined)
  return queued
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const backend = backendName()

  async function inlineMaybe(args, bytes, fileName, exec) {
    const wantInline = args?.inline === undefined ? cfg.inlineImage : args.inline === true
    if (!wantInline || bytes.length > cfg.maxInlineBytes) return undefined
    if (!(await routeSupportsImage(ctx, exec))) return undefined
    return inlineImage(ctx, bytes, fileName)
  }

  // --- 设备枚举 -------------------------------------------------------------
  const devicesTool = {
    name: 'camera_devices',
    description:
      '列出当前可用的摄像头（笔记本内置、USB 运动相机、虚拟摄像头），标注推断出的机位角色和可选分辨率。拍照/录像报错、或想知道运动相机有没有被识别时先调它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        formats: { type: 'boolean', description: '是否逐个列出每个设备支持的分辨率/帧率（会多花一两秒）。' },
        refresh: { type: 'boolean', description: '忽略 3 秒缓存，重新枚举（刚插拔设备时用）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string' },
          saveDir: { type: 'string' },
          ffmpeg: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string' }, version: { type: 'string' } },
            required: ['path', 'version'],
          },
          devices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                camera: { type: 'string' },
                alternativeName: { type: 'string' },
                formats: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      codec: { type: 'string' },
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                      fps: { type: 'number' },
                    },
                  },
                },
              },
              required: ['name', 'camera'],
            },
          },
          default: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' }, camera: { type: 'string' } },
            required: ['name', 'camera'],
          },
          hints: { type: 'array', items: { type: 'string' } },
        },
        required: ['backend', 'saveDir', 'ffmpeg', 'devices', 'hints'],
      },
      render: (_args, value) => devicesContent(value),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    presentCall() {
      return { card: 'generic', title: '枚举摄像头设备', kind: 'other' }
    },
    async execute(args, exec) {
      const exe = await resolveFfmpeg(cfg)
      const devices = await listVideoDevices({ exe, backend, signal: exec?.signal, refresh: args?.refresh === true, cfg })
      if (args?.formats === true) {
        for (const device of devices) {
          device.formats = await listModes({ exe, backend, device, signal: exec?.signal, refresh: true })
        }
      }
      await saveCache(cfg, { backend, devices: devices.map(slimDevice), bestModes: (await loadCache(cfg)).bestModes })
      let picked
      try {
        picked = devices.length > 0 ? pickDevice(devices, cfg.defaultCamera, cfg) : undefined
      } catch {
        picked = devices[0]
      }
      const hints = []
      if (devices.length === 0) {
        hints.push('先确认系统隐私设置允许桌面应用访问相机（Windows：设置 → 隐私和安全性 → 相机）。')
        hints.push('Ace Pro 2：用官方数据线连电脑，相机屏幕弹出 USB 模式时选「USB 摄像头 / Webcam」。')
      } else if (!devices.some((device) => device.role === 'action')) {
        hints.push('没看到运动相机：接上相机并选「USB 摄像头」模式后重新枚举。')
      }
      if (devices.length > 0 && !devices.some((device) => device.role === 'laptop')) {
        hints.push('没匹配到内置摄像头，可把它的真实设备名加到配置 laptopMatch 里。')
      }
      if (backend !== 'dshow') hints.push(`${backend} 后端为未实机验证的路径，报错信息会原样转达。`)
      return {
        backend,
        saveDir: shotsRoot(cfg),
        ffmpeg: { path: exe, version: await ffmpegVersion(exe) },
        devices: devices.map((device) => ({
          name: device.name,
          camera: device.role,
          ...(device.alternativeName === undefined ? {} : { alternativeName: device.alternativeName }),
          ...(device.formats === undefined ? {} : { formats: device.formats }),
        })),
        ...(picked === undefined ? {} : { default: { name: picked.name, camera: picked.role } }),
        hints,
      }
    },
  }

  // --- 拍照 -----------------------------------------------------------------
  const photoTool = {
    name: 'camera_photo',
    description:
      '用真实摄像头拍一张「此时此刻」的照片，并把照片本身返回给你。camera=auto 时优先选已连接的运动相机（如 Insta360 Ace Pro 2 的 USB 摄像头模式），否则用笔记本内置摄像头；也可以传 laptop / action 或设备名片段指定。自动挑设备支持的最高分辨率，照片同时存到本地文件。适合回答「我桌面上现在什么情况」「激光雕刻机现在跑到哪了」这类需要真实画面的问题。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        camera: { type: 'string', description: '一般不用传：默认 auto（有运动相机就用运动相机，否则内置摄像头）。需要指定时可用 laptop / action / 设备名片段。' },
        inline: { type: 'boolean', description: '默认 true，照片直接进对话。只在不想看画面、只要文件路径时传 false。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          device: { type: 'string' },
          camera: { type: 'string' },
          capturedAt: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          frames: { type: 'integer' },
          inlined: { type: 'boolean' },
          videoMode: { type: 'string' },
          image: IMAGE_SCHEMA,
        },
        required: ['kind', 'path', 'device', 'camera', 'capturedAt', 'bytes', 'frames', 'inlined'],
      },
      render: (args, value) => stillContent(args, value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: cfg.timeoutMs + 20000,
    presentCall(args) {
      const camera = typeof args?.camera === 'string' && args.camera.trim() ? args.camera.trim() : 'auto'
      return { card: 'generic', title: `拍照 (${camera})`, kind: 'other' }
    },
    async execute(args, exec) {
      const exe = await resolveFfmpeg(cfg)
      const wanted = args?.camera?.trim() || cfg.defaultCamera
      const now = new Date()
      const resolution = cfg.resolution
      let prepared = await prepareDevice({ exe, backend, cfg, wanted, signal: exec?.signal })
      let target = outputPath(cfg, { kind: 'cam', role: prepared.device.role, extension: '.jpg', explicit: '', date: now })
      let shot
      try {
        shot = await withCameraLock(() =>
          captureCameraPhoto({ exe, cfg, backend, device: prepared.device, resolution, target, signal: exec?.signal, overrideMode: prepared.overrideMode }),
        )
      } catch (error) {
        if (!prepared.fromCache) throw error
        // 缓存里的设备可能已拔掉/换档，重新枚举后再试一次
        prepared = await prepareDevice({ exe, backend, cfg, wanted, signal: exec?.signal, forceFull: true })
        target = outputPath(cfg, { kind: 'cam', role: prepared.device.role, extension: '.jpg', explicit: '', date: now })
        shot = await withCameraLock(() =>
          captureCameraPhoto({ exe, cfg, backend, device: prepared.device, resolution, target, signal: exec?.signal, overrideMode: prepared.overrideMode }),
        )
      }
      const { bytes, frameCount, mode } = shot
      await rememberMode({ cfg, backend, device: prepared.device, mode, devices: prepared.devices })
      const dimensions = jpegDimensions(bytes)
      const image = await inlineMaybe(args, bytes, path.basename(target), exec)
      return {
        kind: 'camera',
        path: target,
        device: prepared.device.name,
        camera: prepared.device.role,
        capturedAt: timestamps(now).iso,
        width: dimensions?.width ?? image?.width ?? 0,
        height: dimensions?.height ?? image?.height ?? 0,
        bytes: bytes.length,
        frames: frameCount,
        inlined: image !== undefined,
        videoMode: modeLabel(mode),
        ...(image === undefined ? {} : { image }),
      }
    },
  }

  // --- 摄像头录像 -----------------------------------------------------------
  const clipTool = {
    name: 'camera_clip',
    description:
      '用摄像头录一段短视频（默认 5 秒）存成 mp4，并抽出第一帧作为封面返回给你看。需要判断「在动的东西」时才用它：雕刻机走位、指示灯闪、人还在不在、气流/液体状态。只想要一张图就用 camera_photo，更便宜。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        camera: { type: 'string', description: '一般不用传：默认 auto。需要指定时可用 laptop / action / 设备名片段。' },
        seconds: { type: 'integer', description: `录几秒，默认 ${DEFAULTS.clipSeconds}，上限 ${DEFAULTS.maxClipSeconds}。` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          device: { type: 'string' },
          camera: { type: 'string' },
          capturedAt: { type: 'string' },
          seconds: { type: 'number' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          videoMode: { type: 'string' },
          posterPath: { type: 'string' },
          posterImage: IMAGE_SCHEMA,
        },
        required: ['kind', 'path', 'device', 'camera', 'capturedAt', 'seconds', 'bytes'],
      },
      render: (_args, value) => clipContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: cfg.timeoutMs + cfg.maxClipSeconds * 3000 + 20000,
    presentCall(args) {
      const seconds = Number(args?.seconds) || cfg.clipSeconds
      return { card: 'generic', title: `摄像头录像 ${seconds}s`, kind: 'other' }
    },
    async execute(args, exec) {
      const exe = await resolveFfmpeg(cfg)
      const wanted = args?.camera?.trim() || cfg.defaultCamera
      const seconds = Math.min(cfg.maxClipSeconds, Math.max(1, Number(args?.seconds) || cfg.clipSeconds))
      const now = new Date()
      const resolution = cfg.resolution
      let prepared = await prepareDevice({ exe, backend, cfg, wanted, signal: exec?.signal })
      let target = outputPath(cfg, { kind: 'clip', role: prepared.device.role, extension: '.mp4', explicit: '', date: now })
      let recording
      try {
        recording = await withCameraLock(() =>
          recordCameraClip({ exe, cfg, backend, device: prepared.device, resolution, seconds, target, signal: exec?.signal, overrideMode: prepared.overrideMode }),
        )
      } catch (error) {
        if (!prepared.fromCache) throw error
        prepared = await prepareDevice({ exe, backend, cfg, wanted, signal: exec?.signal, forceFull: true })
        target = outputPath(cfg, { kind: 'clip', role: prepared.device.role, extension: '.mp4', explicit: '', date: now })
        recording = await withCameraLock(() =>
          recordCameraClip({ exe, cfg, backend, device: prepared.device, resolution, seconds, target, signal: exec?.signal, overrideMode: prepared.overrideMode }),
        )
      }
      const { bytes, mode } = recording
      await rememberMode({ cfg, backend, device: prepared.device, mode, devices: prepared.devices })

      let poster
      if (cfg.poster) {
        const posterPath = `${target.replace(/\.mp4$/i, '')}-poster.jpg`
        const frame = await extractPoster({ exe, videoPath: target, target: posterPath, signal: exec?.signal })
        if (frame !== undefined) poster = { path: frame.path, bytes: frame.bytes }
      }

      let posterImage
      if (poster !== undefined) {
        const wantInline = cfg.inlineImage
        if (wantInline && poster.bytes.length <= cfg.maxInlineBytes && (await routeSupportsImage(ctx, exec))) {
          posterImage = await inlineImage(ctx, poster.bytes, path.basename(poster.path))
        }
      }
      const dimensions = poster === undefined ? undefined : jpegDimensions(poster.bytes)

      return {
        kind: 'camera',
        path: target,
        device: prepared.device.name,
        camera: prepared.device.role,
        capturedAt: timestamps(now).iso,
        seconds,
        bytes,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
        videoMode: modeLabel(mode),
        ...(poster === undefined ? {} : { posterPath: poster.path }),
        ...(posterImage === undefined ? {} : { posterImage }),
      }
    },
  }

  // --- 抓屏 -----------------------------------------------------------------
  const screenTool = {
    name: 'screen_capture',
    description:
      '截一张当前桌面屏幕的图（可指定区域），把图返回给你。用户说「屏幕上这个报错」「这个页面长什么样」时用它；截的是整块桌面（可以截到别的窗口），不只是本会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        region: { type: 'string', description: '可选区域 "x,y,w,h"（像素），不填 = 整屏。' },
        inline: { type: 'boolean', description: '是否把截图内联进对话，默认 true。' },
        savePath: { type: 'string', description: '可选：指定保存路径（.jpg）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          device: { type: 'string' },
          camera: { type: 'string' },
          capturedAt: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          frames: { type: 'integer' },
          inlined: { type: 'boolean' },
          image: IMAGE_SCHEMA,
        },
        required: ['kind', 'path', 'device', 'camera', 'capturedAt', 'bytes', 'frames', 'inlined'],
      },
      render: (args, value) => stillContent(args, value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    timeoutMs: cfg.timeoutMs + 10000,
    presentCall() {
      return { card: 'generic', title: '截屏', kind: 'other' }
    },
    async execute(args, exec) {
      const exe = await resolveFfmpeg(cfg)
      const region = parseRegion(args?.region)
      const now = new Date()
      const target = outputPath(cfg, {
        kind: 'screen',
        extension: '.jpg',
        explicit: typeof args?.savePath === 'string' ? args.savePath.trim() : '',
        date: now,
      })
      const { bytes, frameCount } = await captureScreenPhoto({ exe, cfg, backend, region, target, signal: exec?.signal })
      const dimensions = jpegDimensions(bytes)
      const image = await inlineMaybe(args, bytes, path.basename(target), exec)
      return {
        kind: 'screen',
        path: target,
        device: 'desktop',
        camera: 'screen',
        capturedAt: timestamps(now).iso,
        width: dimensions?.width ?? image?.width ?? 0,
        height: dimensions?.height ?? image?.height ?? 0,
        bytes: bytes.length,
        frames: frameCount,
        inlined: image !== undefined,
        ...(image === undefined ? {} : { image }),
      }
    },
  }

  // --- 录屏 -----------------------------------------------------------------
  const screenClipTool = {
    name: 'screen_record',
    description:
      '录一段桌面屏幕视频（默认 5 秒）存成 mp4，并抽第一帧当封面返回。要观察「操作过程」「动画/滚动/闪烁」时用它；只要一张图用 screen_capture。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        seconds: { type: 'integer', description: `录制秒数，默认 ${DEFAULTS.clipSeconds}，上限 ${DEFAULTS.maxClipSeconds}。` },
        region: { type: 'string', description: '可选区域 "x,y,w,h"（像素），不填 = 整屏。' },
        savePath: { type: 'string', description: '可选：指定 mp4 保存路径。' },
        poster: { type: 'boolean', description: '是否抽封面帧内联，默认 true。' },
        inline: { type: 'boolean', description: '是否把封面帧内联进对话，默认 true。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          device: { type: 'string' },
          camera: { type: 'string' },
          capturedAt: { type: 'string' },
          seconds: { type: 'number' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          posterPath: { type: 'string' },
          posterImage: IMAGE_SCHEMA,
        },
        required: ['kind', 'path', 'device', 'camera', 'capturedAt', 'seconds', 'bytes'],
      },
      render: (_args, value) => clipContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    timeoutMs: cfg.maxClipSeconds * 3000 + cfg.timeoutMs,
    presentCall(args) {
      const seconds = Number(args?.seconds) || cfg.clipSeconds
      return { card: 'generic', title: `录屏 ${seconds}s`, kind: 'other' }
    },
    async execute(args, exec) {
      const exe = await resolveFfmpeg(cfg)
      const region = parseRegion(args?.region)
      const seconds = Math.min(cfg.maxClipSeconds, Math.max(1, Number(args?.seconds) || cfg.clipSeconds))
      const now = new Date()
      const target = outputPath(cfg, {
        kind: 'screenclip',
        extension: '.mp4',
        explicit: typeof args?.savePath === 'string' ? args.savePath.trim() : '',
        date: now,
      })
      const { bytes } = await recordScreenClip({ exe, cfg, backend, region, seconds, target, signal: exec?.signal })

      let poster
      const wantPoster = args?.poster === undefined ? cfg.poster : args.poster === true
      if (wantPoster) {
        const posterPath = `${target.replace(/\.mp4$/i, '')}-poster.jpg`
        const frame = await extractPoster({ exe, videoPath: target, target: posterPath, signal: exec?.signal })
        if (frame !== undefined) poster = { path: frame.path, bytes: frame.bytes }
      }

      let posterImage
      if (poster !== undefined) {
        const wantInline = args?.inline === undefined ? cfg.inlineImage : args.inline === true
        if (wantInline && poster.bytes.length <= cfg.maxInlineBytes && (await routeSupportsImage(ctx, exec))) {
          posterImage = await inlineImage(ctx, poster.bytes, path.basename(poster.path))
        }
      }
      const dimensions = poster === undefined ? undefined : jpegDimensions(poster.bytes)

      return {
        kind: 'screen',
        path: target,
        device: 'desktop',
        camera: 'screen',
        capturedAt: timestamps(now).iso,
        seconds,
        bytes,
        width: dimensions?.width ?? 0,
        height: dimensions?.height ?? 0,
        ...(poster === undefined ? {} : { posterPath: poster.path }),
        ...(posterImage === undefined ? {} : { posterImage }),
      }
    },
  }

  ctx.effect(() => {
    const tools = cfg.enableScreenTools
      ? [devicesTool, photoTool, clipTool, screenTool, screenClipTool]
      : [devicesTool, photoTool, clipTool]
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-camera:tools')

  if (cfg.promptHint) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.effect(
        () =>
          scoped.systemPrompt.section({
            name: 'camera-live-state',
            order: 5150,
            text:
              '需要看真实世界的当前状态（桌面、房间、设备的实际模样、现场在动的东西）时，不要猜：camera_photo() 拍一张、camera_clip() 录几秒，都不用传参数，结果会直接以图片/封面返回。只有要切换机位时才传 camera=laptop/action；设备一台上都没有就先调 camera_devices。',
          }),
        'dsh-camera:prompt',
      )
    })
  }

  return undefined
}
