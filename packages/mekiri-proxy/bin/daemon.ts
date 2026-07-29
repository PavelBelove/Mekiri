import { createDaemon } from "../src/daemon.js";

const port = Number(process.argv[2] ?? 8791);
createDaemon({
  port,
  upstream: { protocol: "https", host: "api.anthropic.com", port: 443 },
}).catch((err) => {
  console.error("mekiri-proxy daemon failed to start:", err);
  process.exit(1);
});
