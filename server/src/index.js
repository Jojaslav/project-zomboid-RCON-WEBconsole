const path = require('node:path');
const { loadConfig, loadEnvFile } = require('./config');
const { createApp } = require('./app');

loadEnvFile(process.env.PZ_ENV_FILE || path.join(__dirname, '..', '.env'));
const config = loadConfig();
const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`PZ Control server listening at http://${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.locals.services.rcon.close();
    server.close(() => process.exit(0));
  });
}
