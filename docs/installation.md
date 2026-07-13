# 安装与升级

当前支持：

```text
Linux x86-64
Linux arm64
macOS x86-64
macOS arm64
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

安装脚本会下载并校验全部四个平台的 worker，而不是只下载 control 主机对应的平台。这样 control 后续连接 Linux、macOS、x86-64 或 arm64 目标时，都可以直接安装匹配的 worker。

安装指定版本：

```bash
PORTABLE_DEVSHELL_VERSION=0.4.0 sh install-release.sh
```

安装其他仓库的构建：

```bash
PORTABLE_DEVSHELL_RELEASE_REPOSITORY=owner/repository sh install-release.sh
```

使用镜像或自建 Release 资产目录：

```bash
PORTABLE_DEVSHELL_RELEASE_BASE_URL=https://mirror.example.com/portable-devshell/v0.4.0 sh install-release.sh
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
2. 从指定 GitHub Release 下载 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 四个 worker；
3. 对每个 worker 校验 SHA-256 并安装到版本化目录；
4. 只有某个 Release asset 找不到或下载失败时，才尝试在本地构建该 target；
5. 安装应用，并创建 `~/.local/bin/devshell`。

control 主机的平台不代表 worker 目标平台。即使 control 运行在 macOS，也可能需要向 Linux SSH、Docker 或 Podman 环境安装 worker，因此不能只准备本机 target。

本地回退构建受宿主工具链能力限制。例如 Linux 通常只能可靠构建 Linux target，macOS 通常只能可靠构建 macOS target。正式发布必须保证四个 Release asset 全部存在，不能依赖安装端跨操作系统构建。

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
