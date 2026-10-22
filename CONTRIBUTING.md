# 参与贡献

欢迎改进飞鼠的跨平台发现、传输可靠性和界面体验。请在 Issue 中提供操作系统、客户端版本、网络连接方式、复现步骤与脱敏后的错误信息，不要上传真实聊天记录、私人文件或签名密钥。

## 本地开发

需要 Node.js 22+（推荐24 LTS）。

```sh
npm ci
npm start
npm run check
npm test
```

Android 开发需要 JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0，详见 [Android 说明](android/README.md)。Android 的局域网协议应保持与桌面 `linx-lan/1` 的兼容。

`npm run test:ui` 会打开独立测试窗口。Android 系统测试会清空指定测试设备上的飞鼠数据，只能用于专用模拟器。大文件测试需要足够的临时磁盘空间。

## 提交修改

1. 创建分支并说明修改目的。
2. 为协议、文件写入或权限相关改动补充针对性验证。
3. 运行语法检查和相关测试，说明未覆盖的平台或场景。
4. 提交 Pull Request，附上问题描述、实现方式与验证结果；界面改动可附截图。

请勿提交 `node_modules/`、SDK/JDK、Gradle缓存、本地配置、私钥、应用用户数据和 `dist/`。`assets/Linx-android.apk` 是构建 Android 后生成的电脑端扫码安装资源，不提交到源码仓库。请先运行 `npm run dist:android` 生成它，再打包带扫码安装功能的桌面版。发布更新必须保留正确的 Android 签名兼容关系。

项目采用 MIT License；提交贡献表示允许以该许可证分发贡献内容。
