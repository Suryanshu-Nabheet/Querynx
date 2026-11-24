/**
 * API server entrypoint.
 */

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, providers: config.enabledProviders },
    "querynx api listening",
  );
} catch (err) {
  app.log.error(err, "failed to start");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
  });
}
