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

主程序需要 Node.js 24 或更高版本。发布包已经包含 TypeScript 应用依赖；安装器会预装当前主机对应的 worker，并安装 `devshell` 与受管 `pi` launcher。使用发布包时不需要 pnpm 或 Rust。

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

安装脚本会下载并校验：

1. 当前 control 主机对应的 worker。

连接到其他操作系统或架构时，control 会根据探测到的目标从同一版本 Release 按需下载并校验 worker。安装器会把实际 Release 资产目录记录到安装清单中，因此使用镜像或其他仓库安装后，后续按需下载仍沿用该来源。

Windows 使用 PowerShell 安装器：

```powershell
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1 -OutFile install-release.ps1
Invoke-WebRequest https://github.com/Aromatic05/portable-devshell/releases/latest/download/install-release.ps1.sha256 -OutFile install-release.ps1.sha256
$expected = ((Get-Content install-release.ps1.sha256 -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 install-release.ps1).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 verification failed" }
powershell -ExecutionPolicy Bypass -File .\install-release.ps1
```

升级已有安装时，安装器会保留运行态：若安装前 Control 正在运行，则记录非 Reverse 且处于 `running`、`starting` 或 `stale` 的实例，在新版本激活后重新启动 Control 并恢复这些实例。安装前 Control 若已停止，则安装完成后仍保持停止。安装在切换版本后失败时，会在回滚旧版本后尝试恢复原运行态。

安装指定版本：

```bash
PORTABLE_DEVSHELL_VERSION=<version> sh install-release.sh
```

安装其他仓库的构建：

```bash
PORTABLE_DEVSHELL_RELEASE_REPOSITORY=owner/repository sh install-release.sh
```

使用镜像或自建 Release 资产目录：

```bash
PORTABLE_DEVSHELL_RELEASE_BASE_URL=https://mirror.example.com/portable-devshell/v<version> sh install-release.sh
```

安装完成后先确认 CLI 与 Control：

```bash
devshell --version
devshell status
```

### 安装 Agent Extension 与 Pi Provider

Agent 不属于 Control builtin Extension。需要 Agent/Pi 时，再从同一 Release 安装公共 Agent Extension 和当前主机对应的 Pi Provider。以 Linux x86-64 为例：

```bash
base=https://github.com/Aromatic05/portable-devshell/releases/latest/download
target=linux-x64

for asset in \
  portable-devshell-agent.dsext \
  portable-devshell-agent-provider-pi-$target.dsprovider; do
  curl -fLO "$base/$asset"
  curl -fLO "$base/$asset.sha256"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c portable-devshell-agent.dsext.sha256
  sha256sum -c portable-devshell-agent-provider-pi-$target.dsprovider.sha256
else
  shasum -a 256 -c portable-devshell-agent.dsext.sha256
  shasum -a 256 -c portable-devshell-agent-provider-pi-$target.dsprovider.sha256
fi

devshell start
devshell extension install "$PWD/portable-devshell-agent.dsext"
devshell agent provider install "$PWD/portable-devshell-agent-provider-pi-$target.dsprovider"
pi --version
```

`target` 可取 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`windows-x64` 或 `windows-arm64`。Windows 使用对应 `.dsprovider`，并按上文 PowerShell 的 `Get-FileHash` 方法校验两个资产后执行相同的 `devshell extension install` / `devshell agent provider install` 命令。

`pi` launcher 本身随主程序安装，但不会隐式安装或更新 Agent Extension/Provider；Provider 未安装时会明确提示运行 `devshell agent provider install <bundle>`。Provider 更新使用 `devshell agent provider update <bundle>`。

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
2. 从指定 GitHub Release 下载当前主机对应的 worker；
3. 对预装 worker 校验 SHA-256 并安装到版本化目录；
4. 只有某个 Release asset 找不到或下载失败时，才尝试在本地构建该 target；
5. 在切换版本前后分别执行 CLI 启动验证；
6. 安装应用，并在 Unix 创建 `~/.local/bin/devshell` 和 `~/.local/bin/pi`，在 Windows 创建对应的 `.cmd` 入口；受管 `pi` launcher 从当前 Pi Provider 加载 portable-devshell bridge，但 Pi 本体只由 Provider 首次引导到稳定私有安装目录。之后 `pi update` 与 `pi install/remove/update` 管理该私有 Pi runtime 和插件，不会被 portable-devshell/Provider 升级覆盖；Agent 模式仍只暴露 DevShell 投影工具。
7. 如果安装前 Control 正在运行，恢复 Control 以及当时由它管理的运行中实例。

当前主机 worker 用于本地实例。其他远程目标由 control 在首次连接时根据探测结果按需取得，不应在每次安装时下载全部平台。

本地回退构建受宿主工具链能力限制。正式发布仍必须保证六个目标的 Worker 资产全部存在，按需下载不能依赖安装端跨操作系统构建。

## 安装位置

```text
~/.local/bin/devshell
~/.local/bin/pi
~/.local/share/portable-devshell/current/
~/.local/share/portable-devshell/versions/<version>/
~/.devshell/bin/devshell-worker
~/.devshell/bin/devshell-worker-<host-target>
~/.devshell/workers/<target>/<sha256>/devshell-worker
~/.devshell/release-cache/workers/<tag>/<target>/<sha256>/devshell-worker
~/.local/share/portable-devshell/extension-data/agent/providers/pi/install/
~/.local/share/portable-devshell/extension-data/agent/providers/pi/state/pi/
```

`~/.devshell/bin/` 中会包含当前主机 target 的带后缀 worker；默认 `devshell-worker` 指向/对应这个 host target。其他 target 只在 provider 首次需要连接时进入 release cache，并从对应 Release 取得。

Windows 对应位置：

```text
%USERPROFILE%\.local\bin\devshell.cmd
%USERPROFILE%\.local\bin\pi.cmd
%LOCALAPPDATA%\portable-devshell\current\
%LOCALAPPDATA%\portable-devshell\versions\<version>\
%USERPROFILE%\.devshell\bin\devshell-worker.exe
%USERPROFILE%\.devshell\workers\<target>\<sha256>\devshell-worker.exe
%USERPROFILE%\.devshell\release-cache\workers\<tag>\<target>\<sha256>\devshell-worker.exe
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

重新运行相同安装方式即可。安装器会先记录当前 Control/instance 运行态，再构建或下载候选版本、完成候选 CLI 验证，之后才切换版本。若安装前 Control 正在运行，切换后会恢复 Control 与原本由它管理的运行中实例；失败时会尝试回滚旧版本并恢复原运行态。

Reverse instance 是 self-managed，不由本机安装器主动启动；升级后由远端 worker 自行重连。

## 卸载

先停止 control：

```bash
devshell stop
```

标准安装会让 `PORTABLE_DEVSHELL_BIN_DIR` 中的 `pi` 指向 portable-devshell 的受管 launcher，但不会写入 `~/.pi/agent/extensions/`。停止 Control 后删除这两个命令和程序文件：

```bash
rm -f ~/.local/bin/devshell
rm -f ~/.local/bin/pi
rm -rf ~/.local/share/portable-devshell
```

安装事务失败时会恢复安装前的 `pi` 命令；成功安装后该命令由 portable-devshell 接管，目前不会保留供未来卸载自动恢复的长期副本。如果该路径原先已有需要保留的 `pi` 命令，请在首次安装前自行备份或使用不同的 `PORTABLE_DEVSHELL_BIN_DIR`。自定义安装路径时，上述卸载命令也应替换成对应路径。

Windows PowerShell：

```powershell
$root = Join-Path $env:LOCALAPPDATA "portable-devshell"
$bin = Join-Path $HOME ".local\bin"
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $bin "devshell.cmd")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $bin "pi.cmd")
Remove-Item -Recurse -Force $root
```

`~/.devshell` 包含配置、实例状态、日志和 worker。只有确认不再需要这些数据时才删除。
