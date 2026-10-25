#!/usr/bin/env bash
# 轻量部署档功能测试：真实 SQLite + 无向量服务，覆盖文本 FTS、图片描述与帧描述。
set -e
cd "$(dirname "$0")/.."

node node_modules/typescript/bin/tsc src/lib/light-mode.node-test.cts \
  --module commonjs --target es2022 --moduleResolution node \
  --outDir .tmp-test --esModuleInterop --skipLibCheck

# 依赖会编成 .js；根 package.json 是 module，必须给产物目录自己的模块类型。
echo '{"type":"commonjs"}' > .tmp-test/package.json
node --test .tmp-test/light-mode.node-test.cjs
