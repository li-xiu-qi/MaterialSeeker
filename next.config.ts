import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // dev 下 Next 会拦掉「来自未登记源」的 /_next/* 请求（返回 403），被拦的包括
  // HMR 与字体。用 IP（192.168.1.170）访问时源不在白名单里，表现是页面能看、
  // 客户端交互却像没接上。白名单只影响 dev，生产构建不读这个字段。
  allowedDevOrigins: ['192.168.1.170', 'localhost', '127.0.0.1'],
}

export default nextConfig
