# 飞鼠 Android 1.2.0

Android 8.0（API 26）及以上的原生客户端，与现有飞鼠 Mac / Windows 1.0 协议兼容。

## 安装和使用

- 安装包：项目 `dist/FlyingMouse-1.2.0-android.apk`。
- 电脑端左侧「手机」显示安装二维码。手机与电脑连接同一 Wi-Fi，扫码进入电脑提供的本地安装页，下载 APK 后按系统提示允许安装。微信扫码若无法下载，请选择「在浏览器打开」。页面显示 APK SHA-256，可与 `dist/SHA256SUMS.txt` 核对。
- 手机端和电脑端都打开飞鼠，选择发现的终端。自动发现受限时，输入电脑首页的 IPv4 和端口。
- 微信里打开图片或文件，选择「分享 / 用其他应用打开 → 飞鼠」。不同版本微信的入口可能不同；没有系统分享入口时，先保存到相册/文件，再从飞鼠选择。
- 支持系统 `ACTION_SEND`、`ACTION_SEND_MULTIPLE`，以及分享的文字。批量图片、视频、普通文件和通过系统文件选择器授权的文件夹均可发送。
- 选择接收终端，点击「发送」；电脑端确认接收。失败、取消或被拒绝后，在本次服务会话内可点「重新发送」。图片按分享来源提供的原始字节传输，飞鼠不重新压缩；若微信提供的文件已经压缩，飞鼠不会恢复原图，应先在微信下载原图。
- 电脑也可以向手机发送文件或文件夹，手机在「传输」中确认接收。
- 「已接收」页支持打开、再次分享、另存到系统文件选择器指定位置。

## 权限和存储

使用 Android `content://` URI 和临时读取授权接收分享内容，不扫描或读取微信私有聊天目录。不申请“所有文件访问权限”，相册/文件夹由系统选择器授权。

分享来源的权限可能很快过期，因此先流式复制到应用私有暂存区，再发送；这会额外占用与待发送内容相当的手机空间。重复分享的同名文件会添加序号，避免覆盖。服务重启会清理旧暂存区；暂存和网络传输均不把整个文件读入内存。

接收文件先保存在应用私有目录，每批独立子目录。文件大小和 SHA-256 校验通过后才改为正式文件名。取消或失败会清除正在接收的临时文件，已完成文件保留。退出后可在「已接收」中重新查找文件；传输卡片不跨服务重启恢复。

**卸载应用会删除未导出的接收文件**，需要长期保留的图片或文档请先「另存为」或分享出去。当前一次另存一个文件，不提供整文件夹一键导出。

## 后台运行

传输使用 Android 前台服务和可见通知，可切回微信；通知中可停止局域网服务。允许通知有助于查看接收提示。部分国产系统还需在系统设置中允许应用后台运行，系统强制结束进程会中断传输。

遵守 Android 15+ 的 dataSync 前台服务后台时限；系统回调超时时会停止服务，不规避系统限制。遇到服务停止，请重新打开飞鼠并重发中断任务。当前不支持断点续传、手机关机接收或永久后台在线。

使用 IPv4 UDP 45893 自动发现，HTTP 传输端口由启动时分配。Wi-Fi AP 隔离、VPN、手机热点配置和防火墙可能影响互通。自动发现使用 MulticastLock，不需要定位权限。

当前协议为可信局域网内明文传输，无设备配对、账号认证或端到端加密。只从可信电脑扫码下载安装，不提供公网服务。

## 图片粘贴

在消息输入框长按粘贴带 `content://` 授权的图片，或使用支持图片发送的输入法，将图片加入传输页的待发送列表，确认后发送。普通文字仍按原方式粘贴。输入法临时读权限在复制结束后释放；并非所有输入法或微信版本都会提供图片内容。

## 构建

推荐 Android Studio，JDK 17，Android SDK Platform 35、Build Tools 35.0.0。Gradle Wrapper 8.11.1 和 Android Gradle Plugin 8.9.2 已固定。

```sh
cd android
./gradlew :app:assembleDebug         # Windows 使用 gradlew.bat
./gradlew :app:assembleRelease       # 默认生成未签名 release APK
```

项目根目录也可以执行：

```sh
npm run dist:android
```

脚本调用 Gradle，签名最终 release APK，验证签名，并同步到 `assets/Linx-android.apk`，供桌面版打包后本地提供下载。该 APK 属于生成产物，被 Git 忽略，不随公开源码提交；新克隆的仓库需先构建 Android 才能在桌面版内置扫码安装包。脚本支持 `JAVA_HOME`、`ANDROID_HOME` / `ANDROID_SDK_ROOT`。本项目的本地 SDK、JDK、Gradle 缓存位于被 Git 忽略的 `android/.tooling/`。

默认开发分发签名保存在 `android/.tooling/linx-development.jks`，仅用于当前内部测试分发，未作为正式应用商店发行。**需要备份签名文件；更新安装必须使用相同签名。** 正式发布请配置自己的密钥，并通过环境变量设置 `LINX_ANDROID_KEYSTORE`、`LINX_ANDROID_KEYSTORE_PASSWORD`、`LINX_ANDROID_KEY_ALIAS`。密钥和密码不要提交仓库。

`scripts/build-android-local.cjs` 是 SDK-only 备用构建流程，用于 Gradle 仓库不可达时调试；正常交付使用 Gradle release 构建。

## 测试

```sh
npm run test:android                 # Android 原生 Java 通信核心与 Node 桌面端互传
LINX_LARGE_TEST=1 npm run test:android # 超过4 GiB文件接收与校验；Windows需按其语法设置环境变量
```

上述 JVM 测试需要 `JAVA_HOME`，以及测试专用 `org.json` JAR（设置 `LINX_JSON_JAR`）；Android 应用本身直接使用系统 JSON 实现，不依赖该 JAR。

系统 UI 测试在 `android/app/src/androidTest/`，没有第三方测试框架依赖。先构建 debug 和 AndroidTest APK，启动专用 Android 15 模拟器，然后运行：

```sh
cd android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
cd ..
node scripts/test-android-ui.cjs
```

**系统测试会清空测试设备上的飞鼠数据。** 仅对专用模拟器运行；脚本默认目标为 `emulator-5556`，可通过 `LINX_ANDROID_SERIAL` 指定其他专用测试设备。测试用文档 Provider 仅打包在测试 APK，不进入交付应用。

测试验证的是 Android 系统分享协议和受授权的内容 URI，不代表已在实体手机的特定微信版本中人工点击验收。产品不包含微信 SDK 或非公开微信目录访问。
