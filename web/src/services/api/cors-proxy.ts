/**
 * CORS 代理工具：将跨域请求转发到本地开发服务器的 /api/cors-proxy 端点。
 * 仅在开发环境（import.meta.env.DEV）下生效，生产环境直接请求原始 URL。
 *
 * 代理端点在 vite.config.ts 的 corsProxy() 插件中实现。
 */

/** 判断是否需要走代理：非本机地址且开发环境 */
export function shouldProxy(url: string): boolean {
    if (!import.meta.env.DEV) return false;
    try {
        const u = new URL(url);
        return u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
    } catch {
        return false;
    }
}

/** 将原始 URL 包装为代理 URL */
export function proxyUrl(originalUrl: string): string {
    return `/api/cors-proxy?url=${encodeURIComponent(originalUrl)}`;
}

/** 将 axios 请求配置中的 url 和 headers 改为走代理 */
export function proxyRequestConfig(
    url: string,
    headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
    if (!shouldProxy(url)) return { url, headers };
    // 走代理时，headers 发给代理端点，代理中间件会转发给目标
    return { url: proxyUrl(url), headers };
}
