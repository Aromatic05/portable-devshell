#!/bin/sh
set -eu

step_total=6
step_index=0

step() {
    step_index=$((step_index + 1))
    printf '\n[%s/%s] %s\n' "$step_index" "$step_total" "$1"
}

detail() {
    printf '  %s\n' "$1"
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "缺少必需命令：$1" >&2
        exit 1
    fi
}

download() {
    url=$1
    destination=$2
    label=$3
    detail "下载 $label"
    curl_options="--fail --location --show-error --connect-timeout 15 --retry 3 --retry-delay 1 --retry-connrefused --speed-limit 1024 --speed-time 30"
    if [ -t 2 ]; then
        curl $curl_options --progress-bar "$url" --output "$destination"
    else
        curl $curl_options --silent "$url" --output "$destination"
    fi
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

resolve_cli_relative_path() {
    app_directory=$1
    node - "$app_directory/package.json" <<'NODE'
const fs = require("fs");
const path = require("path");
const manifestPath = process.argv[2];
const root = path.resolve(path.dirname(manifestPath));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entry = manifest?.bin?.devshell;
if (typeof entry !== "string" || entry.trim().length === 0) {
    throw new Error(`Application package does not declare bin.devshell: ${manifestPath}`);
}
if (path.isAbsolute(entry)) {
    throw new Error(`Application bin.devshell must be relative: ${entry}`);
}
const absolute = path.resolve(root, entry);
const relative = path.relative(root, absolute);
if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Application bin.devshell escapes package root: ${entry}`);
}
process.stdout.write(relative.split(path.sep).join("/"));
NODE
}

write_install_metadata() {
    manifest_path=$1
    release_directory=$2
    node - "$manifest_path" "$release_directory" <<'NODE'
const fs = require("fs");
const manifestPath = process.argv[2];
const releaseDirectory = process.argv[3].replace(/\/+$/u, "");
const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
value.workerReleaseDirectoryUrl = releaseDirectory;
fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
NODE
}

smoke_cli() {
    cli=$1
    failure_label=$2
    smoke_home="$temporary/smoke-home"
    smoke_runtime="$temporary/smoke-runtime"
    mkdir -p "$smoke_home" "$smoke_runtime"
    if ! smoke_output=$(HOME="$smoke_home" \
        XDG_DATA_HOME="$smoke_home/.local/share" \
        PORTABLE_DEVSHELL_HOME="$smoke_home/.devshell" \
        XDG_RUNTIME_DIR="$smoke_runtime" \
        node "$cli" status 2>&1); then
        echo "$failure_label：CLI 无法启动。" >&2
        printf '%s\n' "$smoke_output" >&2
        return 1
    fi
    case "$smoke_output" in
        *"control: stopped"*) return 0 ;;
        *)
            echo "$failure_label：CLI status 输出不符合预期。" >&2
            printf '%s\n' "$smoke_output" >&2
            return 1
            ;;
    esac
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

rollback_application() {
    rm -rf "$version_directory"
    if [ -e "$backup_directory" ] || [ -L "$backup_directory" ]; then
        mv "$backup_directory" "$version_directory"
    fi
    if [ -n "${previous_current_target:-}" ]; then
        ln -sfn "$previous_current_target" "$current_link"
    else
        rm -f "$current_link"
    fi
    if [ -n "${previous_command_target:-}" ]; then
        ln -sfn "$previous_command_target" "$command_link"
    else
        rm -f "$command_link"
    fi
}

repository=${PORTABLE_DEVSHELL_RELEASE_REPOSITORY:-Aromatic05/portable-devshell}
explicit_release_base=${PORTABLE_DEVSHELL_RELEASE_BASE_URL:-}
requested_version=${PORTABLE_DEVSHELL_VERSION:-latest}
home=${HOME:?HOME 未设置}
data_home=${XDG_DATA_HOME:-"$home/.local/share"}
install_root=${PORTABLE_DEVSHELL_INSTALL_ROOT:-"$data_home/portable-devshell"}
bin_directory=${PORTABLE_DEVSHELL_BIN_DIR:-"$home/.local/bin"}
devshell_home=${PORTABLE_DEVSHELL_HOME:-"$home/.devshell"}

step "检查安装环境"
require_command curl
require_command node
require_command tar
require_command install
require_command readlink
require_command ps

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
if [ "$host_target" = "linux-x64" ]; then
    targets="linux-x64"
else
    targets="linux-x64 $host_target"
fi
target_count=0
for target in $targets; do
    target_count=$((target_count + 1))
done
detail "Node.js $(node --version)"
detail "宿主平台 $host_target"
detail "预装 Worker：$targets"
detail "其他平台将在首次连接时按需下载"

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

step "下载应用包"
download "$release_base/portable-devshell-app.tar.gz" "$temporary/app.tar.gz" "portable-devshell-app.tar.gz"
download "$release_base/portable-devshell-app.tar.gz.sha256" "$temporary/app.sha256" "应用包校验文件"
verify_sha256 "$temporary/app.tar.gz" "$temporary/app.sha256"
detail "应用包 SHA-256 校验通过"

step "下载预装 Worker（$target_count 个）"
for target in $targets; do
    case "$target" in
        windows-*) asset="devshell-worker-$target.exe" ;;
        *) asset="devshell-worker-$target" ;;
    esac
    download "$release_base/$asset" "$temporary/$asset" "$asset"
    download "$release_base/$asset.sha256" "$temporary/$asset.sha256" "$asset.sha256"
    verify_sha256 "$temporary/$asset" "$temporary/$asset.sha256"
    detail "$target 校验通过"
done

step "验证应用包并准备安装"
mkdir -p "$temporary/app"
tar -xzf "$temporary/app.tar.gz" -C "$temporary/app"
manifest="$temporary/app/portable-devshell-install.json"
if [ ! -f "$manifest" ]; then
    echo "发布包缺少 portable-devshell-install.json。" >&2
    exit 1
fi

version=$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof value.version!=="string"||!value.version) process.exit(1); process.stdout.write(value.version)' "$manifest")
if [ -n "$explicit_release_base" ]; then
    worker_release_directory=$release_base
else
    worker_release_directory="https://github.com/$repository/releases/download/v$version"
fi
write_install_metadata "$manifest" "$worker_release_directory"
versions_directory="$install_root/versions"
version_directory="$versions_directory/$version"
staging_directory="$install_root/.staging-$version-$$"
backup_directory="$install_root/.backup-$version-$$"
current_link="$install_root/current"
command_link="$bin_directory/devshell"
worker_bin_directory="$devshell_home/bin"

rm -rf "$staging_directory" "$backup_directory"
mkdir -p -m 700 "$install_root" "$versions_directory" "$worker_bin_directory" "$staging_directory"
mkdir -p "$bin_directory"
cp -R "$temporary/app/." "$staging_directory/"
cli_relative_path=$(resolve_cli_relative_path "$staging_directory")
staging_cli="$staging_directory/$cli_relative_path"
if [ ! -f "$staging_cli" ]; then
    echo "应用包声明的 CLI 不存在：$staging_cli" >&2
    exit 1
fi
chmod 755 "$staging_cli"
if ! smoke_cli "$staging_cli" "安装前验证失败"; then
    exit 1
fi
detail "CLI 入口和运行时依赖验证通过"

step "停止旧版本并切换安装"
current_cli=
if [ -f "$current_link/package.json" ]; then
    current_cli_relative_path=$(resolve_cli_relative_path "$current_link")
    current_cli="$current_link/$current_cli_relative_path"
fi
if ! stop_installed_control "$current_cli"; then
    echo "无法安全停止当前 control daemon，安装已取消。" >&2
    exit 1
fi

for target in $targets; do
    detail "安装 $target Worker"
    install_worker "$target"
done
ln -sfn "devshell-worker-$host_target" "$worker_bin_directory/devshell-worker"

previous_current_target=
previous_command_target=
if [ -L "$current_link" ]; then
    previous_current_target=$(readlink "$current_link")
fi
if [ -L "$command_link" ]; then
    previous_command_target=$(readlink "$command_link")
fi

if [ -e "$version_directory" ] || [ -L "$version_directory" ]; then
    mv "$version_directory" "$backup_directory"
fi

if ! mv "$staging_directory" "$version_directory"; then
    rm -rf "$version_directory"
    if [ -e "$backup_directory" ]; then
        mv "$backup_directory" "$version_directory"
    fi
    exit 1
fi
if ! ln -sfn "versions/$version" "$current_link" || ! ln -sfn "$current_link/$cli_relative_path" "$command_link"; then
    echo "无法激活新版本，正在恢复原安装。" >&2
    rollback_application
    exit 1
fi

step "验证安装结果"
if ! smoke_cli "$command_link" "安装结果验证失败"; then
    echo "新版本未通过启动验证，正在恢复原安装。" >&2
    rollback_application
    exit 1
fi
rm -rf "$backup_directory"
detail "已安装命令可以正常启动"

printf '\n已安装 portable-devshell %s。\n' "$version"
echo "命令：$command_link"
echo "已预装 Worker：$targets"
echo "其他 Worker：首次连接对应平台时按需下载并校验"
echo "下一步："
echo "  $command_link start"
echo "  $command_link tui"
case :${PATH:-}: in
    *:"$bin_directory":*) ;;
    *)
        echo "PATH 尚未包含 $bin_directory。"
        echo "当前 shell 可执行：export PATH=\"$bin_directory:\$PATH\""
        echo "并将同一行加入 ~/.bashrc、~/.zshrc 或对应 shell 配置。"
        ;;
esac
