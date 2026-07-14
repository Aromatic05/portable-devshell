#!/bin/sh
set -eu

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "缺少必需命令：$1" >&2
        exit 1
    fi
}

download() {
    curl --fail --location --silent --show-error "$1" --output "$2"
}

read_sha() {
    awk 'NR == 1 { print $1 }' "$1"
}

verify_sha256() {
    file=$1
    sha_file=$2
    expected=$(read_sha "$sha_file")
    case "$expected" in
        *[!0-9a-fA-F]*|'') echo "无效的 SHA-256 文件：$sha_file" >&2; exit 1 ;;
    esac
    if [ "${#expected}" -ne 64 ]; then
        echo "无效的 SHA-256 长度：$sha_file" >&2
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$file" | awk '{ print $1 }')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
    else
        echo "缺少 sha256sum 或 shasum。" >&2
        exit 1
    fi
    if [ "$actual" != "$expected" ]; then
        echo "SHA-256 校验失败：$file" >&2
        exit 1
    fi
}

cleanup_control_runtime() {
    pid_file=$1
    rm -f "$pid_file"
    if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
        runtime_directory="$XDG_RUNTIME_DIR/portable-devshell"
    else
        runtime_identity=$(node -p 'typeof process.getuid === "function" ? process.getuid() : (process.env.USER || process.env.USERNAME || "user")')
        runtime_directory="${TMPDIR:-/tmp}/portable-devshell-$runtime_identity"
    fi
    rm -f "$runtime_directory/control.sock"
}

control_process_running() {
    kill -0 "$1" >/dev/null 2>&1
}

wait_for_control_exit() {
    pid=$1
    remaining=$2
    while [ "$remaining" -gt 0 ]; do
        if ! control_process_running "$pid"; then
            return 0
        fi
        sleep 1
        remaining=$((remaining - 1))
    done
    ! control_process_running "$pid"
}

stop_installed_control() {
    current_cli=$1
    pid_file="$devshell_home/control/control.pid"

    if [ -f "$current_cli" ]; then
        if node "$current_cli" stop >/dev/null 2>&1 && [ ! -f "$pid_file" ]; then
            return 0
        fi
        echo "当前 CLI 未能完整停止 control，尝试使用经过验证的 PID 恢复。" >&2
    fi

    if [ ! -f "$pid_file" ]; then
        return 0
    fi

    IFS= read -r control_pid < "$pid_file" || control_pid=
    case "$control_pid" in
        ''|*[!0-9]*) echo "control PID 文件无效：$pid_file" >&2; return 1 ;;
    esac
    if [ "$control_pid" -le 0 ]; then
        echo "control PID 文件无效：$pid_file" >&2
        return 1
    fi

    if ! control_process_running "$control_pid"; then
        cleanup_control_runtime "$pid_file"
        return 0
    fi

    command_line=$(ps -p "$control_pid" -o command= 2>/dev/null || true)
    case "$command_line" in
        *ControlDaemon.js*) ;;
        *) echo "拒绝终止 PID $control_pid：PID 文件指向的进程不是可验证的 ControlDaemon.js。" >&2; return 1 ;;
    esac
    case "$command_line" in
        *portable-devshell*) ;;
        *) echo "拒绝终止 PID $control_pid：进程命令行不属于 portable-devshell。" >&2; return 1 ;;
    esac

    if ! kill -TERM "$control_pid" 2>/dev/null; then
        if ! control_process_running "$control_pid"; then
            cleanup_control_runtime "$pid_file"
            return 0
        fi
        echo "无法向经过验证的 control PID $control_pid 发送终止信号。" >&2
        return 1
    fi
    if ! wait_for_control_exit "$control_pid" 5; then
        if ! kill -KILL "$control_pid" 2>/dev/null && control_process_running "$control_pid"; then
            echo "无法强制终止经过验证的 control PID $control_pid。" >&2
            return 1
        fi
        if ! wait_for_control_exit "$control_pid" 2; then
            echo "经过验证的 control PID $control_pid 无法终止。" >&2
            return 1
        fi
    fi
    cleanup_control_runtime "$pid_file"
}

install_worker() {
    target=$1
    case "$target" in
        windows-*) asset="devshell-worker-$target.exe"; binary_name="devshell-worker.exe" ;;
        *) asset="devshell-worker-$target"; binary_name="devshell-worker" ;;
    esac
    sha=$(read_sha "$temporary/$asset.sha256")
    worker_directory="$devshell_home/workers/$target/$sha"

    mkdir -p -m 700 "$worker_directory"
    install -m 755 "$temporary/$asset" "$worker_directory/$binary_name"
    printf '%s\n' "$sha" > "$worker_directory/$binary_name.sha256"
    chmod 600 "$worker_directory/$binary_name.sha256"
    ln -sfn "../workers/$target/$sha/$binary_name" "$worker_bin_directory/$asset"
}

repository=${PORTABLE_DEVSHELL_RELEASE_REPOSITORY:-Aromatic05/portable-devshell}
explicit_release_base=${PORTABLE_DEVSHELL_RELEASE_BASE_URL:-}
requested_version=${PORTABLE_DEVSHELL_VERSION:-latest}
home=${HOME:?HOME 未设置}
data_home=${XDG_DATA_HOME:-"$home/.local/share"}
install_root=${PORTABLE_DEVSHELL_INSTALL_ROOT:-"$data_home/portable-devshell"}
bin_directory=${PORTABLE_DEVSHELL_BIN_DIR:-"$home/.local/bin"}
devshell_home=${PORTABLE_DEVSHELL_HOME:-"$home/.devshell"}
targets="linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64 windows-arm64"

require_command curl
require_command node
require_command tar
require_command install

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 24 ]; then
    echo "portable-devshell 需要 Node.js 24 或更高版本，当前版本为 $(node --version)。" >&2
    exit 1
fi

case $(uname -s) in
    Linux) host_os=linux ;;
    Darwin) host_os=darwin ;;
    *) echo "当前只支持 Linux 和 macOS。" >&2; exit 1 ;;
esac

case $(uname -m) in
    x86_64|amd64) host_arch=x64 ;;
    arm64|aarch64) host_arch=arm64 ;;
    *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac

host_target="$host_os-$host_arch"
if [ -n "$explicit_release_base" ]; then
    release_base=${explicit_release_base%/}
elif [ "$requested_version" = latest ]; then
    release_base="https://github.com/$repository/releases/latest/download"
else
    case "$requested_version" in
        v*) tag=$requested_version ;;
        *) tag="v$requested_version" ;;
    esac
    release_base="https://github.com/$repository/releases/download/$tag"
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/portable-devshell-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

download "$release_base/portable-devshell-app.tar.gz" "$temporary/app.tar.gz"
download "$release_base/portable-devshell-app.tar.gz.sha256" "$temporary/app.sha256"
verify_sha256 "$temporary/app.tar.gz" "$temporary/app.sha256"

for target in $targets; do
    case "$target" in
        windows-*) asset="devshell-worker-$target.exe" ;;
        *) asset="devshell-worker-$target" ;;
    esac
    download "$release_base/$asset" "$temporary/$asset"
    download "$release_base/$asset.sha256" "$temporary/$asset.sha256"
    verify_sha256 "$temporary/$asset" "$temporary/$asset.sha256"
done

mkdir -p "$temporary/app"
tar -xzf "$temporary/app.tar.gz" -C "$temporary/app"
manifest="$temporary/app/portable-devshell-install.json"
if [ ! -f "$manifest" ]; then
    echo "发布包缺少 portable-devshell-install.json。" >&2
    exit 1
fi

version=$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof value.version!=="string"||!value.version) process.exit(1); process.stdout.write(value.version)' "$manifest")
versions_directory="$install_root/versions"
version_directory="$versions_directory/$version"
staging_directory="$install_root/.staging-$version-$$"
backup_directory="$install_root/.backup-$version-$$"
current_link="$install_root/current"
command_link="$bin_directory/devshell"
worker_bin_directory="$devshell_home/bin"

rm -rf "$staging_directory" "$backup_directory"
mkdir -p -m 700 "$install_root" "$versions_directory" "$worker_bin_directory" "$staging_directory"
cp -R "$temporary/app/." "$staging_directory/"
chmod 755 "$staging_directory/dist/cli/CliMain.js"

if ! stop_installed_control "$current_link/dist/cli/CliMain.js"; then
    echo "无法安全停止当前 control daemon，安装已取消。" >&2
    exit 1
fi

for target in $targets; do
    install_worker "$target"
done
ln -sfn "devshell-worker-$host_target" "$worker_bin_directory/devshell-worker"

if [ -e "$version_directory" ] || [ -L "$version_directory" ]; then
    mv "$version_directory" "$backup_directory"
fi

if mv "$staging_directory" "$version_directory"; then
    ln -sfn "versions/$version" "$current_link"
    mkdir -p "$bin_directory"
    ln -sfn "$current_link/dist/cli/CliMain.js" "$command_link"
    rm -rf "$backup_directory"
else
    rm -rf "$version_directory"
    if [ -e "$backup_directory" ]; then
        mv "$backup_directory" "$version_directory"
    fi
    exit 1
fi

echo "已安装 portable-devshell $version。"
echo "命令：$command_link"
echo "Worker：$targets"
case :${PATH:-}: in
    *:"$bin_directory":*) ;;
    *) echo "提示：$bin_directory 不在 PATH 中，请将它加入 shell 配置。" ;;
esac
