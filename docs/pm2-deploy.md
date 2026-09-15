# PM2 Deployment Guide

Run `image-conv` as a background daemon with **PM2** — auto-restart on crash, log rotation, and no terminal dependency.

## 1. Install PM2

```bash
# Global install (recommended)
npm install -g pm2

# Verify
pm2 --version
```

## 2. Prepare the build

```bash
cd /Users/syx/Github/image_conv
npm install
npm run build        # produces dist/server.js
npm test             # optional: verify before starting
```

> PM2 runs the **compiled** output (`dist/server.js`), not the TypeScript source.

## 3. Ecosystem file (recommended)

Use a config file so the process definition is versioned and reproducible.
Create `ecosystem.config.cjs` at the project root:

```javascript
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

      // --- Deployment metadata ---
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
```

Create the log directory first:

```bash
mkdir -p logs
```

## 4. Start and manage

```bash
# Start
pm2 start ecosystem.config.cjs

# Status
pm2 status

# Tail logs (logs satisfy -l flag / --lines)
pm2 logs image-conv --lines 50
pm2 logs image-conv --err            # errors only

# Restart after a new deploy/build
pm2 restart image-conv

# Stop / delete (delete also removes it from pm2's process list)
pm2 stop image-conv
pm2 delete image-conv
```

## 5. Persist across reboots (startup)

```bash
# Generate + save the systemd/launchd startup script
pm2 startup

# Freeze the current process list so it restores after reboot
pm2 save
```

- Run `pm2 startup` **once** — it prints a command to run (e.g. with `sudo`) that registers the boot hook.
- `pm2 save` snapshots the current process list; rerun it whenever you add/remove apps.

## 6. Log rotation (optional but recommended)

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
```

## 7. Verify localhost-only binding

```bash
# Should return {"status":"ok",...}
curl http://127.0.0.1:3028/health

# Listening socket should show 127.0.0.1:3028 — NOT 0.0.0.0:3028
ss -tlnp | grep 3028      # Linux
lsof -iTCP:3028 -sTCP:LISTEN   # macOS
```

If the listener shows `*:3028` or `0.0.0.0:3028`, PM2 didn't pick up `HOST=127.0.0.1` —
double-check the ecosystem file and restart:

```bash
pm2 restart image-conv --update-env
```

## 8. Quick reference

| Command | What it does |
|---------|--------------|
| `pm2 status` | list apps, uptime, memory, restarts |
| `pm2 logs image-conv` | follow output + error logs |
| `pm2 restart image-conv` | restart the app |
| `pm2 stop image-conv` | stop without removing from list |
| `pm2 delete image-conv` | remove from PM2 |
| `pm2 save` | snapshot process list for startup |
| `pm2 startup` | install boot hook |
| `pm2 monit` | live CPU/memory dashboard |
| `pm2 reload all --update-env` | apply env changes to all apps |

## 9. Notes / caveats

- **Single instance only.** The app holds images fully in memory per request and is stateless, so horizontal `instances: N` adds no benefit and could double memory under concurrent load. If you need more throughput, scale with a load balancer in front (or up the memory limit).
- **Memory ceiling.** `max_memory_restart: "512M"` covers typical images. For large inputs (near the 8000×8000 cap) you may need to raise this.
- **Deploying updates** = `git pull` → `npm ci --production` → `npm run build` → `pm2 restart image-conv`.