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

if [ -x "$current_link/dist/cli/CliMain.js" ]; then
    if ! "$current_link/dist/cli/CliMain.js" stop >/dev/null 2>&1; then
        echo "无法停止当前 control daemon，安装已取消。" >&2
        exit 1
    fi
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
