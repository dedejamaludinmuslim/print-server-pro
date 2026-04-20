const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.REGISTRY_PORT || process.env.PORT || '3100', 10);
const TTL_MS = Math.max(30000, parseInt(process.env.REGISTRY_TTL_MS || '120000', 10));
const ADMIN_TOKEN = (process.env.REGISTRY_ADMIN_TOKEN || '').trim();
const STORE_FILE = path.join(__dirname, 'registry-data.json');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

let registry = { servers: [] };
if (fs.existsSync(STORE_FILE)) {
  try {
    registry = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {}
}

function saveStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(registry, null, 2));
}

function pruneStale() {
  const now = Date.now();
  registry.servers = registry.servers.filter(item => now - new Date(item.lastSeenAt).getTime() <= TTL_MS);
}

function serverId(payload) {
  return [payload.token || '', payload.hostname || '', payload.ip || '', payload.port || ''].join('|');
}

app.get('/api/health', (req, res) => {
  pruneStale();
  res.json({ ok: true, activeServers: registry.servers.length, ttlMs: TTL_MS });
});

app.get('/api/servers', (req, res) => {
  pruneStale();
  res.json({ ok: true, servers: registry.servers.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)) });
});

app.post('/api/heartbeat', (req, res) => {
  const payload = req.body || {};
  if (!payload.hostname || !payload.ip || !payload.port) {
    return res.status(400).json({ ok: false, error: 'hostname, ip, port wajib diisi' });
  }
  pruneStale();
  const id = serverId(payload);
  const item = {
    id,
    label: payload.label || payload.hostname,
    hostname: payload.hostname,
    ip: payload.ip,
    ips: Array.isArray(payload.ips) ? payload.ips : [payload.ip],
    port: payload.port,
    pingUrl: payload.pingUrl || `http://${payload.ip}:${payload.port}/ping`,
    printersUrl: payload.printersUrl || `http://${payload.ip}:${payload.port}/printers`,
    lastSeenAt: payload.lastSeenAt || new Date().toISOString(),
    token: payload.token || null,
  };
  const idx = registry.servers.findIndex(s => s.id === id);
  if (idx >= 0) registry.servers[idx] = item;
  else registry.servers.push(item);
  saveStore();
  res.json({ ok: true, saved: item });
});

app.post('/api/admin/clear', (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  registry.servers = [];
  saveStore();
  res.json({ ok: true });
});

setInterval(() => {
  pruneStale();
  saveStore();
}, Math.min(TTL_MS, 60000));

app.listen(PORT, () => {
  console.log(`Registry server ready on ${PORT}`);
});
