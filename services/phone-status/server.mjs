import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isIPv4 } from 'node:net';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const token = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const requireValue = (condition, message = 'Invalid request', status = 400) => { if (!condition) throw Object.assign(new Error(message), { status }); };

export function validateReport(input) {
  requireValue(input && typeof input === 'object');
  requireValue(uuid.test(input.deviceId) && typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 80);
  const permissions = {}, readiness = {};
  for (const key of ['accessibility', 'overlay', 'notifications']) {
    requireValue(typeof input.permissions?.[key] === 'boolean'); permissions[key] = input.permissions[key];
  }
  for (const key of ['unlocked', 'computerConnected', 'usbConnected', 'wifiConnected']) {
    requireValue(typeof input.readiness?.[key] === 'boolean'); readiness[key] = input.readiness[key];
  }
  for (const key of ['developerOptions', 'usbDebugging', 'wirelessDebugging']) {
    requireValue(['enabled', 'disabled', 'unconfirmed'].includes(input.readiness?.[key])); readiness[key] = input.readiness[key];
  }
  requireValue(['running', 'enabled', 'disabled', 'unknown'].includes(input.readiness?.accessibilityService));
  readiness.accessibilityService = input.readiness.accessibilityService;
  if (input.readiness.debugReasons !== undefined) {
    const reasons = input.readiness.debugReasons;
    requireValue(reasons && typeof reasons === 'object' && !Array.isArray(reasons));
    readiness.debugReasons = {};
    for (const key of ['developerOptions', 'usbDebugging', 'wirelessDebugging']) {
      if (reasons[key] === undefined) continue;
      requireValue(['system-value', 'computer-read', 'usb-connection', 'masked-zero', 'missing', 'denied', 'error', 'invalid'].includes(reasons[key]));
      readiness.debugReasons[key] = reasons[key];
    }
  }
  if (input.readiness.appVersion !== undefined) {
    requireValue(typeof input.readiness.appVersion === 'string' && /^[\w.+-]{1,40}$/.test(input.readiness.appVersion));
    readiness.appVersion = input.readiness.appVersion;
  }
  if (input.readiness.network !== undefined) {
    const network = input.readiness.network;
    const local = value => {
      if (typeof value !== 'string' || !isIPv4(value)) return false;
      const [a, b] = value.split('.').map(Number);
      return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
    };
    requireValue(network && Array.isArray(network.wifiIpv4) && network.wifiIpv4.length <= 8 && network.wifiIpv4.every(local));
    requireValue(Array.isArray(network.adbEndpoints) && network.adbEndpoints.length <= 8);
    const adbEndpoints = network.adbEndpoints.map(endpoint => {
      requireValue(endpoint && typeof endpoint.address === 'string');
      const match = /^([0-9.]+):([0-9]{1,5})$/.exec(endpoint.address);
      requireValue(match && network.wifiIpv4.includes(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535);
      requireValue(Number.isInteger(endpoint.ageMs) && endpoint.ageMs >= 0 && endpoint.ageMs <= 60000);
      return { address: endpoint.address, ageMs: endpoint.ageMs };
    });
    readiness.network = { wifiIpv4: [...new Set(network.wifiIpv4)], adbEndpoints };
  }
  // Only diagnostics cross this boundary: no screenshots, commands or session credentials.
  return { deviceId: input.deviceId, name: input.name, permissions, readiness };
}

export function createStatusServer({ root, now = Date.now, trustedProxy = false } = {}) {
  const file = root && path.join(root, 'channels.json');
  if (root) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const channels = new Map(file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const reports = new Map(), limits = new Map();
  const persist = () => {
    if (!file) return;
    fs.writeFileSync(file + '.tmp', JSON.stringify([...channels]), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  };
  const limit = (key, max, period) => {
    let entry = limits.get(key);
    if (!entry || entry.until <= now()) { entry = { count: 0, until: now() + period }; limits.set(key, entry); }
    requireValue(++entry.count <= max, 'Too many requests', 429);
  };
  const clean = () => {
    let dirty = false;
    for (const [id, c] of channels) if (!c.writer && c.expires <= now()) {
      channels.delete(id); reports.delete(id); dirty = true;
    }
    for (const [id, item] of reports) if (now() - item.at > 86400000) reports.delete(id);
    for (const [key, entry] of limits) if (entry.until <= now()) limits.delete(key);
    if (dirty) persist();
  };
  const timer = setInterval(clean, 60000); timer.unref();
  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 4096 }, async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true, protocol: 1 }); return; }
      requireValue(!req.headers.origin && req.method === 'POST', 'Invalid endpoint', 404);
      const address = trustedProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
      limit('all:' + address, 240, 60000);
      let body = '';
      for await (const chunk of req) { body += chunk.toString('utf8'); requireValue(Buffer.byteLength(body) <= 8192, 'Request too large', 413); }
      const input = JSON.parse(body);
      requireValue(input && uuid.test(input.id));
      const credential = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      requireValue(credential, 'Unauthorized', 401);
      const digest = hash(credential), channel = channels.get(input.id);
      if (req.url === '/v1/create') {
        requireValue(token.test(input.pairToken));
        if (channel) { requireValue(same(channel.reader, digest), 'Unauthorized', 401); send(200, { expires: channel.expires }); return; }
        limit('create:' + address, 12, 3600000); clean();
        requireValue(channels.size < 256, 'Service capacity reached', 503);
        const expires = now() + 180000;
        channels.set(input.id, { reader: digest, pair: hash(input.pairToken), expires, createdAt: now() }); persist();
        send(200, { expires }); return;
      }
      requireValue(channel, 'Channel unavailable', 404);
      if (req.url === '/v1/claim') {
        requireValue(token.test(input.writeToken) && uuid.test(input.deviceId));
        const writer = hash(input.writeToken);
        requireValue(same(channel.pair, digest) && (channel.writer ? same(channel.writer, writer) && channel.deviceId === input.deviceId : channel.expires > now()), 'Pairing expired or already used', 403);
        channel.writer = writer; channel.deviceId = input.deviceId; persist(); send(200, { ok: true }); return;
      }
      if (req.url === '/v1/report') {
        requireValue(same(channel.writer, digest), 'Unauthorized', 401);
        limit('report:' + input.id, 30, 60000);
        const report = validateReport(input.report); requireValue(report.deviceId === channel.deviceId, 'Device changed', 403);
        reports.set(input.id, { report, at: now() }); send(200, { ok: true }); return;
      }
      requireValue(same(channel.reader, digest), 'Unauthorized', 401);
      if (req.url === '/v1/status') {
        const item = reports.get(input.id);
        send(200, { paired: !!channel.writer, report: item?.report || null, ageMs: item ? Math.max(0, now() - item.at) : null }); return;
      }
      if (req.url === '/v1/revoke') { channels.delete(input.id); reports.delete(input.id); persist(); send(200, { ok: true }); return; }
      throw Object.assign(new Error('Invalid endpoint'), { status: 404 });
    } catch (error) { send(error.status || 400, { error: error.status ? error.message : 'Invalid request' }); }
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createStatusServer({ root: process.env.STATUS_DATA || './data', trustedProxy: process.env.STATUS_TRUST_PROXY === '1' });
  server.listen(Number(process.env.PORT || 8798), '127.0.0.1', () => console.log('Phone status service listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
