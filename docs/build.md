# 打包与分发

面向「拿到源码要出安装包」的人。桌面产物在 `apps/desktop/dist/`，Android 产物在
`apps/mobile/android/app/build/outputs/apk/`。

---

## 0. 一句话结论

| 目标 | 命令 | 推荐系统 | 产物 |
|---|---|---|---|
| Windows 安装器 | `npm run dist:win` | **Windows**（或装了 Wine 的 macOS/Linux） | `ClassRoom-Setup-1.1.3-x64.exe` |
| Windows 免安装 zip | `electron-builder --win zip ...`（见第 3 节） | 任意系统 | `ClassRoom-1.1.3-win-x64.zip` |
| macOS 安装包 | `npm run dist:mac` | **macOS** | `ClassRoom-1.1.3-arm64.dmg` / `-x64.dmg`（+ zip） |
| Android APK | 见第 4 节 | macOS / Windows / Linux | `app-release.apk` |
| Web 静态站 | `npm run build:web -w @classroom/desktop` | 任意系统 | `apps/mobile/www/` |
| 免安装目录（调试） | `npm run pack:dir` | 当前系统 | `dist/win-unpacked/` 或 `dist/mac*/` |

**跨平台打包的现实**：dmg 依赖 macOS 的 `hdiutil`；Windows NSIS 安装器需要 Wine 来改 PE
资源（图标/版本号）。本仓库交付时在 macOS 上用 `signAndEditExecutable: false` 出了
**Windows x64 免安装 zip**，没有出 NSIS 安装器。

---

## 1. 前置条件

- Node ≥ 22（`node:sqlite` 与 electron 安装脚本需要；本机 Node 20 时测试可改用 Electron 的 Node）
- 首次打包会自动下载对应平台的 Electron 二进制（约 100MB），国内网络慢就设镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

- `electron` 的版本**必须是精确版本**（`45.0.0`，不能是 `^45.0.0`）。

---

## 2. macOS

```bash
npm install
npm run dist:mac          # 同时出 arm64 与 x64
```

产物（`apps/desktop/dist/`）：

- `ClassRoom-1.1.3-arm64.dmg`（Apple Silicon）
- `ClassRoom-1.1.3-x64.dmg`（Intel）
- 同名 `.zip`（自动更新要用，也方便不进 dmg 直接解压）

### 签名状态

当前配置是 `identity: '-'`，也就是 **ad-hoc 签名**：

- 能在任何 Mac 上正常启动（Apple Silicon 上不签名会直接报「已损坏」）
- 但**没有经过 Apple 公证**，别人下载第一次打开要右键 → 打开，或者执行
  `xattr -dr com.apple.quarantine /Applications/ClassRoom.app`

### 换成正式签名 + 公证

有 Apple Developer 账号（$99/年）之后：

1. 删掉 `apps/desktop/electron-builder.yml` 里 `mac.identity: '-'` 这一行
2. 设置环境变量：

```bash
export CSC_LINK=/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD=证书密码
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com 生成
export APPLE_TEAM_ID=XXXXXXXXXX
```

3. 重新 `npm run dist:mac`

`hardenedRuntime: true` 与 `build/entitlements.mac.plist` 里的 JIT / 摄像头 / 麦克风
entitlement 已经配好，不用改。

---

## 3. Windows

### 3.1 在 Windows 上出 NSIS 安装器

```bash
npm install
npm run dist:win
```

产物：`apps/desktop/dist/ClassRoom-Setup-1.1.3-x64.exe`

安装器行为（`electron-builder.yml` 的 `nsis` 段）：

- 非一键安装，可以自己选目录
- 装到当前用户目录，**不触发 UAC**
- 生成桌面 + 开始菜单快捷方式
- 卸载时保留 `%APPDATA%\ClassRoom`，重装不用重新登录

**首次运行会弹 SmartScreen「Windows 已保护你的电脑」**：因为没买代码签名证书，
这是预期行为，点「更多信息 → 仍要运行」。要去掉这个提示只能买 OV/EV 证书，
配好之后在环境变量里给 `CSC_LINK` / `CSC_KEY_PASSWORD` 即可，配置不用改。

### 3.2 在 macOS 上出免安装 zip（无 Wine 的可行路径）

```bash
cd apps/desktop
npm run build
npx electron-builder --win --x64 \
  -c.win.target=zip \
  -c.win.signAndEditExecutable=false \
  -c.win.artifactName='ClassRoom-${version}-win-${arch}.${ext}'
```

`signAndEditExecutable: false` 会跳过 rcedit（即跳过改图标/版本资源），因此不需要 Wine；
zip 里的 exe 仍是有效的 Electron 应用，只是文件属性里没有自定义图标/版本信息。
把 zip 解压后双击 `ClassRoom.exe` 即可运行。产物未在真实 Windows 上启动验证，
首次验收请按交付目录的 `README.md` 检查。

### Windows 权限说明

Electron 没有「申请摄像头权限」的 API，Windows 也不弹授权框。实际规则是：

- 系统设置 → 隐私和安全性 → 相机 → **允许桌面应用访问相机** 必须是开
- 被关掉时 `getUserMedia` 直接抛 `NotAllowedError`，客户端会提示并给一个
  「打开设置」按钮，点了直接跳到上面那个设置页

---

## 4. Android

工程在 `apps/mobile`，Capacitor 7 复用 `apps/desktop` 的 React 渲染层，没有第二套 UI。

### 4.1 环境

- JDK 21
- Android SDK Platform 35 + Build-Tools 35
- `apps/mobile/android/local.properties` 指向本机 SDK（Android Studio 打开工程会自动重写）

本仓库验证环境：

```text
JAVA_HOME=~/.classroom-toolchain/jdk-21.0.13+9/Contents/Home
sdk.dir=~/.classroom-toolchain/android-sdk
AVD: Pixel 7 / Android 15 (API 35) / arm64
```

### 4.2 构建

```bash
# 1) 构建共享前端（输出到 apps/mobile/www）
npm run build:web -w @classroom/desktop

# 2) 同步进 Android 工程
cd apps/mobile
npx cap sync android

# 3) debug 包（可直接安装）
cd android && ./gradlew assembleDebug

# 4) release 包（正式签名见 4.3）
./gradlew assembleRelease
```

产物：

- `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`

安装：

```bash
adb install -r app-release.apk
```

### 4.3 签名

`app/build.gradle` 从环境变量读取签名信息，未提供时 release 产物是未签名包：

```bash
export CLASSROOM_KEYSTORE=/绝对路径/classroom-release.jks
export CLASSROOM_KEYSTORE_PASSWORD=******
export CLASSROOM_KEY_ALIAS=classroom
export CLASSROOM_KEY_PASSWORD=******
./gradlew assembleRelease
```

> **keystore 与密码不要提交到仓库，也不要在聊天/文档里明文记录。**
> 本机验证用的 keystore 放在 `~/.classroom-toolchain/classroom-release.jks`，交付时不在仓库内。
> 升级安装必须使用同一份 keystore，否则 Android 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，
> 只能卸载重装（会清掉本地登录态）。请把 keystore 与密码单独备份。

### 4.4 服务器地址与 CORS

- 登录页有「服务器地址」输入框，可改成电脑的局域网 IP（例如 `http://192.168.1.10:8080`）。
- 模拟器访问宿主机默认 `http://10.0.2.2:8080`。
- 服务端 `.env` 的 `ALLOWED_ORIGINS` 默认已包含 `http://localhost`、`https://localhost`、
  `capacitor://localhost`、`file://`、`null`；局域网 IP 作为 API 目标不受 Origin 白名单影响，
  但如果你把 Web 构建部署到别的域名，需要把该域名加进去。
- Android 使用明文 HTTP 访问局域网服务器：`AndroidManifest.xml` 开了
  `usesCleartextTraffic`，`capacitor.config.ts` 开了 `cleartext` 与 `allowMixedContent`。
  正式公网部署建议改用 HTTPS，然后关闭这两个开关。

### 4.5 权限与已知差异

- 相机/麦克风权限由 `MediaPermissionsPlugin` 主动申请，同时保留 Capacitor 的
  `BridgeWebChromeClient` 兜底；`setMediaPlaybackRequiresUserGesture(false)` 保证远端音频自动播放。
- Android 15 起强制 edge-to-edge，配置了 `adjustMarginsForEdgeToEdge: 'force'`，
  WebView 收进状态栏/手势条内，底部导航不会压到系统手势条。
- **移动端隐藏屏幕共享按钮**：Android 只做接收端，不能发起共享。
- 移动端课堂侧栏变成底部抽屉（成员/聊天/互动），顶部栏保留人数、聊天、视频/白板/课件与离开。
- 进入后台再回来会保留登录态与课堂连接；系统可能回收 WebView，回收后重新进入即可。

### 4.6 验收路径（模拟器/真机）

1. 起服务端（服务端日志出现监听 8080）
2. 安装 APK，打开，允许相机/麦克风（若登录页服务器地址不对，先改成 `http://10.0.2.2:8080` 或电脑局域网 IP）
3. 用教师账号登录 → 工作台 → 课堂 → 输入 6 位入会码 → 进入
4. 检查本机视频预览、麦克风状态、成员/聊天/互动抽屉、白板落笔、课件弹窗
5. 老师点「下课」→ 回到课堂列表 → 「查看记录」核对时长/人数/白板页数

---

## 5. 一次出三端：GitHub Actions

`.github/workflows/build.yml` 已配置 macOS 与 Windows runner。要正式签名的 mac 包，
在仓库 Secrets 里配 `CSC_LINK`(base64 的 p12)、`CSC_KEY_PASSWORD`、`APPLE_ID`、
`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，workflow 会自动使用。
Android 需要额外配置 keystore 的 base64 Secret 与四个签名环境变量，参考 4.3。

---

## 6. 图标

三个平台图标都由 `scripts/make-icon.py` 从一张 1024 PNG 派生：

```bash
python scripts/make-icon.py     # 需要 pillow：pip install pillow
```

生成 `apps/desktop/build/icon.png`、`icon.ico`（Windows）、`icon.icns`（macOS）。
Android 图标在 `apps/mobile/android/app/src/main/res/mipmap-*`，改完重新 sync/build。

---

## 7. 打包后连哪台服务器

`apps/desktop/src/main/index.ts`：

```ts
const DEFAULT_SERVER =
  (import.meta.env.MAIN_VITE_SERVER_URL as string | undefined)?.trim() || 'http://localhost:8080';
```

- 本轮交付默认连本机 `http://localhost:8080`（验收时先起服务端）
- 构建时可用 `apps/desktop/.env.production` 的 `MAIN_VITE_SERVER_URL` 改默认值
- 运行时可用 `CLASSROOM_SERVER_URL=...` 临时覆盖
- Android 在登录页直接改服务器地址，无需重新打包

---

## 8. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `Electron version "^45.0.0" is a range` | 版本写了 `^` | 改成精确版本 `45.0.0` |
| 打出来的包装完白屏 | `out/` 没重新构建 | 用 `npm run dist:*`，它自带 build |
| 安装包体积异常大（>150MB） | 生产依赖被塞进 asar | 检查 `dependencies` 是否为空；`pdfjs-dist` 必须留在 `devDependencies` |
| mac 包在 Apple Silicon 上「已损坏」 | 未签名/签名无效 | 确认 `identity: '-'` 或正式证书；必要时 `xattr -dr com.apple.quarantine` |
| Windows 装完摄像头打不开 | 系统隐私开关关了 | 系统设置 → 隐私和安全性 → 相机 → 允许桌面应用访问相机 |
| Android `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 新包与已安装包签名不同 | 用同一 keystore 重签，或 `adb uninstall com.hcf.classroom` 后重装 |
| Android 底部导航被手势条挡住 | 未处理 Android 15 edge-to-edge | 保持 `adjustMarginsForEdgeToEdge: 'force'`，并重建 APK |
| Android 登录 `Failed to fetch` | 服务器地址/局域网不通 | 模拟器用 `10.0.2.2`，真机用电脑局域网 IP，确认 8080 未走系统代理 |

---

## 9. 本次产物与验证状态（2026-10-28）

| 平台 | 产物 | 已做验证 |
|---|---|---|
| macOS arm64 | `ClassRoom-1.1.3-arm64.dmg` / `.zip` | 实际启动、登录进入工作台，重启后会话恢复；默认连本机 8080 |
| macOS x64 | `ClassRoom-1.1.3-x64.dmg` / `.zip` | 产物结构、签名与 dmg 校验通过；未在 Intel 真机启动 |
| Windows x64 | `ClassRoom-1.1.3-win-x64.zip` | PE32+ x64、asar 版本与默认服务器地址已核对；未在真实 Windows 启动 |
| Android | `app-release.apk`（1.1.3 / 10103，已签名） | Pixel 7 API 35 模拟器完整 E2E：登录、课堂、白板、课件、互动、下课与课堂记录 |

> 在设置了 `ELECTRON_RUN_AS_NODE=1` 的终端里直接启动 mac 包会立刻退出且没有窗口。
> 这是环境变量让 Electron 退化成纯 Node，不是包损坏；`unset ELECTRON_RUN_AS_NODE` 后再启动。

> macOS 首次登录会用 `safeStorage` 加密 refresh token，可能弹一次钥匙串授权，选「允许」即可。
> 本次自动化验收用 `--use-mock-keychain` 跳过了该弹窗；正常双击启动不需要这个参数，
> 弹窗属于系统正常行为。截图见 `docs/screenshots/macos/02-workbench.png`。
