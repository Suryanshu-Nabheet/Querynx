/**
 * CLI entrypoint: forwards process.argv to runCli and prints.
 */

import { runCli } from "./index.js";

const output = await runCli(process.argv.slice(2));
if (output.text) {
  console.log(output.text);
}
process.exit(output.exitCode);
