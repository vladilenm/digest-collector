import { setTimeout as sleep } from "node:timers/promises";
import { readUnisenderPublisherConfig } from "../src/config.js";
import { createUnisenderPublisherRuntime } from "../src/runtime.js";

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !["--once", "--dry-run"].includes(arg))) {
  console.error("Usage: worker.mjs [--once] [--dry-run]");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let runtime;
  try {
    const config = readUnisenderPublisherConfig();
    const dryRun = args.has("--dry-run");
    const once = dryRun || args.has("--once");
    runtime = createUnisenderPublisherRuntime(config, { dryRun, onPoolError: (category) => console.error(category) });
    while (!controller.signal.aborted) {
      const result = await runtime.tick({ signal: controller.signal });
      if (once || !["not_due", "already_claimed"].includes(result.status))
        console.info(JSON.stringify(result));
      if (result.status === "invalid_config" ||
        (result.status === "disabled" && config.provider === "unisender" && config.campaignsEnabled) ||
        (once && ["failed", "uncertain"].includes(result.status)))
        process.exitCode = 1;
      if (once || ["disabled", "invalid_config"].includes(result.status) || controller.signal.aborted)
        break;
      await sleep(30_000, undefined, { signal: controller.signal }).catch(() => {});
    }
  } catch {
    console.error("unisender_worker_failed");
    process.exitCode = 1;
  } finally {
    try {
      await runtime?.close();
    } catch {
      console.error("unisender_shutdown_failed");
      process.exitCode = 1;
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
