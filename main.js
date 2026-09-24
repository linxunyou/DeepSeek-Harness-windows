const { app, BrowserWindow, Tray, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const https = require('https');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

try {
  const userDataPath = require('path').join(__dirname, 'app-data');
  if (!require('fs').existsSync(userDataPath)) {
    require('fs').mkdirSync(userDataPath, { recursive: true });
  }
  app.setPath('userData', userDataPath);
} catch (e) {
  console.error('Failed to set userData path:', e.message);
}

const mDefaultDshVersion = 'dsh-v0.1.5-rc.2';

class DeepSeekApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.backendProcess = null;
    this.backendPort = 3080;
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`;
    this.mBackendAuthToken = '';
    this.mPnpmCommand = '';
    this.mIsQuitting = false;
    this.mUpdateChecked = false;
    this.mAppVersion = '1.1.0';
    this.mAppRepo = 'linxunyou/DeepSeek-Harness-windows';
    this.workDir = app.isPackaged
      ? path.dirname(app.getPath('exe'))
      : __dirname;
    this.dshDir = path.join(this.workDir, 'dsh-env', 'deepseek-harness');
  }

  getPnpmCommand() {
    if (this.mPnpmCommand) return this.mPnpmCommand;
    const { execSync } = require('child_process');
    try {
      execSync('pnpm --version', { stdio: 'ignore', shell: true });
      this.mPnpmCommand = 'pnpm';
      return 'pnpm';
    } catch (e) {}
    const pnpmLocations = [
      path.join(process.env.APPDATA || '', 'npm', 'pnpm.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.cmd'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'pnpm', 'pnpm.cmd'),
    ];
    for (const loc of pnpmLocations) {
      if (loc && fs.existsSync(loc)) {
        this.mPnpmCommand = loc;
        return loc;
      }
    }
    try {
      execSync('npx pnpm --version', { stdio: 'ignore', shell: true });
      this.mPnpmCommand = 'npx';
      return 'npx';
    } catch (e) {}
    try {
      console.log('[PNPM] Not found, auto-installing...');
      execSync('npm install -g pnpm', { stdio: 'pipe', shell: true, timeout: 120000 });
      execSync('pnpm --version', { stdio: 'ignore', shell: true });
      this.mPnpmCommand = 'pnpm';
      return 'pnpm';
    } catch (e) {
      throw new Error('pnpm 未安装且自动安装失败。请手动执行: npm install -g pnpm');
    }
  }

  getPnpmArgs(args) {
    if (this.getPnpmCommand() === 'npx') {
      return ['pnpm', ...args];
    }
    return args;
  }

  async init() {
    try {
      const gotTheLock = app.requestSingleInstanceLock();
      if (!gotTheLock) {
        console.warn('Single instance lock failed, continuing anyway...');
      }
    } catch (e) {
      console.warn('Single instance lock error:', e.message);
    }
    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.show();
        this.mainWindow.focus();
      } else {
        this.createMainWindow();
      }
    });
    this.createTray();
    try {
      if (!this.isDeployed()) {
        await this.deploy();
      }
      await this.startBackend();
      await this.waitForBackend();
      this.createMainWindow();
      this.checkForUpdates(true);
      setInterval(() => { this.checkForUpdates(true); }, 4 * 60 * 60 * 1000);
      setTimeout(() => this.checkForAppUpdate(), 5000);
    } catch (error) {
      console.error('Initialization error:', error);
      dialog.showErrorBox('启动失败', '错误: ' + error.message);
      app.quit();
    }
    app.on('window-all-closed', () => {});
    app.on('activate', () => {
      if (this.mainWindow === null) this.createMainWindow();
    });
    app.on('before-quit', () => {
      this.mIsQuitting = true;
      this.stopBackend();
    });
  }

  async getLatestStableVersion() {
    try {
      const mirrors = [
        'https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://ghproxy.net/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://github.com/deepseek-ai/deepseek-harness.git'
      ];
      let tagsOutput = '';
      for (const mirror of mirrors) {
        try {
          tagsOutput = await this.runCommand('git', ['ls-remote', '--tags', mirror], this.workDir, { timeout: 30000 });
          if (tagsOutput) break;
        } catch (e) { continue; }
      }
      if (!tagsOutput) return mDefaultDshVersion;
      const tags = [];
      const tagLines = tagsOutput.trim().split('\n');
      for (const line of tagLines) {
        const match = line.match(/refs\/tags\/(dsh-v([\d.]+)(?:-(alpha|beta|rc)\.(\d+))?)/);
        if (match) {
          tags.push({ tag: match[1], versionParts: match[2], preRelease: match[3] || 'stable', preNum: match[4] ? parseInt(match[4]) : 0 });
        }
      }
      if (tags.length === 0) return mDefaultDshVersion;
      const stabilityOrder = { stable: 4, rc: 3, beta: 2, alpha: 1 };
      tags.sort((a, b) => {
        const aParts = a.versionParts.split('.').map(Number);
        const bParts = b.versionParts.split('.').map(Number);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const diff = (aParts[i] || 0) - (bParts[i] || 0);
          if (diff !== 0) return diff;
        }
        const stabDiff = (stabilityOrder[a.preRelease] || 0) - (stabilityOrder[b.preRelease] || 0);
        if (stabDiff !== 0) return stabDiff;
        return a.preNum - b.preNum;
      });
      return tags[tags.length - 1].tag;
    } catch (error) {
      return mDefaultDshVersion;
    }
  }

  isDeployed() {
    return fs.existsSync(this.dshDir) && fs.existsSync(path.join(this.dshDir, 'package.json'));
  }

  getCurrentVersion() {
    const versionFile = path.join(this.dshDir, '.dsh_version');
    if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, 'utf-8').trim();
    return null;
  }

  setCurrentVersion(version) {
    fs.writeFileSync(path.join(this.dshDir, '.dsh_version'), version);
  }

  async deploy() {
    const deployWindow = new BrowserWindow({
      width: 600, height: 300, title: '正在部署 DeepSeek Harness', resizable: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    deployWindow.loadFile('deploy.html');
    try {
      this.sendStatus(deployWindow, '准备部署...', 5);
      if (!fs.existsSync(path.join(this.workDir, 'dsh-env'))) {
        fs.mkdirSync(path.join(this.workDir, 'dsh-env'), { recursive: true });
      }
      const targetVersion = await this.getLatestStableVersion() || mDefaultDshVersion;
      const mirrors = [
        'https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://ghproxy.net/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://github.com/deepseek-ai/deepseek-harness.git'
      ];
      this.sendStatus(deployWindow, '正在克隆仓库...', 10);
      let cloned = false;
      if (fs.existsSync(this.dshDir)) { cloned = true; }
      else {
        for (const mirror of mirrors) {
          try {
            await this.runCommand('git', ['clone', '--depth', '1', '--branch', targetVersion, mirror, 'deepseek-harness'],
              path.join(this.workDir, 'dsh-env'), { timeout: 300000 });
            cloned = true; break;
          } catch (e) { continue; }
        }
      }
      if (!cloned) throw new Error('所有镜像均无法克隆仓库');
      this.sendStatus(deployWindow, '正在安装依赖（可能需要几分钟）...', 40);
      await this.runCommand(this.getPnpmCommand(), this.getPnpmArgs(['install', '--registry=https://registry.npmmirror.com']), this.dshDir, { timeout: 900000 });
      this.sendStatus(deployWindow, '正在编译项目（可能需要几分钟）...', 70);
      await this.runCommand(this.getPnpmCommand(), this.getPnpmArgs(['run', 'build']), this.dshDir, { timeout: 1500000 });
      this.setCurrentVersion(targetVersion);
      this.sendStatus(deployWindow, '部署完成！', 100);
      setTimeout(() => deployWindow.close(), 1500);
    } catch (error) {
      dialog.showErrorBox('部署失败', error.message);
      deployWindow.close();
      throw error;
    }
  }

  sendStatus(win, message, progress) {
    try { if (win && !win.isDestroyed()) win.webContents.send('deploy-status', { message, progress }); } catch (e) {}
  }

  // Kill any process on port 3080
  killPortProcess() {
    try {
      const { execSync } = require('child_process');
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :3080 ^| findstr LISTENING') do taskkill /F /PID %a`,
        { stdio: 'ignore', shell: true, windowsHide: true });
    } catch (e) {}
  }

  async startBackend() {
    this.killPortProcess();

    // Try pnpm first
    try {
      const pnpmCmd = this.getPnpmCommand();
      const args = this.getPnpmArgs(['dsh', 'web', '--no-open']);
      await this.tryBackendSpawn(pnpmCmd, args);
      return;
    } catch (e) {
      console.log('[Backend] pnpm failed: ' + e.message);
    }

    // Fallback: run with node directly
    this.killPortProcess();
    this.mBackendAuthToken = '';
    console.log('[Backend] Falling back to node direct execution');
    const nodeArgs = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open'];
    await this.tryBackendSpawn('node', nodeArgs);
  }

  tryBackendSpawn(cmd, args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PORT: String(this.backendPort) };
      console.log('[Backend] Starting: ' + cmd + ' ' + args.join(' ') + ' in: ' + this.dshDir);
      this.backendProcess = spawn(cmd, args, {
        cwd: this.dshDir, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      let outputBuffer = '';
      let resolved = false;

      this.backendProcess.stdout.on('data', (data) => {
        const text = data.toString();
        outputBuffer += text;
        console.log('[Backend stdout]: ' + text.trim());
        const tokenMatch = outputBuffer.match(/http[s]?:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+/);
        if (tokenMatch && !this.mBackendAuthToken) {
          this.mBackendAuthToken = tokenMatch[0];
          console.log('[Backend] Got auth token URL');
          resolved = true;
          resolve();
        }
      });

      this.backendProcess.stderr.on('data', (data) => {
        const text = data.toString();
        outputBuffer += text;
        console.log('[Backend stderr]: ' + text.trim());
      });

      this.backendProcess.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
      });

      this.backendProcess.on('exit', (code) => {
        console.log('[Backend] Process exited with code: ' + code);
        if (!resolved) {
          resolved = true;
          reject(new Error('Backend process exited with code ' + code));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Backend startup timeout (3 minutes)'));
        }
      }, 180000);
    });
  }

  async waitForBackend() {
    for (let i = 0; i < 30; i++) {
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.backendPort, '127.0.0.1', () => { socket.end(); resolve(); });
          socket.on('error', reject);
          socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('timeout')); });
        });
        return;
      } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    throw new Error('后端服务 60 秒内无响应');
  }

  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1280, height: 800, title: 'DeepSeek Harness',
      icon: path.join(__dirname, 'icon.ico'), frame: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    this.mainWindow.on('close', (event) => {
      if (!this.mIsQuitting) { event.preventDefault(); this.mainWindow.hide(); }
    });
    if (this.mBackendAuthToken) this.mainWindow.loadURL(this.mBackendAuthToken);
    else this.mainWindow.loadURL(this.backendUrl);
    this.mainWindow.on('closed', () => { this.mainWindow = null; });
  }

  createTray() {
    this.tray = new Tray(path.join(__dirname, 'icon.ico'));
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { if (this.mainWindow) this.mainWindow.show(); else this.createMainWindow(); } },
      { label: '重启服务', click: async () => {
        try {
          this.stopBackend(); this.mBackendAuthToken = '';
          await this.startBackend(); await this.waitForBackend();
          if (this.mainWindow) this.mainWindow.loadURL(this.mBackendAuthToken || this.backendUrl);
          else this.createMainWindow();
        } catch (error) { dialog.showErrorBox('重启失败', error.message); }
      }},
      { label: '重新部署', click: async () => {
        const result = await dialog.showMessageBox({
          type: 'warning', title: '确认重新部署',
          message: '将删除当前环境并重新部署，是否继续？',
          buttons: ['确定', '取消'], defaultId: 1, cancelId: 1
        });
        if (result.response === 0) {
          try {
            this.stopBackend(); fs.rmSync(this.dshDir, { recursive: true, force: true });
            this.mBackendAuthToken = '';
            await this.deploy(); await this.startBackend(); await this.waitForBackend();
            if (this.mainWindow) this.mainWindow.loadURL(this.mBackendAuthToken || this.backendUrl);
            else this.createMainWindow();
          } catch (error) { dialog.showErrorBox('重新部署失败', error.message); }
        }
      }},
      { label: '检查更新', click: async () => { await this.checkForUpdates(false); } },
      { type: 'separator' },
      { label: '退出', click: () => { this.mIsQuitting = true; app.quit(); } }
    ]);
    this.tray.setToolTip('DeepSeek Harness 桌面版');
    this.tray.setContextMenu(contextMenu);
    this.tray.on('double-click', () => { if (this.mainWindow) this.mainWindow.show(); else this.createMainWindow(); });
  }

  async checkForUpdates(silent = false) {
    if (!this.isDeployed()) {
      if (!silent) dialog.showMessageBox({ type: 'info', title: '未部署', message: 'DeepSeek Harness 尚未部署，请先完成首次部署。', buttons: ['OK'] });
      return;
    }
    try {
      const latestVersion = await this.getLatestStableVersion();
      const currentVersion = this.getCurrentVersion();
      if (currentVersion !== latestVersion) {
        const result = await dialog.showMessageBox({
          type: 'question', title: '发现新版本',
          message: '发现新版本: ' + latestVersion + '\n当前版本: ' + (currentVersion || '未知') + '\n\n是否立即更新？\n（更新期间服务将暂时重启）',
          buttons: ['立即更新', '稍后'], defaultId: 0, cancelId: 1
        });
        if (result.response === 0) await this.performUpdate(latestVersion);
      } else if (!silent) {
        dialog.showMessageBox({ type: 'info', title: '已是最新', message: '当前已是最新版本。\n版本: ' + currentVersion, buttons: ['OK'] });
      }
    } catch (error) { if (!silent) dialog.showErrorBox('检查更新失败', error.message); }
  }

  async performUpdate(latestVersion) {
    const updateWindow = new BrowserWindow({
      width: 600, height: 300, title: '正在更新 DeepSeek Harness', resizable: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    updateWindow.loadFile('deploy.html');
    try {
      this.stopBackend();
      this.sendStatus(updateWindow, '正在更新到 ' + latestVersion + '...', 20);
      const mirrors = [
        'https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://ghproxy.net/https://github.com/deepseek-ai/deepseek-harness.git',
        'https://github.com/deepseek-ai/deepseek-harness.git'
      ];
      let fetched = false;
      for (const mirror of mirrors) {
        try { await this.runCommand('git', ['fetch', mirror, '--tags', '--force'], this.dshDir, { timeout: 120000 }); fetched = true; break; }
        catch (e) { continue; }
      }
      if (!fetched) throw new Error('所有镜像均无法获取更新');
      await this.runCommand('git', ['checkout', latestVersion], this.dshDir, { timeout: 60000 });
      this.setCurrentVersion(latestVersion);
      this.sendStatus(updateWindow, '正在安装依赖...', 50);
      await this.runCommand(this.getPnpmCommand(), this.getPnpmArgs(['install', '--registry=https://registry.npmmirror.com']), this.dshDir, { timeout: 900000 });
      this.sendStatus(updateWindow, '正在编译项目...', 80);
      await this.runCommand(this.getPnpmCommand(), this.getPnpmArgs(['run', 'build']), this.dshDir, { timeout: 1500000 });
      this.sendStatus(updateWindow, '正在重启服务...', 95);
      await this.startBackend(); await this.waitForBackend();
      this.sendStatus(updateWindow, '更新完成！', 100);
      setTimeout(() => { updateWindow.close(); if (this.mainWindow) this.mainWindow.reload(); }, 2000);
    } catch (error) { dialog.showErrorBox('更新失败', error.message); updateWindow.close(); }
  }

  async checkForAppUpdate() {
    if (this.mUpdateChecked) return;
    this.mUpdateChecked = true;
    try {
      const releaseInfo = await this.fetchLatestRelease();
      if (!releaseInfo) return;
      const latestTag = releaseInfo.tag_name.replace(/^v/, '');
      if (!this.isNewerVersion(latestTag, this.mAppVersion)) return;
      const exeAsset = releaseInfo.assets.find(a => a.name.endsWith('.exe'));
      if (!exeAsset) return;
      const result = await dialog.showMessageBox({
        type: 'question', title: '应用有新版本',
        message: '发现新版本: v' + latestTag + '\n当前版本: v' + this.mAppVersion + '\n\n是否下载并更新？',
        buttons: ['Update', 'Later'], defaultId: 0, cancelId: 1
      });
      if (result.response === 0) await this.downloadAndApplyUpdate(exeAsset, latestTag);
    } catch (error) { console.log('[AppUpdate] Check failed:', error.message); }
  }

  fetchLatestRelease() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/' + this.mAppRepo + '/releases/latest',
        headers: { 'User-Agent': 'DeepSeek-Harness-App' }
      };
      https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) resolve(JSON.parse(data));
            else { console.log('[AppUpdate] API status:', res.statusCode); resolve(null); }
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  isNewerVersion(latest, current) {
    const lParts = latest.split('.').map(Number);
    const cParts = current.split('.').map(Number);
    for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
      const l = lParts[i] || 0, c = cParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  async downloadAndApplyUpdate(asset, version) {
    const exePath = app.isPackaged ? app.getPath('exe') : null;
    if (!exePath) { require('electron').shell.openExternal(asset.browser_download_url); return; }
    const downloadPath = path.join(require('os').tmpdir(), 'DeepSeek-Harness-v' + version + '.exe');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(downloadPath);
      const doRequest = (url) => {
        https.get(url, { headers: { 'User-Agent': 'DeepSeek-Harness-App' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doRequest(res.headers.location); return; }
          const totalSize = parseInt(res.headers['content-length'], 10);
          let downloaded = 0;
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (totalSize && this.tray) this.tray.setToolTip('正在下载: ' + Math.round((downloaded / totalSize) * 100) + '%');
          });
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      };
      doRequest(asset.browser_download_url);
    });
    if (this.tray) this.tray.setToolTip('DeepSeek Harness 桌面版');
    const result = await dialog.showMessageBox({
      type: 'question', title: '更新已就绪',
      message: 'v' + version + ' 已下载完成。\n\n是否立即重启以应用更新？',
      buttons: ['立即重启', '取消'], defaultId: 0, cancelId: 1
    });
    if (result.response === 0) {
      const psScript = 'Start-Sleep -Seconds 3; Copy-Item -LiteralPath "' + downloadPath + '" -Destination "' + exePath + '" -Force; Start-Sleep -Seconds 1; Start-Process -FilePath "' + exePath + '"; Remove-Item -LiteralPath "' + downloadPath + '" -Force -ErrorAction SilentlyContinue';
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript],
        { detached: true, stdio: 'ignore', windowsHide: true });
      this.mIsQuitting = true;
      app.quit();
    }
  }

  stopBackend() {
    if (this.backendProcess) {
      try {
        if (process.platform === 'win32' && this.backendProcess.pid)
          spawn('taskkill', ['/pid', String(this.backendProcess.pid), '/T', '/F'], { windowsHide: true });
        else this.backendProcess.kill();
      } catch (e) {}
      this.backendProcess = null;
    }
  }

  runCommand(cmd, args, cwd, options = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd, shell: true, windowsHide: true, env: process.env, timeout: options.timeout || 300000 });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(cmd + ' exited with code ' + code + ': ' + stderr.slice(0, 500)));
      });
    });
  }
}

const deepSeekApp = new DeepSeekApp();
app.whenReady().then(() => deepSeekApp.init());
