'use strict';
// Local test server that behaves like a real download server:
// supports Range requests, caps speed PER CONNECTION, and can randomly drop connections.
const http = require('http');
const crypto = require('crypto');

function startServer({ size = 40 * 1024 * 1024, perConnBps = 2 * 1024 * 1024, dropRate = 0, wrongRange = false } = {}) {
  const data = crypto.randomBytes(size);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');

  const server = http.createServer((req, res) => {
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416); return res.end(); }
      status = 206;
    }
    const headers = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
    // wrongRange: a broken server/proxy that always sends the start of the file.
    if (wrongRange && status === 206 && start > 0) { end -= start; start = 0; headers['Content-Length'] = end + 1; }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);

    // Send in 64KB chunks at a fixed rate for this connection.
    const chunk = 64 * 1024;
    const interval = (chunk / perConnBps) * 1000;
    let pos = start;
    const timer = setInterval(() => {
      if (dropRate && Math.random() < dropRate) { clearInterval(timer); return res.destroy(); }
      const next = Math.min(pos + chunk, end + 1);
      res.write(data.subarray(pos, next));
      pos = next;
      if (pos > end) { clearInterval(timer); res.end(); }
    }, interval);
    res.on('close', () => clearInterval(timer));
  });

  return new Promise(resolve => server.listen(0, () => resolve({
    url: `http://127.0.0.1:${server.address().port}/testfile.bin`, sha256, size, close: () => { server.closeAllConnections(); server.close(); },
  })));
}

module.exports = { startServer };

if (require.main === module) {
  startServer().then(s => console.log(`Serving ${s.url}  sha256=${s.sha256}`));
}
