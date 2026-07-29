import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// 暴露 /plugins/index.json:列出 public/plugins 下的本地插件文件,
// 供前端自动发现并加入插件列表(默认关闭)。dev 下实时读目录,构建时产出静态清单。
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

// CORS 代理：前端将请求发到 /api/cors-proxy?url=<encoded_url>，由开发服务器转发到目标地址
function corsProxy(): Plugin {
    return {
        name: "cors-proxy",
        configureServer(server) {
            server.middlewares.use("/api/cors-proxy", (req, res, next) => {
                if (req.method === "OPTIONS") {
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                    res.setHeader("Access-Control-Allow-Headers", "*");
                    res.statusCode = 204;
                    res.end();
                    return;
                }
                next();
            });

            server.middlewares.use("/api/cors-proxy", async (req, res) => {
                const url = new URL(req.url!, `http://${req.headers.host}`);
                const targetUrl = url.searchParams.get("url");
                if (!targetUrl) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "缺少 url 参数" }));
                    return;
                }

                try {
                    const headers: Record<string, string> = {};
                    const forwardHeaders = ["authorization", "content-type", "x-api-key", "x-goog-api-key"];
                    for (const key of forwardHeaders) {
                        const value = req.headers[key];
                        if (value) headers[key] = Array.isArray(value) ? value[0] : value;
                    }

                    const fetchOptions: RequestInit = {
                        method: req.method || "GET",
                        headers,
                    };

                    if (req.method !== "GET" && req.method !== "HEAD") {
                        const body = await new Promise<Buffer>((resolve, reject) => {
                            const chunks: Buffer[] = [];
                            req.on("data", (chunk: Buffer) => chunks.push(chunk));
                            req.on("end", () => resolve(Buffer.concat(chunks)));
                            req.on("error", reject);
                        });
                        fetchOptions.body = body;
                    }

                    const upstream = await fetch(targetUrl, fetchOptions);

                    res.statusCode = upstream.status;
                    upstream.headers.forEach((value, key) => {
                        if (!["content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
                            res.setHeader(key, value);
                        }
                    });
                    res.setHeader("Access-Control-Allow-Origin", "*");

                    if (upstream.body) {
                        const reader = upstream.body.getReader();
                        const pump = async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) { res.end(); break; }
                                res.write(value);
                            }
                        };
                        await pump();
                    } else {
                        res.end();
                    }
                } catch (err) {
                    res.statusCode = 502;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "代理请求失败", detail: String(err) }));
                }
            });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), corsProxy()],
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
