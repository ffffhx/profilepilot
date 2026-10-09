import http from 'node:http';
import { randomBytes } from 'node:crypto';
const NATIVE_EXTENSION_ID = 'gmdaabnoocjlpimglalnbegfdaklfnaj';

export function open(port, origin = `chrome-extension://${NATIVE_EXTENSION_ID}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/profilepilot', headers: { Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('error', reject); req.on('response', () => reject(new Error('Upgrade denied')));
    req.on('upgrade', (_response, socket, head) => {
      let buffer = head, messages = [], readers = [];
      const closed = new Promise(resolve => socket.once('close', resolve));
      const parse = () => {
        while (buffer.length >= 2) {
          let length = buffer[1] & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0] & 15, payload = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.end(); return; }
          if (opcode !== 1) continue;
          const message = JSON.parse(payload.toString()); const reader = readers.shift(); reader ? reader(message) : messages.push(message);
        }
      };
      socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); parse(); });
      socket.on('error', () => {});
      resolve({ closed, close: () => socket.destroy(), end: () => socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0])), next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => readers.push(resolve)), send: value => {
        const data = Buffer.from(JSON.stringify(value)); const mask = randomBytes(4), header = Buffer.alloc(data.length < 126 ? 2 : 4);
        header[0] = 0x81; header[1] = 0x80 | (data.length < 126 ? data.length : 126); if (data.length >= 126) header.writeUInt16BE(data.length, 2);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; socket.write(Buffer.concat([header, mask, data]));
      } }); parse();
    }); req.end();
  });
}