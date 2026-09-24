# DeepSeek Harness 桌面版

将 DeepSeek Harness 网页版封装为原生桌面应用，双击即可使用，无需手动操作命令行。

## 环境要求

- **Node.js** v22 或更高版本：https://nodejs.org/
- **Git**：https://git-scm.com/
- **pnpm**（可选）：`npm install -g pnpm`，未安装时应用会自动回退到 node 直接运行

## 快速开始

双击 `start.bat` 即可启动应用。

首次运行会自动完成以下操作（耗时较长，请耐心等待）：

1. 克隆 DeepSeek Harness 仓库（使用国内镜像加速）
2. 安装依赖
3. 编译构建
4. 启动后端服务并打开窗口

后续启动会直接打开窗口，无需重复部署。

## 功能

- **原生窗口** -- 无浏览器边框，体验更流畅
- **关闭即隐藏** -- 点击关闭按钮仅隐藏窗口到系统托盘，程序继续运行
- **系统托盘** -- 右键托盘图标可管理服务
  - 显示窗口 / 重启服务 / 重新部署 / 检查更新
- **DSH 自动更新** -- 启动时自动检查新版本，每 4 小时后台检查一次
- **应用自更新** -- 启动时检查 GitHub 最新 Release，支持一键下载替换
- **pnpm 容错** -- pnpm 不可用时自动回退到 node 直接运行

## 打包为独立 .exe

双击 `build.bat`，生成 `dist/DeepSeek-Harness.exe`。

打包后的 exe 是便携版，可复制到任意电脑运行（目标电脑仍需安装 Node.js、Git）。

### 发布新版本

1. 修改 `package.json` 中的 `version` 字段
2. 同步修改 `main.js` 中的 `mAppVersion`
3. 运行 `build.bat` 生成新的 exe
4. 在 GitHub 创建 Release，上传 exe 文件
5. 用户下次启动时会自动检测到新版本

## 目录结构

```
DSH快捷工具/
  start.bat        启动应用（双击运行）
  build.bat        打包为 .exe（双击运行）
  main.js          应用主程序
  deploy.html      部署进度界面
  package.json     项目配置
  icon.ico         应用图标
  dsh-env/         DeepSeek Harness 运行环境（首次运行自动创建）
  app-data/        应用数据（运行时自动创建）
  dist/            打包输出目录
```

## 常见问题

**Q: 首次启动卡在部署进度不动？**
A: 首次部署需要下载和编译大量依赖，根据网络速度可能需要 10-30 分钟。

**Q: 启动后窗口空白？**
A: 右键系统托盘图标，选择"重启服务"，等待几秒后刷新。

**Q: 如何更新到新版本？**
A: 右键托盘图标 -> "Check for Updates"，或等待自动更新提示。

**Q: start.bat 闪退？**
A: 在命令行中手动运行 `npm start` 查看错误信息。