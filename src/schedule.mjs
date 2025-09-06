import cron from "node-cron";
import { TZ } from "./config.mjs";
import { spawn } from "node:child_process";

console.log("Scheduler started. Will run at 12:00 PM daily.", { TZ });

cron.schedule("0 12 * * *", () => {
  console.log("Noon job triggered.");
  const proc = spawn(process.execPath, ["src/index.mjs"], { stdio: "inherit" });
  proc.on("close", code => console.log("Run finished with code", code));
}, { timezone: TZ });
