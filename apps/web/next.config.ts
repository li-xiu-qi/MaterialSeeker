import type { NextConfig } from 'next'

const allowedDevOrigins = process.env.MATERIALSEEKER_DEV_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean) ?? ['localhost', '127.0.0.1']

const nextConfig: NextConfig = {
  // dev 下 Next 会拦掉「来自未登记源」的 /_next/* 请求（返回 403），被拦的包括
  // HMR 与字体。局域网访问时用 MATERIALSEEKER_DEV_ORIGINS 登记来源，
  // 白名单只影响 dev，生产构建不读这个字段。
  allowedDevOrigins,
}

export default nextConfig
