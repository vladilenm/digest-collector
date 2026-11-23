const processType = process.env.DIGEST_PROCESS || "sender";
if (processType === "sender") {
  await import("./worker.mjs");
} else if (processType === "control") {
  await import("./control.mjs");
} else {
  console.error("invalid_digest_process");
  process.exitCode = 1;
}
