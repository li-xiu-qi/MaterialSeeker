import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试会初始化 better-sqlite3、sharp、segmentit 等原生模块，默认多进程
    // 在开发机上容易被其他本地服务挤占 CPU，表现为偶发超时而不是断言失败。
    // 提交前检查要稳定可复现，这里固定串行执行。
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
  },
})
