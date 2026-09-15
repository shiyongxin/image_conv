/**
 * PM2 ecosystem file — image-conv
 *
 * Start:        pm2 start ecosystem.config.cjs
 * Stop:         pm2 stop image-conv
 * Restart:      pm2 restart image-conv
 * Logs:         pm2 logs image-conv
 * Status:       pm2 status
 */
module.exports = {
  apps: [
    {
      name: "image-conv",
      script: "./dist/server.js",
      cwd: __dirname,

      // --- Environment ---
      env: {
        NODE_ENV: "production",
        PORT: "3028",
        // Bind loopback only so the API is NOT reachable from the network.
        // n8n or other local consumers connect via http://127.0.0.1:3028.
        HOST: "127.0.0.1",
        MAX_FILE_SIZE: "20971520",          // 20 MB default
        LOG_LEVEL: "info",
      },

      // --- Process behaviour ---
      instances: 1,        // single instance (process is in-memory, stateless)
      exec_mode: "fork",   // fork mode for a plain Node process
      max_memory_restart: "512M",
      autorestart: true,   // restart on crash

      // --- Logs ---
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true,          // timestamp each log line

      // --- Graceful shutdown (SIGTERM -> Fastify close) ---
      kill_timeout: 10000,
    },
  ],
};
