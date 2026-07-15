# 安装与升级

当前支持：

```text
Linux x86-64
Linux arm64
macOS x86-64
macOS arm64
Windows x86-64
Windows arm64
```

主程序需要 Node.js 24 或更高版本。发布包已经包含 TypeScript 应用依赖和对应平台的 worker；使用发布包时不需要 pnpm 或 Rust。

## 从 GitHub Release 安装

先下载并校验安装脚本：

```bash
curl -fLO https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.sh
curl -fLO https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.sh.sha256

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c install-release.sh.sha256
else
  shasum -a 256 -c install-release.sh.sha256
fi

sh install-release.sh
```

安装脚本会下载并校验全部六个平台的 worker，而不是只下载 control 主机对应的平台。这样 control 后续连接 Linux、macOS、Windows、x86-64 或 arm64 目标时，都可以直接安装匹配的 worker。

Windows 使用 PowerShell 安装器：

```powershell
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1 -OutFile install-release.ps1
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1.sha256 -OutFile install-release.ps1.sha256
$expected = ((Get-Content install-release.ps1.sha256 -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 install-release.ps1).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 verification failed" }
powershell -ExecutionPolicy Bypass -File .\install-release.ps1
```

安装指定版本：

```bash
PORTABLE_DEVSHELL_VERSION=0.4.2 sh install-release.sh
```

安装其他仓库的构建：

```bash
PORTABLE_DEVSHELL_RELEASE_REPOSITORY=owner/repository sh install-release.sh
```

使用镜像或自建 Release 资产目录：

```bash
PORTABLE_DEVSHELL_RELEASE_BASE_URL=https://mirror.example.com/portable-devshell/v0.4.2 sh install-release.sh
```

## 从源码安装

源码安装需要：

- Node.js 24 或更高版本
- pnpm 10.13.1
- rustup 和稳定版 Rust

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm install:local
```

`install:local` 会：

1. 构建 TypeScript 应用；
2. 从指定 GitHub Release 下载 Linux、macOS、Windows 的 x64/arm64 六个 worker；
3. 对每个 worker 校验 SHA-256 并安装到版本化目录；
4. 只有某个 Release asset 找不到或下载失败时，才尝试在本地构建该 target；
5. 安装应用，并在 Unix 创建 `~/.local/bin/devshell`，在 Windows 创建 `%USERPROFILE%\.local\bin\devshell.cmd`。

control 主机的平台不代表 worker 目标平台。Windows control 可以管理 Linux SSH/reverse worker，macOS control 也可能向 Linux SSH、Docker 或 Podman 环境安装 worker，因此不能只准备本机 target。

本地回退构建受宿主工具链能力限制。正式发布必须保证六个 Release asset 全部存在，不能依赖安装端跨操作系统构建。

## 安装位置

```text
~/.local/bin/devshell
~/.local/share/portable-devshell/current/
~/.local/share/portable-devshell/versions/<version>/
~/.devshell/bin/devshell-worker
~/.devshell/bin/devshell-worker-linux-x64
~/.devshell/bin/devshell-worker-linux-arm64
~/.devshell/bin/devshell-worker-darwin-x64
~/.devshell/bin/devshell-worker-darwin-arm64
~/.devshell/workers/<target>/<sha256>/devshell-worker
~/.devshell/bin/devshell-worker-windows-x64.exe
~/.devshell/bin/devshell-worker-windows-arm64.exe
```

Windows 对应位置：

```text
%USERPROFILE%\.local\bin\devshell.cmd
%LOCALAPPDATA%\portable-devshell\current\
%LOCALAPPDATA%\portable-devshell\versions\<version>\
%USERPROFILE%\.devshell\bin\devshell-worker.exe
%USERPROFILE%\.devshell\workers\<target>\<sha256>\devshell-worker.exe
```

可以通过以下变量覆盖路径：

```text
PORTABLE_DEVSHELL_INSTALL_ROOT
PORTABLE_DEVSHELL_BIN_DIR
PORTABLE_DEVSHELL_HOME
XDG_DATA_HOME
```

## PATH

安装完成后若 shell 找不到 `devshell`，把下面目录加入 PATH：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

然后写入 `~/.bashrc`、`~/.zshrc` 或对应 shell 配置。

Windows 把 `%USERPROFILE%\.local\bin` 加入用户 PATH。

## 升级

重新运行相同安装方式即可。安装器会先停止现有 control daemon，再原子切换到新版本。

## 卸载

先停止 control：

```bash
devshell stop
```

再删除程序文件：

```bash
rm -f ~/.local/bin/devshell
rm -rf ~/.local/share/portable-devshell
```

`~/.devshell` 包含配置、实例状态、日志和 worker。只有确认不再需要这些数据时才删除。
