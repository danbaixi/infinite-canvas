/**
 * Vercel Serverless Function: CORS 代理
 * 接收 ?url=<encoded_url>，转发请求并返回响应，绕过浏览器 CORS 限制。
 */

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    // OPTIONS 预检
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.status(204).end();
        return;
    }

    const targetUrl = req.query.url;
    if (!targetUrl) {
        res.status(400).json({ error: "缺少 url 参数" });
        return;
    }

    try {
        const headers = {};
        const forwardHeaders = ["authorization", "content-type", "x-api-key", "x-goog-api-key"];
        for (const key of forwardHeaders) {
            if (req.headers[key]) headers[key] = req.headers[key];
        }

        // 读取原始 body（bodyParser 关闭后需要手动读）
        let rawBody;
        if (req.method !== "GET" && req.method !== "HEAD") {
            rawBody = await new Promise((resolve) => {
                const chunks = [];
                req.on("data", (chunk) => chunks.push(chunk));
                req.on("end", () => resolve(Buffer.concat(chunks)));
            });
        }

        const upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body: rawBody,
        });

        upstream.headers.forEach((value, key) => {
            if (!["content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });
        res.setHeader("Access-Control-Allow-Origin", "*");

        const responseBody = await upstream.arrayBuffer();
        res.status(upstream.status).send(Buffer.from(responseBody));
    } catch (err) {
        res.status(502).json({ error: "代理请求失败", detail: String(err) });
    }
}
