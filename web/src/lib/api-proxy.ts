/**
 * 把跨域请求改写成同源代理地址，避免浏览器直接访问第三方域名。
 *
 * 本地（Vite dev/preview）走 `/ai-proxy/?target=`，由 vite.config.ts 的中间件转发；
 * 生产部署走同源的 `/api/proxy?url=`，由 Serverless 函数或自建服务转发。
 * 默认开启，可用 VITE_API_PROXY=false 关闭。
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export const API_PROXY_PATH = "/ai-proxy/";
export const SERVER_PROXY_PATH = "/api/proxy";

export function isLocalHost() {
    return typeof window !== "undefined" && LOCAL_HOSTNAMES.has(window.location.hostname);
}

export function apiProxyEnabled() {
    // 写成直接成员访问，Vite 才能在构建时把 import.meta.env 替换成真实配置
    const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
    return env.VITE_API_PROXY !== "false";
}

/** 只改写真正的跨域 http(s) 地址，同源、相对路径和 data/blob URL 原样返回。 */
export function proxyApiUrl(url: string) {
    if (!url || !/^https?:\/\//i.test(url) || !apiProxyEnabled()) return url;
    try {
        if (new URL(url).origin === window.location.origin) return url;
    } catch {
        return url;
    }
    const encoded = encodeURIComponent(url);
    return isLocalHost() ? `${API_PROXY_PATH}?target=${encoded}` : `${SERVER_PROXY_PATH}?url=${encoded}`;
}
