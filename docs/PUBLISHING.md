# 安装与发布

这个插件是一个标准的 DSH **bundle**：没有构建步骤、没有 npm 依赖，装上去就能用。前提只有两个：

1. DSH 0.2.1-rc.x（本机 0.2.1-rc.3 实测）；
2. 机器上有 `ffmpeg`（PATH 里能找到，或在配置里写 `ffmpegPath`）。

## 1. 三种安装方式

### A. 本地目录（开发/自用，本机当前就是这个）

```
plugin_manager install_bundle  target = D:\Programe\esp32\激光雕刻机\plugins\dsh-camera
```

`install_bundle` 会把它加进 profile 的 `package.json`，并在 `node_modules` 里做软链接。改代码后**在插件管理器里关掉再打开**即可热重载。

卸载：`plugin_manager remove_bundle  target = dsh-camera`（`~/.dsh/camera` 里的照片和缓存不会自动删）。

### B. GitHub tarball（分享给别人最省事）

```
plugin_manager install_bundle  target = https://github.com/<你的用户名>/dsh-camera/archive/refs/heads/main.tar.gz
```

本机的 `dsh-purge` 就是这个形态装的（`https://github.com/.../archive/refs/heads/master.tar.gz`），pnpm 认得 GitHub 归档里的 `repo-ref/` 前缀。

### C. npm 包

```
plugin_manager install_bundle  target = @scope/dsh-camera@1.0.0
```

插件市场里的所有条目都是这种形态（`registry: https://registry.npmjs.org/`）。

装完后：插件管理器里出现一行，默认启用，`camera_photo` / `camera_clip` / `camera_devices` 立刻注册；当前会话下一轮就能调用，新会话直接从第一轮开始有。

## 2. 上传到 GitHub

仓库根目录就放这个包的根（`package.json` 同级），别再多套一层目录。

```bash
cd plugins/dsh-camera
git init
git add .
git commit -m "feat: dsh-camera — camera photo/clip tools for DSH"
git branch -M main
git remote add origin git@github.com:<你的用户名>/dsh-camera.git
git push -u origin main
```

仓库：<https://github.com/SunNull/dsh-camera>（已发布）。`package.json` 里的 `author` / `homepage` / `repository` / `bugs` 已指向该仓库，`LICENSE` 署名 SunNull；换账号或改仓库名时同步改这四处即可。

`.gitignore` 已经排掉 `shots/`、`*.jpg`、`*.mp4`、`.camera-cache.json`，不会把拍的画面传上去。

放在 monorepo 里也行：市场索引有 `repository.directory` 字段指向子目录；但 tarball 安装要指到含 `package.json` 的那层。

## 3. 发到 npm（**可选**，只有想进插件市场才需要）

先说结论：**没有 npm 账号也完全能分发**。第 1、2 节做完，别人就能用 GitHub tarball 安装；`v1.0.0` 这个 tag 已经有了固定的归档 URL，实测能装：

```
https://github.com/SunNull/dsh-camera/archive/refs/tags/v1.0.0.tar.gz
```

npm 唯一的作用是让插件市场能索引到你（市场里 928 个条目全部指向 `registry.npmjs.org`）。

### 3.1 要发的话，先注册（一次性，约 5–10 分钟）

1. <https://www.npmjs.com/signup> 注册，**验证邮箱**——没验证邮箱不能发布（[官方文档](https://docs.npmjs.com/creating-a-new-npm-user-account)）；
2. 打开 **2FA**：Account → Two-Factor Authentication → 选 authenticator app。npm 现在强制要求：发布必须启用 2FA 或使用"带 bypass 2FA 的 granular access token"（[官方文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)）；
3. 本地登录：`npm login`（浏览器或 TOTP 交互，我不会替你操作）。

### 3.2 发布

包名已经是 `dsh-camera`（用 `node scripts/rename.mjs <新名>` 一次改全，别手改——Loader 按包名解析 patch 那一行，少改一处就是"插件在列表里有、工具一个都不出现"）。

```bash
npm pkg delete private         # 留着 private，publish 会直接拒绝
npm publish --access public
```

发布前跑一次自检（CI 跑的是同一份逻辑）：

```bash
npm run check                  # = node scripts/check-manifest.mjs
npm pack --dry-run             # 看实际打包清单
```

版本语义：新增能力 → minor；修 bug → patch；破坏性改配置字段 → major。

已装过旧名字的 profile 要重装：

```
plugin_manager remove_bundle  → 旧包名
plugin_manager install_bundle → 本目录 / tarball / 新包名
```

### 3.3 注意：registry 通，但 npm 网站可能打不开

实测记录（2026-10，中国大陆网络 + 本地代理）：

| 端点 | 结果 | 含义 |
| --- | --- | --- |
| `registry.npmjs.org/dsh-camera` | **404** | API 通（404 = 包不存在） |
| `registry.npmjs.org/-/whoami` | **401** | API 通（401 = 缺凭证） |
| `www.npmjs.com/`、`/signup` | **403**（直连和走代理都是 403） | **注册网页被挡** |

结论：**发布通道是通的，卡住的只是网页注册**。三条可选路径：

1. 换个能打开 `www.npmjs.com` 的网络把账号注册一次性做完（手机热点 / 换代理节点 / 别人的电脑），之后在本机 `npm login` 拿到 token，`npm publish` 走 registry 没问题；
2. 本机试 `npm adduser --auth-type=legacy`——它打的是 registry API 而不是网页，理论上可行（npm 是否仍允许 API 建号不保证）；
3. **不用 npm**：见第 1 节，GitHub tarball 已经是完整的分发通道，唯一损失是进不了插件市场。

## 4. 进插件市场（可选）

市场索引里的一个真实条目长这样（本机 `plugin_market` 抓的）：

```json
{
  "name": "@scope/dsh-camera",
  "title": "Camera Capture",
  "description": "拍不到就别说看到了：给会话加摄像头拍照/录像。",
  "author": "you",
  "homepage": "https://github.com/you/dsh-camera#readme",
  "repository": { "url": "https://github.com/you/dsh-camera" },
  "category": "tools",
  "labels": ["camera", "vision"],
  "defaultVersion": {
    "version": "1.0.0",
    "install": { "target": "@scope/dsh-camera@1.0.0", "registry": "https://registry.npmjs.org/" }
  }
}
```

两步：先发 npm（第 3 步），再往索引仓库提 PR（本机默认源之一是 `polang233/dsh-plugin-index`）。也可以只在 Settings → 插件市场里加自己的 index 源自用。

## 5. 合规自查（对照 DSH bundle 要求）

| 要求 | 本插件 | 说明 |
| --- | --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | ✅ | `./cordis.patch.yml` |
| 包内零依赖、无构建 | ✅ | 只用 Node 内置模块，`type: module`，无需 tsc/esbuild |
| 多语言展示信息 `meta.title` / `meta.description` | ✅ | `locale/zh.json` + `locale/en.json` |
| 图标 | ✅ | 原创 `icon.svg`（1 KB，`exports["./icon"]`） |
| `files` 覆盖所有运行时文件 | ✅ | `index.js`、`lib/*.js`、patch、locale、icon、README、LICENSE |
| 注册即副作用归 `ctx.effect` | ✅ | 工具与 prompt section 都在 effect 里，卸载即撤 |
| 可选服务用 `inject` / `ctx.inject` | ✅ | `tools` 硬依赖；`systemPrompt`、`attachments`、`llm` 都是可选探测 |
| 不新增自定义 session 事件类型 | ✅ | 不写日志，只读 `attachments` / `llm` |
| 配置走 patch 的 `row.config` | ✅ | 无需 `Config` 导出（与 dsh-purge 同做法） |
| LICENSE | ✅ | MIT |
| `repository` / `homepage` / `bugs` | ⚠️ 占位符 | 按第 2 步替换 |
| `engines.dsh` 硬版本闸 | ⚠️ 未设 | 有意不设：只声明了信息性的 `dshTarget: "0.2.1-rc.3"`，避免把未来版本挡在门外 |
| 跨平台声明 | ⚠️ Windows 实测 | macOS(`avfoundation`) / Linux(`v4l2`) 代码已写但**未实机验证**，README 已注明 |

## 6. 已知边界

- UVC 上限 1080p30：相机的 4K/8K 静帧不会从 USB 摄像头模式出来；
- 首次拍照约 6 s（缓存空时枚举设备 + 列档位），之后约 3.2 s，瓶颈是相机自身初始化 2.9 s；
- 依赖外部 `ffmpeg`，不随包分发；
- 同一台相机同一时刻只能被一个进程占用，插件内部排队，但挡不住外部程序（会议软件、ToDesk）。
