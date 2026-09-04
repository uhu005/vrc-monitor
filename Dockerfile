FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/backups

ENV NODE_ENV=production VRC_MONITOR_HOST=0.0.0.0 VRC_MONITOR_PORT=8799 VRC_MONITOR_DB_PATH=/app/data/vrc-monitor.sqlite3 VRC_MONITOR_BACKUP_DIR=/app/backups

EXPOSE 8799

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.VRC_MONITOR_PORT || '8799') + '/health', { headers: process.env.VRC_MONITOR_AUTH_TOKEN ? { 'Authorization': 'Bearer ' + process.env.VRC_MONITOR_AUTH_TOKEN } : {} }).then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "start-monitor.js"]
