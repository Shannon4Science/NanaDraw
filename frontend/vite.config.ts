import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { createReadStream, existsSync, statSync } from "fs";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".xml": "application/xml", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain", ".map": "application/json",
};

function serveDrawio(): Plugin {
  const drawioRoot = path.resolve(__dirname, "../drawio/src/main/webapp");
  return {
    name: "serve-drawio",
    configureServer(server) {
      if (!existsSync(drawioRoot)) return;
      server.middlewares.use("/drawio", (req, res, next) => {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        let file = path.join(drawioRoot, urlPath);
        try {
          const st = statSync(file);
          if (st.isDirectory()) file = path.join(file, "index.html");
        } catch { return next(); }
        if (!existsSync(file)) return next();
        const ext = path.extname(file).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), serveDrawio()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3001,
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
      "/static": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
});
