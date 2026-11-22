'use strict';

const express = require('express');
const { validateConfig } = require('./config/validateConfig');

const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function start() {
  let config;
  try {
    config = validateConfig(process.env);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[startup] Configuration validation failed:\n${message}`);
    process.exit(1);
    return;
  }

  const port = config.port;

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[startup] Server listening on port ${port}`);
  });

  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[startup] Failed to bind port ${port}: ${err.message}`);
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start };