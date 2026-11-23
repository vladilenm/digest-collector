import { readControlConfig } from "../src/control/config.js";
import { connectControlStore } from "../src/control/store.js";
import { createControlServer } from "../src/control/server.js";

try {
  const cfg = readControlConfig(process.env);
  const store = connectControlStore(cfg);
  const server = createControlServer({ cfg, store });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("error", () => {
    console.error("control_listen_failed");
    process.exitCode = 1;
    void store.close();
  });
  server.listen(cfg.port, cfg.host, () => console.info("control_listening"));
  const stop = () => server.close(() => void store.close());
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  console.error("invalid_control_configuration");
  process.exitCode = 1;
}
