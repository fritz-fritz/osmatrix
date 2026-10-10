// Minimal HTTP server for testing `osmatrix forward`. Usage: node scripts/server.js [port]
const http = require("node:http");
const port = Number(process.argv[2] || 8080);
http
  .createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, platform: process.platform, url: req.url }) + "\n");
  })
  .listen(port, "127.0.0.1", () => console.log(`listening on 127.0.0.1:${port}`));
