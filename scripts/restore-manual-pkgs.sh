#!/usr/bin/env bash
# 重建 npm 装不上、只能手动解压的三个包（typescript / @types/better-sqlite3 / @types/node）。
# 背景：npmmirror 上 @rolldown/binding-* 的 packument 畸形，触发 npm 11.12.1 的
# semver bug（placeDep 时空 version 传给 compare()，抛 Invalid Version），
# 完整 npm install 失败；且 npm install <pkg> 会用 ideal tree 清掉手动解压的包。
# 所以每次 npm install 之后都要重跑本脚本。
set -e
cd "$(dirname "$0")"
NM="node_modules"
MIRROR="https://registry.npmmirror.com"

declare -A PKGS=(
  ["$NM/typescript"]="typescript/-/typescript-5.9.3.tgz"
  ["$NM/@types/better-sqlite3"]="@types/better-sqlite3/-/better-sqlite3-9.6.0.tgz"
  ["$NM/@types/node"]="@types/node/-/node-22.18.6.tgz"
)

for dest in "${!PKGS[@]}"; do
  mkdir -p "$dest"
  if [ ! -f "$dest/tsc.js" ] && [ ! -f "$dest/package.json" ]; then
    curl -sL --max-time 60 "$MIRROR/${PKGS[$dest]}" -o /tmp/vs-pkg.tgz
    tar -xzf /tmp/vs-pkg.tgz -C "$dest" --strip-components=1
    echo "解压完成: $dest"
  fi
done
[ -f "$NM/typescript/tsc.js" ] && node "$NM/typescript/tsc.js" --version
echo "手动包就绪"
