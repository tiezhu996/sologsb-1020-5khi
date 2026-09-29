#!/usr/bin/env bash
# 编译工作区逻辑与冒烟测试到临时目录，补齐 ESM 扩展名后在 Node 中运行。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .test-build
npx tsc --outDir .test-build --module esnext --target es2022 \
  --moduleResolution bundler --strict --skipLibCheck \
  src/utils/fields.ts src/utils/matching.ts src/utils/workspace.ts src/types.ts \
  scripts/workspace.test.ts
find .test-build -name '*.js' -exec sed -i -E "s|from '(\.[^']*?)'|from '\1.js'|g" {} +
node .test-build/scripts/workspace.test.js
status=$?
rm -rf .test-build
exit $status
