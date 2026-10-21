# 邻讯 · Linx LAN

开源的局域网协作客户端，支持 macOS、Windows 与 Android。无需账号和中心服务器，同一局域网的电脑可以相互发现、发消息、发送大文件和整个文件夹。

![邻讯界面](docs/screenshots/welcome.png)

## Android 手机端（新增）

已增加 Android 8.0+ 原生客户端。手机可接收微信系统分享的单张/多张图片、文件和文字，也可通过系统选择器选取图片、视频、文件或文件夹。支持电脑与手机双向传输、进度、接收确认、聊天和自定义终端名称。

安装 `dist/Linx-1.1.0-android.apk`，或在电脑端 1.1 左侧点击「手机端」，让同一 Wi-Fi 的手机扫码下载安装。已有电脑端 1.0 也兼容手机端，不强制升级。微信没有系统分享入口时，先保存图片，再从邻讯选择发送。

[Android 安装、权限、后台运行和构建说明](android/README.md)

## 已实现

- UDP 组播 + 广播自动发现，终端上下线状态；手动输入 IPv4 和端口连接，HTTP 心跳保持在线。
- 自定义终端名称，跨 macOS / Windows 双向文本聊天，中文、多行消息、未读计数和本地历史记录。
- 多文件、多个文件夹、拖放发送；递归保留子目录、空目录、零字节文件。
- 接收方确认后才写文件；可拒绝、取消、重新发送；独立传输记录和打开接收目录。
- 双方实时进度条、已传字节、速度、预计剩余时间；每个文件流式计算 SHA-256 并校验。
- 文件流带背压，内存用量不随文件大小线性增长；已测试 **4 GiB + 17 字节** 文件。
- 新建独立接收目录，不覆盖同名文件；路径穿越防护、跨平台路径检查、接收空间检查。
- 桌面通知、终端搜索、保存位置设置，应用单实例保护。

## 直接运行

构建产物在 `dist/`，不需要安装 Node.js：

- **Apple Silicon Mac**：使用文件名含 `arm64` 的 `.dmg` 或 `.zip`，也可以直接打开 `dist/mac-arm64/邻讯.app`。
- **Intel Mac**：使用不含 `arm64` 的 Mac 包，或打开 `dist/mac/邻讯.app`。
- **Windows x64**：`Setup` 文件为安装包，另一个 `.exe` 为免安装版本。`dist/win-unpacked/邻讯.exe` 为未压缩的完整应用（需保留整个文件夹）。

应用尚未使用 Apple Developer ID / Windows 代码签名证书签名或公证。macOS 如阻止首次运行，可在系统「隐私与安全性」中核实来源后允许；Windows 可能显示 SmartScreen 提示。

在两台电脑上打开邻讯，连接同一个 Wi-Fi 或有线局域网。在左侧选择对方终端即可聊天。发送文件或文件夹后，对方在右侧点击「接收文件」。点击左下角设置可修改终端名称及接收位置。

## 从源码启动

需要 Node.js 22 或更新版本（建议 Node.js 24 LTS），以及 npm。

```sh
npm ci
npm start
```

在 Windows PowerShell / 终端和 macOS 终端中均使用以上命令。依赖版本由 `package-lock.json` 固定。首次安装需要联网下载 Electron；安装完成后，客户端运行不依赖互联网。

```sh
npm run check        # JavaScript 语法检查
npm test             # 双服务集成测试
npm run test:large   # 4 GiB + 17 字节传输与哈希校验（临时磁盘至少 9 GiB）
npm run test:ui      # 真实 Electron 界面端到端测试及截图，需要图形桌面
npm run dist:android # 可选：先构建 Android APK，供桌面版内置扫码安装
npm run pack        # 当前平台的应用目录
npm run dist:mac -- --arm64 --x64
npm run dist:win -- --x64
```

macOS 的 DMG 应在 macOS 上构建。Windows 安装包优先在 Windows 构建；在 macOS 交叉构建时，electron-builder 会下载对应工具。`.github/workflows/build.yml` 提供两平台构建工作流：手动触发，或推送 `v*` 标签后，在 Actions 的 artifacts 中下载产物。源码仓库：[wonderful200x-ui/linx-lan](https://github.com/wonderful200x-ui/linx-lan)。工作流支持手动触发；桌面构建先取得 Android 构建产物以提供扫码安装功能。APK、DMG 和 EXE 等安装包不会随源码提交，可从成功的 Actions 构建产物下载或自行构建。

## 网络连接

- 自动发现：IPv4 UDP **45893**，组播地址 `239.255.77.88`，同时尝试广播。
- 消息和传输：应用启动时分配的 **TCP 端口**，本机首页和左下角显示 `IP:端口`。
- 请允许应用访问本地网络、通过 macOS / Windows 防火墙；接收目录需要可写权限。
- 自动发现失败时，在另一台电脑的「＋ → 手动连接」输入本机显示的 IPv4 地址和端口。已知终端还会使用 HTTP 心跳，维持在线状态。
- 访客 Wi-Fi 的客户端隔离、不同 VLAN、VPN 或路由器禁止组播可能影响连接；手动连接仍要求两机 TCP 可达。
- 多网卡时，首页显示各 IPv4 地址，请选择双方可互通的地址。自动发现仅覆盖当前广播域；不提供公网打洞或转发。

## 文件与数据约定

默认接收位置为系统下载目录下的「邻讯」。每批传输创建一个 `邻讯-随机字符` 目录，原始目录结构保留在其中。只有大小和 SHA-256 校验通过后，临时文件才会改成正式文件名。失败或取消时，已经成功接收的文件保留，正在接收的临时文件删除。

聊天和最近 100 条传输摘要保存为应用用户数据目录中的 `state.json`。消息保留最近 2,000 条；历史摘要不包含发送方源文件列表。终端名称和接收位置也保存在本机。

- 支持单批最多 **10,000 个文件及目录条目**，超出时请拆批发送。
- 单个文件没有人为设置 4 GB 限制，受文件系统、剩余磁盘空间及 JavaScript 安全整数范围限制。FAT32 接收盘不能保存 4 GB 以上文件。
- 同批次仅大小写不同的路径、Windows 保留名称、Windows 不支持的字符会明确报错，避免跨平台静默覆盖或丢失文件。
- 符号链接、设备文件等特殊文件不传输。文件夹传输保留路径和文件内容，不复制权限、扩展属性、资源叉或原始修改时间。
- 等待接收最长 10 分钟，网络数据停滞 60 秒会中止；应用退出时中止活动传输。当前不支持断点续传；「重新发送」会从头开始，同一次应用会话可直接重试，重启后需重新选择文件。
- 当前是局域网 **HTTP 明文传输**，没有账号、可信设备配对或端到端加密；SHA-256 用于完整性校验，不提供对端身份认证。仅用于可信局域网，终端名不代表已验证身份。

## 结构

```text
src/main.cjs          Electron 生命周期、文件选择、受限 IPC、系统通知
src/preload.cjs       隔离的桌面 API 桥接
src/core/service.cjs  发现、心跳、HTTP 协议、流式传输、完整性校验、持久化
src/ui/              HTML / CSS / JavaScript 界面，无远程页面或 CDN 依赖
test/                真实网络收发集成测试
scripts/ui-smoke.cjs  Electron 端到端测试，通过本机临时调试端口执行；生产启动无此端口
```

界面使用 Electron 的 context isolation、sandbox、禁用 Node integration 和内容安全策略；只暴露按操作划分的 IPC 方法，并验证调用页面来源。实现遵循 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security) 和 [上下文隔离文档](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。

MIT License。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [贡献指南](CONTRIBUTING.md)；已知安全边界见 [安全说明](SECURITY.md)。
