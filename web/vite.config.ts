import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
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
]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

function readRequestBody(req: IncomingMessage) {
    return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

/**
 * 原样转发请求并流式回传响应：SSE、multipart 上行、blob 下载都不缓冲。
 * GET/HEAD 跟随重定向（媒体下载、预签名地址），其它方法把 3xx 原样交给浏览器。
 */
async function forwardRequest(req: IncomingMessage, res: ServerResponse, target: URL) {
    const method = req.method || "GET";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP_REQUEST_HEADERS.has(key)) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    const init: RequestInit = { method, headers, redirect: method === "GET" || method === "HEAD" ? "follow" : "manual" };
    if (method !== "GET" && method !== "HEAD") init.body = (await readRequestBody(req)) as unknown as BodyInit;

    try {
        const upstream = await fetch(target, init);

        res.statusCode = upstream.status;
        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || lower === "location") return;
            res.setHeader(key, value);
        });
        const location = upstream.headers.get("location");
        if (location && upstream.status >= 300 && upstream.status < 400) res.setHeader("location", new URL(location, target).toString());

        if (!upstream.body) {
            res.end();
            return;
        }

        const reader = upstream.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => undefined));
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
        }
        res.end();
    } catch (error) {
        // 把真实网络错误打到终端，否则前端只能看到 "fetch failed"，无法区分 DNS / 超时 / 证书问题
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        const reason = cause?.code || cause?.message || "";
        console.error(`[ai-proxy] ${method} ${target.href} 失败: ${String(error)}${reason ? ` -> ${reason}` : ""}`);
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendJson(res, 502, {
            error: "代理请求失败",
            detail: reason || String(error),
            target: target.href,
            hint: "确认本机能访问该域名。Node 的 fetch 默认不读 HTTP_PROXY/HTTPS_PROXY，需要走本地代理客户端时用 NODE_USE_ENV_PROXY=1 重启 dev server（PowerShell 先执行 $env:NODE_USE_ENV_PROXY=\"1\"）。",
        });
    }
}

// 服务端代理的本地实现：/api/proxy?url=<encoded_url>，与 Vercel 的 api/proxy.js 对齐，dev 与 preview 都可用
function serverProxy(): Plugin {
    const attach = (middlewares: Connect.Server) => {
        middlewares.use("/api/proxy", (req, res, next) => {
            if (req.method === "OPTIONS") {
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK");
                res.setHeader("Access-Control-Allow-Headers", "*");
                res.statusCode = 204;
                res.end();
                return;
            }
            next();
        });

        middlewares.use("/api/proxy", (req, res) => {
            const url = new URL(req.url || "/", `http://${req.headers.host}`);
            const raw = url.searchParams.get("url");
            if (!raw) {
                sendJson(res, 200, { app: "infinite-canvas", proxy: "vite-dev-proxy", version: localVersion });
                return;
            }
            let target: URL;
            try {
                target = new URL(raw);
            } catch {
                sendJson(res, 400, { error: "url 参数不是合法地址" });
                return;
            }
            if (target.protocol !== "http:" && target.protocol !== "https:") {
                sendJson(res, 400, { error: "url 只支持 http(s)" });
                return;
            }
            void forwardRequest(req, res, target);
        });
    };

    return {
        name: "server-proxy",
        configureServer(server) {
            attach(server.middlewares);
        },
        configurePreviewServer(server) {
            attach(server.middlewares);
        },
    };
}

// 本地同源代理：前端把跨域 URL 改写为 /ai-proxy/?target=<encoded_url>，dev 与 preview 都能转发
function aiApiProxy(): Plugin {
    const attach = (middlewares: Connect.Server) => {
        middlewares.use("/ai-proxy/", (req, res) => {
            const url = new URL(req.url || "/", `http://${req.headers.host}`);
            const raw = url.searchParams.get("target");
            if (!raw) {
                sendJson(res, 400, { error: "缺少 target 参数" });
                return;
            }
            let target: URL;
            try {
                target = new URL(raw);
            } catch {
                sendJson(res, 400, { error: "target 不是合法地址" });
                return;
            }
            if (target.protocol !== "http:" && target.protocol !== "https:") {
                sendJson(res, 400, { error: "target 只支持 http(s)" });
                return;
            }
            void forwardRequest(req, res, target);
        });
    };
    return {
        name: "ai-api-proxy",
        configureServer(server) {
            attach(server.middlewares);
        },
        configurePreviewServer(server) {
            attach(server.middlewares);
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), serverProxy(), aiApiProxy()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
