const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.css': 'text/css'
};

// tesseract.js workers cannot start from file:// pages, so the app serves
// itself over a loopback-only server on a random port
function createServer() {
  return new Promise(resolve => {
    const root = __dirname;
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(root, path.normalize(p).replace(/^([.][.][\\/])+/, ''));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
        });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

app.whenReady().then(async () => {
  const srv = await createServer();
  const win = new BrowserWindow({
    width: 1150,
    height: 850,
    title: 'シリアルナンバー読み取り',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true }
  });
  // external links (e.g. the X profile) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${srv.address().port}/`);
});

app.on('window-all-closed', () => app.quit());
