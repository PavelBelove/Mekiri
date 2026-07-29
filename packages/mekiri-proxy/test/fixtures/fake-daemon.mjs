import http from "node:http";

const port = Number(process.argv[2]);
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mekiri-proxy-daemon" }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, "127.0.0.1");
