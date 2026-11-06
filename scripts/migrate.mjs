import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const compiled = "dist/core/database/migrate.js";
const source = "src/core/database/migrate.ts";

let command;
let args;
if (existsSync(compiled)) {
  command = process.execPath;
  args = [compiled, ...process.argv.slice(2)];
} else if (existsSync("node_modules/tsx/dist/cli.mjs")) {
  command = process.execPath;
  args = ["node_modules/tsx/dist/cli.mjs", source, ...process.argv.slice(2)];
} else {
  console.error("migrate: compiled output missing and tsx is not installed");
  process.exit(1);
}

const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
