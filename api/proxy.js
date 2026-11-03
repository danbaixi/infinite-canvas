/**
 * Vercel Serverless Function：AI 请求转发代理
 *
 * 用法：/api/proxy?url=<encodeURIComponent(目标地址)>
 * 根路径不带 url 时返回代理身份，供设置页「测试连接」使用。
 *
 * 环境变量：
 *   PROXY_ALLOWED_HOSTS  可选。允许转发的目标主机，逗号分隔，支持 *.example.com；不设置时不做任何限制
 *   PROXY_TOKEN          可选。访问口令，未设置时不校验；请求需带 ?token=xxx 或 x-proxy-token 头
 *
 * 注意：不限制目标域名时，任何知道地址的人都能拿它做 CORS 转发。若担心被滥用，
 * 请设置 PROXY_ALLOWED_HOSTS 收紧范围，或加 PROXY_TOKEN 并走 /api/proxy?token=xxx。
 *
 * 纯转发：不改写请求体，不落盘日志，响应边读边写，SSE 流式内容不会被缓冲。
 */

const HOP_BY_HOP_HEADERS = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "accept-encoding",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "x-proxy-token",
]);

/** 未配置 PROXY_ALLOWED_HOSTS 时不做限制，任何目标域名都允许转发。 */
const DEFAULT_ALLOWED_HOSTS = [];

const IDENTITY = { app: "infinite-canvas", proxy: "vercel-proxy", version: "1" };

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

/** 空数组表示不限制目标域名。 */
function allowedHosts() {
    const raw = process.env.PROXY_ALLOWED_HOSTS;
    if (!raw) return DEFAULT_ALLOWED_HOSTS;
    const list = raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    return list.includes("*") ? [] : list;
}

function hostAllowed(hostname) {
    const list = allowedHosts();
    if (!list.length) return true;
    return list.some((pattern) => (pattern.startsWith("*.") ? hostname === pattern.slice(2) || hostname.endsWith(pattern.slice(1)) : hostname === pattern));
}

function sendJson(res, status, payload) {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function readTarget(value) {
    if (!value) return null;
    try {
        const target = new URL(String(value));
        return target.protocol === "http:" || target.protocol === "https:" ? target : null;
    } catch {
        return null;
    }
}

/**
 * Vercel 可能已经解析过 JSON 请求体，这时 req.body 才是原始数据；流未被消费时才直接读流。
 * 二进制和表单请求不会被预解析，走读流分支。
 */
async function readBody(req) {
    if (req.body !== undefined && req.body !== null) {
        if (Buffer.isBuffer(req.body)) return req.body;
        if (typeof req.body === "string") return Buffer.from(req.body);
        return Buffer.from(JSON.stringify(req.body));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) continue;
        if (key.startsWith("x-forwarded-") || key.startsWith("x-vercel-") || key.startsWith("cf-") || key === "x-real-ip") continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream) {
    const headers = { ...CORS_HEADERS };
    upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(lower)) return;
        if (lower.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

module.exports = async function handler(req, res) {
    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const params = requestUrl.searchParams;

    const token = process.env.PROXY_TOKEN;
    if (token && params.get("token") !== token && req.headers["x-proxy-token"] !== token) {
        sendJson(res, 401, { error: "代理口令不正确" });
        return;
    }

    const rawTarget = params.get("url");
    if (!rawTarget) {
        sendJson(res, 200, IDENTITY);
        return;
    }

    const target = readTarget(rawTarget);
    if (!target) {
        sendJson(res, 400, { error: "url 参数不是合法的 http(s) 地址" });
        return;
    }

    if (!hostAllowed(target.hostname)) {
        sendJson(res, 403, { error: `目标域名不在代理白名单：${target.hostname}。请在 Vercel 环境变量 PROXY_ALLOWED_HOSTS 中追加该域名，或设为 * 关闭限制。` });
        return;
    }

    try {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const upstream = await fetch(target, {
            method: req.method,
            headers: requestHeaders(req),
            body,
            redirect: "follow",
        });

        res.writeHead(upstream.status, responseHeaders(upstream));
        if (!upstream.body) {
            res.end();
            return;
        }

        const reader = upstream.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (error) {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendJson(res, 502, { error: "代理请求失败", detail: String(error) });
    }
};

module.exports.config = { maxDuration: 300 };
