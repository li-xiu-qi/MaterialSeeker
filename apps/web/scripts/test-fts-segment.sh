#!/usr/bin/env bash
# 跑 FTS5 分词链路的功能测试（node:test，不依赖 vitest）。
#
# 为什么绕开 vitest：本机 node_modules 处在半装状态（npmmirror 的
# @rolldown/binding-* packument 畸形触发 npm 11.12.1 的 semver bug，完整
# npm install 装不上），而这个链路必须当场可验证。vitest 修好后可以把
# segment.node-test.cts 改写成 vitest 用例，断言不变，本脚本即可退役。
#
# 做法：tsc 把 .cts 连同依赖编成 CJS 到 .tmp-test（放 commonjs 标记的
# package.json），再 node --test 跑产物。源码与产物分离，产物随时可删。
set -e
cd "$(dirname "$0")/.."

node node_modules/typescript/bin/tsc src/lib/segment.node-test.cts \
  --module commonjs --target es2022 --moduleResolution node \
  --outDir .tmp-test --esModuleInterop --skipLibCheck

echo '{"type":"commonjs"}' > .tmp-test/package.json
node --test .tmp-test/segment.node-test.cjs
