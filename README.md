# dsh-camera

[![check](https://github.com/SunNull/dsh-camera/actions/workflows/check.yml/badge.svg)](https://github.com/SunNull/dsh-camera/actions/workflows/check.yml)

给 DeepSeek Harness 的每个会话两台工具：`camera_photo()` 拍一张、`camera_clip()` 录几秒。**不传参数就能用**，画面直接进对话（照片本身 / 视频第一帧），不是一句「已保存」。

```js
camera_photo()              // 拍一张，自动机位、自动最高档、图片内联
camera_clip({ seconds: 5 }) // 录 5 秒 mp4，第一帧当封面内联
```

## 安装

```
plugin_manager → install_bundle →
https://github.com/SunNull/dsh-camera/archive/refs/heads/main.tar.gz
```

本机开发也可以直接指向仓库目录（`install_bundle` 接受绝对路径）。前提：DSH 0.2.1-rc.x + PATH 里有 `ffmpeg`。装完在插件管理器里默认启用，无需构建、无 npm 依赖。

多机位时才需要传 `camera`：

| 取值 | 行为 |
| --- | --- |
| 不传 / `auto` | 有运动相机就用运动相机，否则笔记本内置 |
| `laptop` / `笔记本` / `内置` | 强制内置摄像头 |
| `action` / `相机` / `运动相机` / `insta360` | 强制运动相机，没接就报错并列出设备 |
| 设备名片段 / 序号 | 直选 |

| 工具 | 作用 |
| --- | --- |
| `camera_photo` | 拍一张现在的照片，内联进对话 |
| `camera_clip` | 录几秒 mp4（默认 5s），抽第一帧当封面内联 |
| `camera_devices` | 列设备 / 档位，出问题时排查用 |
| `screen_capture` / `screen_record` | 桌面抓屏 / 录屏，**默认关闭**（`enableScreenTools: true` 才注册） |

实现只用 `ffmpeg` + Node 内置模块，零 npm 依赖。Windows 走 DirectShow（dshow），macOS 走 AVFoundation，Linux 走 V4L2。

## 一次调用长什么样

```
camera_photo()
→ <path>…\cam-20261029-215447-action.jpg</path>
  <source>Insta360 Ace Pro 2 (运动相机)</source>
  <time>2026-10-29T21:54:47+08:00</time>
  <content>image/jpeg 1920x1080 px, 186709 bytes</content>
  + 一张图（模型直接看得到）

camera_clip({ seconds: 3 })
→ <path>…\clip-20261029-220249-action.mp4</path>
  <content>video/mp4 1920x1080 px, 975785 bytes, 3s</content>
  <poster>…-poster.jpg</poster>
  + 封面帧图片
```

## 速度

实测（Ace Pro 2，USB 摄像头模式）：

| 操作 | 耗时 |
| --- | --- |
| 首次拍照（缓存空） | ≈6.0 s |
| 之后每次拍照 | ≈3.2 s |
| 录 2 秒 | ≈5.2 s（3 s 开设备 + 2 s 录） |
| `camera_devices()` | ≈1.7 s |

时间几乎全花在**相机自己被打开**上（UVC 设备初始化 2.9 s），抓 1 帧和抓 10 帧耗时一样。所以做了持久缓存：设备和最佳档位记在 `<saveDir>/.camera-cache.json`，正常只需要打开设备一次；缓存失效（拔了相机、档位变了）会自动重新枚举重试。

## 健壮性是怎么做的

1. **档位自动选**：先枚举，挑面积最大的档，同尺寸优先 MJPEG。相机默认档常常只有 640x360，不选就一直是糊的。
2. **档位阶梯兜底**：指定档位打不开 → 退回设备默认档再抓一次；两者都失败才报错。
3. **黑帧重试**：帧文件小得可疑时用 `signalstats` 算平均亮度（YAVG<24 判黑），帧数自动翻倍重抓。刚开相机只有黑屏是最常见的假成功。
4. **多帧取最后一帧**：等自动曝光/白平衡稳定，不交第一帧。
5. **设备缓存 + 自动纠错**：缓存里的设备打不开就重新枚举再试，不会因为缓存过期而失败。
6. **互斥锁**：一台相机同一时刻只能被一个 ffmpeg 打开，并发调用排队。
7. **取消即杀**：工具取消 → SIGKILL ffmpeg。
8. **报错翻译**：`already in use` / `Immediate exit requested` / `Could not set video options` 各自翻成人话。
9. **降级不中断**：模型不支持图片输入或单张超上限 → 只落盘给路径。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `ffmpegPath` | 自动 | 绝对路径；自动探测 PATH / WinGet Links / Homebrew / 常见安装目录 |
| `saveDir` | `$DSH_HOME/camera` | 照片与视频保存目录 |
| `defaultCamera` | `auto` | 默认机位 |
| `frames` | `10` | 抓多少帧、留最后一帧 |
| `maxFrames` | `40` | 黑帧重试上限 |
| `jpegQuality` | `2` | ffmpeg `-q:v`，2 最好 / 31 最差 |
| `resolution` | 空 | 例如 `1920x1080`；空 = 自动最高档 |
| `preferLargestMode` | `true` | 自动挑最大档；关掉就用设备默认档 |
| `maxModeEdge` | `4096` | 自动选档的单边上限 |
| `rtbufsize` | `256M` | dshow 输入缓冲，4K/高码率相机可加大 |
| `framerate` | `0` | 0 = 不指定（dshow 不使用该参数） |
| `timeoutMs` | `25000` | 单次采集上限 |
| `inlineImage` | `true` | 是否把画面内联进对话 |
| `maxInlineBytes` | 8 MiB | 超过就只给路径 |
| `promptHint` | `true` | 往系统提示里加一句"要看现场就取画面" |
| `clipSeconds` / `maxClipSeconds` | `5` / `60` | 录像默认时长与上限 |
| `clipQuality` | `23` | x264 CRF，越小越清晰 |
| `screenFramerate` | `15` | 抓屏/录屏帧率 |
| `screenDisplay` | 空 | Windows `desktop`，Linux `:0.0`，macOS `Capture screen 0` |
| `poster` | `true` | 录像后抽第一帧当封面 |
| `enableScreenTools` | `false` | 是否额外注册桌面抓屏/录屏工具 |
| `extraInputArgs` / `extraOutputArgs` | `[]` | 追加 ffmpeg 参数（塞在 `-i` 前后） |
| `laptopMatch` / `actionMatch` / `virtualMatch` | 见代码 | 设备名关键词，换设备后把真实名字加进来 |

## 接入 Insta360 Ace Pro 2

1. 用官方数据线连电脑；
2. 相机屏幕弹出 USB 模式时选 **「USB 摄像头 / Webcam」**（[官方说明](https://onlinemanual.insta360.com/acepro2/zh-cn/operation_tutorials/connect/ace-series-connect-to-computers-as-webcam-meeting-camera)）；
3. `camera_devices({ formats: true })` 应看到 `Insta360 Ace Pro 2`，角色自动识别为「运动相机」；
4. `camera_photo()`（auto 会优先用它）或 `camera_photo({ camera: "action" })`。

它作为 UVC 设备只暴露四档：`640x360 / 1280x720 / 1920x1080`（MJPEG）+ `1920x1080`（H.264），默认档是最小的 640x360，插件会自动挑 1080p。**UVC 上限就是 1080p30**：相机自己的 4K/8K 静帧不会从 USB 摄像头模式出来，要原图得走相机拍照模式或 Insta360 的 Wi-Fi 接口。

## 改完怎么生效

改 `config` 或代码后，在插件管理器里把这一行**关掉再打开**即可热重载（实测生效，不必重启 harness）；重启 harness 也行。

安装位置是 `%DSH_PROFILE_DIR%\node_modules\dsh-camera` → 指向本目录的符号链接，**别移动本目录**；要搬家重新 `install_bundle`。改包名用 `node scripts/rename.mjs <新名>`（一次同步 package.json、patch 行名和文档），别手改。

安装方式、上传 GitHub、发 npm、进插件市场的完整步骤见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 排错

| 现象 | 处理 |
| --- | --- |
| 没有检测到任何视频设备 | 系统隐私设置允许桌面应用访问相机（Windows：设置 → 隐私和安全性 → 相机） |
| 设备打不开 / 超时 | 会议软件、ToDesk、录像程序可能独占设备 |
| 分辨率报错 | `camera_devices({formats:true})` 看档位，再用 `resolution` 指定 |
| 照片发黑 | 加大 `frames`（例如 20）或 `maxFrames` |
| 抓屏是黑的 | 独占全屏/DirectX 全屏游戏截不到，换窗口化；远程桌面下 gdigrab 也可能只拿到黑屏 |
| 找不到 ffmpeg | 装 ffmpeg 后把绝对路径写进 `ffmpegPath` |
| macOS/Linux 报错 | 那两个后端未实机验证，原始 ffmpeg 错误会原样转达 |

## 结构

```
index.js          工具定义 / 配置 / 渲染
lib/ffmpeg.js     定位 ffmpeg、跑进程、报错翻译
lib/backends.js   平台后端：列设备、列档位、拼输入参数、机位选择
lib/capture.js    采集：档位阶梯、黑帧检测、录像、抓屏、抽封面
```

- 图片内联走 `ctx.get('attachments').saveImage()`，与 `read_image` 同一套附件管线，图片进会话日志、可回放；
- 视频只落盘（模型不接受视频输入），所以额外抽一帧当封面内联；
- 相机独占用进程内串行锁（`isConcurrencySafe: false`），抓屏工具不抢设备，可并行。
