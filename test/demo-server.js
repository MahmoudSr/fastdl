'use strict';
// Serves a test file on a fixed port so you can try fastdl (or IDM) by hand.
// Runs on this laptop only; stops by itself after 20 minutes.
// Run: node test/demo-server.js [MB] [per-connection MB/s]
const http = require('http');
const { startServer } = require('./server');
const MB = Number(process.argv[2]) || 250;
const perConn = Number(process.argv[3]) || 2;
startServer({ size: MB * 1024 * 1024, perConnBps: perConn * 1024 * 1024 }).then(s => {
  // Re-expose it on a fixed port with a friendly file name.
  const port = new URL(s.url).port;
  http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port, path: '/testfile.bin', headers: req.headers }, r => {
      const h = { ...r.headers, 'content-disposition': `attachment; filename="test-${MB}MB.bin"` };
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    req.on('close', () => up.destroy());
    up.on('error', () => res.destroy());
    up.end();
  }).listen(8765, () => console.log(`http://127.0.0.1:8765/test-${MB}MB.bin  (each connection capped at ${perConn} MB/s)`));
  setTimeout(() => process.exit(0), 20 * 60 * 1000);
});
