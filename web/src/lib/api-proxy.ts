/**
 * 本地开发/预览时把跨域请求改写为同源 /ai-proxy/?target=，由 Vite 的 ai-api-proxy 插件转发。
 * 生产环境（非本机）默认不改写，仍由浏览器直连；可用 VITE_API_PROXY=true|false 强制覆盖。
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export const API_PROXY_PATH = "/ai-proxy/";

export function apiProxyEnabled() {
    // 写成直接成员访问，Vite 才能在构建时把 import.meta.env 替换成真实配置
    const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
    const flag = env.VITE_API_PROXY;
    if (flag === "true") return true;
    if (flag === "false") return false;
    if (typeof window === "undefined") return false;
    return LOCAL_HOSTNAMES.has(window.location.hostname);
}

/** 只改写真正的跨域 http(s) 地址，同源、相对路径和 data/blob URL 原样返回。 */
export function proxyApiUrl(url: string) {
    if (!url || !/^https?:\/\//i.test(url) || !apiProxyEnabled()) return url;
    try {
        if (new URL(url).origin === window.location.origin) return url;
    } catch {
        return url;
    }
    return `${API_PROXY_PATH}?target=${encodeURIComponent(url)}`;
}
