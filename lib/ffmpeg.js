/**
 * ffmpeg 进程层：定位可执行文件、带超时/取消地跑命令。
 *
 * 只依赖 node 内置模块，不引入任何第三方包。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 跑一条命令。ffmpeg 把日志写 stderr，两个流都收。 */
export function run(exe, args, { timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    let timer
    let settled = false
    let stdout = ''
    let stderr = ''

    const finish = (settle, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      settle(value)
    }

    function onAbort() {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      finish(reject, new Error('采集中断'))
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      finish(reject, new Error(`ffmpeg 超过 ${timeoutMs}ms 没有返回（设备可能被别的程序独占，或相机没进入 USB 摄像头模式）`))
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
  })
}

/** 在 PATH 里把裸命令名换成绝对路径，日志里看起来才像话。 */
export function whichOnPath(exeName) {
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    for (const extension of ['', ...extensions]) {
      const candidate = path.join(dir, `${exeName}${extension}`)
      try {
        if (existsSync(candidate)) return candidate
      } catch { /* 忽略无权限目录 */ }
    }
  }
  return undefined
}

function candidates(cfg) {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  return [
    cfg.ffmpegPath,
    process.env.FFMPEG_PATH ?? '',
    'ffmpeg',
    localAppData ? path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : '',
    path.join(programFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter((candidate) => candidate && candidate.length > 0)
}

let resolved

export async function resolveFfmpeg(cfg) {
  if (cfg.ffmpegPath) return cfg.ffmpegPath
  if (resolved) return resolved
  for (const raw of candidates(cfg)) {
    const candidate = raw === 'ffmpeg' ? whichOnPath('ffmpeg.exe') ?? whichOnPath('ffmpeg') ?? 'ffmpeg' : raw
    try {
      const { code, stdout } = await run(candidate, ['-hide_banner', '-version'], { timeoutMs: 8000 })
      if (code === 0 && /ffmpeg version/i.test(stdout)) {
        resolved = candidate
        return candidate
      }
    } catch { /* 换下一个 */ }
  }
  throw new Error('找不到可用的 ffmpeg。请安装 ffmpeg 并在插件配置里写 ffmpegPath（Windows 常见位置：C:\\ffmpeg\\bin\\ffmpeg.exe）。')
}

export async function ffmpegVersion(exe) {
  try {
    const { stdout } = await run(exe, ['-hide_banner', '-version'], { timeoutMs: 8000 })
    return stdout.split(/\r?\n/)[0]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 在 stderr 里挑一句人话，别把几十行日志甩给模型。 */
export function explainFailure(text, { hintResolution = false } = {}) {
  const detail = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-4)
    .join(' | ')
  if (/Could not run/i.test(detail) || /already in use/i.test(detail) || /device is busy/i.test(detail)) {
    return `设备打不开（可能被其它程序独占）。关掉会议/录像/ToDesk 之类占用的程序再试。ffmpeg: ${detail}`
  }
  if (/Immediate exit requested/i.test(detail)) {
    return `设备没给出画面就退出了：确认设备名正确、相机已进入 USB 摄像头模式。ffmpeg: ${detail}`
  }
  if (/Could not set video options/i.test(detail) || /not found/i.test(detail) || /No such device/i.test(detail)) {
    return hintResolution
      ? `设备或分辨率不被支持：用 camera_devices(formats=true) 看可用档位，再用 resolution 指定。ffmpeg: ${detail}`
      : `设备不存在或参数不被支持。ffmpeg: ${detail}`
  }
  return `ffmpeg 执行失败：${detail || '没有输出'}`
}
