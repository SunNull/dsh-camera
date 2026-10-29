/**
 * 采集层：拍照 / 录像 / 抓屏 / 录屏，以及「拍出来是黑的」这类现实问题的兜底。
 *
 * 所有函数都只接受已经解析好的 cfg / device / source，不碰服务与渲染。
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { explainFailure, run } from './ffmpeg.js'
import { cameraSource, listModes, screenSource } from './backends.js'

const CODEC_RANK = { mjpeg: 3, h264: 2 }

function codecRank(codec) {
  return CODEC_RANK[String(codec).toLowerCase()] ?? 1
}

/** 读 JPEG 的 SOF 段拿宽高。 */
export function jpegDimensions(buffer) {
  if (!buffer || buffer.length < 4) return undefined
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    if (marker === 0xda) return undefined
    const length = buffer.readUInt16BE(offset + 2)
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

/**
 * 决定这次用哪个采集档位。用户给了 resolution 就照办；
 * 否则挑面积最大的档位，同尺寸优先 MJPEG（本来就是逐帧 JPEG，取帧最干净）。
 */
export function resolveCaptureMode(cfg, modes, resolution) {
  if (resolution) {
    const wanted = modes.find((mode) => `${mode.width}x${mode.height}` === resolution.toLowerCase())
    return { size: resolution, ...(wanted && codecRank(wanted.codec) >= 2 ? { codec: wanted.codec } : {}) }
  }
  if (!cfg.preferLargestMode || modes.length === 0) return {}
  const usable = modes.filter(
    (mode) => mode.width > 0 && mode.height > 0 && mode.width <= cfg.maxModeEdge && mode.height <= cfg.maxModeEdge,
  )
  if (usable.length === 0) return {}
  usable.sort(
    (a, b) => b.width * b.height - a.width * a.height || codecRank(b.codec) - codecRank(a.codec) || b.fps - a.fps,
  )
  const best = usable[0]
  return { size: `${best.width}x${best.height}`, ...(codecRank(best.codec) >= 2 ? { codec: best.codec } : {}) }
}

export function modeLabel(mode) {
  return [mode.size, mode.codec].filter(Boolean).join(' ') || 'device-default'
}

/** 平均亮度，用来判断这帧是不是黑的（相机刚开、曝光还没起）。 */
export async function averageLuma({ exe, filePath, signal }) {
  try {
    const { stdout, stderr } = await run(
      exe,
      ['-hide_banner', '-nostdin', '-i', filePath, '-vf', 'signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-'],
      { timeoutMs: 12000, signal },
    )
    const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(`${stdout}${stderr}`)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

async function looksDark({ exe, filePath, bytes, dimensions, signal }) {
  if (dimensions === undefined) return false
  const pixels = dimensions.width * dimensions.height
  if (pixels <= 0) return false
  // 文件相对分辨率足够大 → 肯定不是纯黑，省掉一次解码
  if (bytes * 80 > pixels) return false
  const luma = await averageLuma({ exe, filePath, signal })
  return luma !== undefined && luma < 24
}

// ---------------------------------------------------------------------------
// 单帧抓取
// ---------------------------------------------------------------------------

async function captureFrames({ exe, cfg, source, frames, target, signal, hintResolution = false }) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-camera-'))
  try {
    const pattern = path.join(tmpDir, 'frame_%03d.jpg')
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      ...source.args,
      ...cfg.extraInputArgs,
      '-i', source.input,
      '-frames:v', String(frames),
      '-q:v', String(cfg.jpegQuality),
      ...cfg.extraOutputArgs,
      pattern,
    ]
    const { stderr } = await run(exe, args, { timeoutMs: cfg.timeoutMs, signal })
    const written = (await readdir(tmpDir)).filter((file) => file.toLowerCase().endsWith('.jpg')).sort()
    if (written.length === 0) {
      return { ok: false, error: explainFailure(stderr, { hintResolution }) }
    }
    const lastFrame = path.join(tmpDir, written[written.length - 1])
    const bytes = await readFile(lastFrame)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(lastFrame, target)
    return { ok: true, bytes, frameCount: written.length }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 拍照：档位阶梯（指定档位 → 设备默认）+ 黑帧重试（加帧数再抓一次）。
 * 现实里「第一次打开相机只有黑屏」太常见，宁可多花 0.3s。
 */
export async function captureCameraPhoto({ exe, cfg, backend, device, resolution, target, signal, overrideMode }) {
  const modes = overrideMode ? [] : await listModes({ exe, backend, device, signal })
  const preferred = overrideMode ?? resolveCaptureMode(cfg, modes, resolution)
  const ladder = preferred.size || preferred.codec ? [preferred, {}] : [{}]

  let lastError
  for (const mode of ladder) {
    const source = cameraSource({ backend, device, mode, cfg })
    let frames = cfg.frames
    let attempt = await captureFrames({ exe, cfg, source, frames, target, signal, hintResolution: true })
    if (!attempt.ok) {
      lastError = attempt.error
      continue
    }

    if (await looksDark({ exe, filePath: target, bytes: attempt.bytes.length, dimensions: jpegDimensions(attempt.bytes), signal })) {
      const retryFrames = Math.min(cfg.maxFrames, frames * 2)
      if (retryFrames > frames) {
        frames = retryFrames
        attempt = await captureFrames({ exe, cfg, source, frames, target, signal, hintResolution: true })
        if (!attempt.ok) {
          lastError = attempt.error
          continue
        }
      }
    }

    return { bytes: attempt.bytes, frameCount: attempt.frameCount, mode: { ...mode, frames } }
  }

  throw new Error(lastError ?? '拍不到画面')
}

// ---------------------------------------------------------------------------
// 录像
// ---------------------------------------------------------------------------

function clipArgs({ cfg, source, seconds, target }) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    ...source.args,
    ...cfg.extraInputArgs,
    '-i', source.input,
    '-t', String(seconds),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(cfg.clipQuality),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    target,
  ]
}

async function recordTo({ exe, cfg, sources, target, seconds, signal }) {
  let lastError
  for (const source of sources) {
    const args = clipArgs({ cfg, source, seconds, target })
    const timeoutMs = cfg.timeoutMs + seconds * 3000 + 8000
    try {
      const { stderr } = await run(exe, args, { timeoutMs, signal })
      const info = await stat(target).catch(() => undefined)
      if (info !== undefined && info.size > 0) return { bytes: info.size }
      lastError = explainFailure(stderr)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await rm(target, { force: true }).catch(() => undefined)
  }
  throw new Error(lastError ?? '录制失败')
}

/** 从成片里抽第一帧当封面，这样会话也能「看到」录了什么。 */
export async function extractPoster({ exe, videoPath, target, signal }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', target]
  try {
    const { code } = await run(exe, args, { timeoutMs: 20000, signal })
    if (code !== 0) return undefined
    const bytes = await readFile(target)
    if (bytes.length === 0) return undefined
    return { path: target, bytes }
  } catch {
    return undefined
  }
}

export async function recordCameraClip({ exe, cfg, backend, device, resolution, seconds, target, signal, overrideMode }) {
  const modes = overrideMode ? [] : await listModes({ exe, backend, device, signal })
  const preferred = overrideMode ?? resolveCaptureMode(cfg, modes, resolution)
  const ladder = preferred.size || preferred.codec ? [preferred, {}] : [{}]
  const sources = ladder.map((mode) => ({ source: cameraSource({ backend, device, mode, cfg }), mode }))
  const { bytes } = await recordTo({ exe, cfg, sources: sources.map((item) => item.source), target, seconds, signal })
  return { bytes, mode: sources[0].mode }
}

// ---------------------------------------------------------------------------
// 抓屏 / 录屏
// ---------------------------------------------------------------------------

export async function captureScreenPhoto({ exe, cfg, backend, region, target, signal }) {
  const source = screenSource({ backend, cfg, region })
  const attempt = await captureFrames({ exe, cfg, source, frames: 2, target, signal })
  if (!attempt.ok) throw new Error(attempt.error)
  return { bytes: attempt.bytes, frameCount: attempt.frameCount }
}

export async function recordScreenClip({ exe, cfg, backend, region, seconds, target, signal }) {
  const source = screenSource({ backend, cfg, region })
  const { bytes } = await recordTo({ exe, cfg, sources: [source], target, seconds, signal })
  return { bytes }
}
