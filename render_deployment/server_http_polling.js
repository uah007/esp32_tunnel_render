const http = require('http');
const PORT = process.env.PORT || 8080;

// Хранилище туннелей
// tunnelId -> { esp32Res: response, browserRes: response, esp32Queue: [], browserQueue: [] }
const tunnels = new Map();

// Timeout для long polling (30 секунд)
const LONG_POLL_TIMEOUT = 30000;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // Главная страница
  if (req.url === '/' || req.url.startsWith('/?')) {
    serveHTML(req, res);
    return;
  }

  // API для ESP32 регистрации туннеля
  if (req.url.startsWith('/esp32/register')) {
    handleESP32Register(req, res);
    return;
  }

  // API для ESP32 получения данных от браузера
  if (req.url.startsWith('/esp32/poll')) {
    handleESP32Poll(req, res);
    return;
  }

  // API для ESP32 отправки данных браузеру
  if (req.url.startsWith('/esp32/send')) {
    handleESP32Send(req, res);
    return;
  }

  // API для браузера получения данных от ESP32
  if (req.url.startsWith('/browser/poll')) {
    handleBrowserPoll(req, res);
    return;
  }

  // API для браузера отправки данных ESP32
  if (req.url.startsWith('/browser/send')) {
    handleBrowserSend(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// === ESP32 регистрирует туннель ===
function handleESP32Register(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const tunnelId = data.tunnelId;
      const targetInfo = data.targetInfo;

      if (!tunnels.has(tunnelId)) {
        tunnels.set(tunnelId, {
          esp32Res: null,
          browserRes: null,
          esp32Queue: [],
          browserQueue: [],
          targetInfo: targetInfo
        });
      } else {
        tunnels.get(tunnelId).targetInfo = targetInfo;
      }

      console.log(`[ESP32] Registered tunnel: ${tunnelId}, target: ${targetInfo.ip}:${targetInfo.port}`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tunnelId: tunnelId }));
    } catch (err) {
      console.error('[ESP32] Register error:', err);
      res.writeHead(400);
      res.end('Bad Request');
    }
  });
}

// === ESP32 ждет данные от браузера (Long Polling) ===
function handleESP32Poll(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tunnelId = url.searchParams.get('tunnel');

  if (!tunnelId || !tunnels.has(tunnelId)) {
    res.writeHead(404);
    res.end('Tunnel not found');
    return;
  }

  const tunnel = tunnels.get(tunnelId);

  // Если есть данные в очереди - отправляем сразу
  if (tunnel.esp32Queue.length > 0) {
    const data = tunnel.esp32Queue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: data }));
    return;
  }

  // Иначе - ждем (Long Polling)
  tunnel.esp32Res = res;

  // Timeout
  const timeout = setTimeout(() => {
    if (tunnel.esp32Res === res) {
      tunnel.esp32Res = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: null }));
    }
  }, LONG_POLL_TIMEOUT);

  req.on('close', () => {
    clearTimeout(timeout);
    if (tunnel.esp32Res === res) {
      tunnel.esp32Res = null;
    }
  });
}

// === ESP32 отправляет данные браузеру ===
function handleESP32Send(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tunnelId = url.searchParams.get('tunnel');

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);

      if (!tunnelId || !tunnels.has(tunnelId)) {
        res.writeHead(404);
        res.end('Tunnel not found');
        return;
      }

      const tunnel = tunnels.get(tunnelId);

      // Если браузер ждет - отправляем сразу
      if (tunnel.browserRes) {
        tunnel.browserRes.writeHead(200, { 'Content-Type': 'application/json' });
        tunnel.browserRes.end(JSON.stringify({ data: data.data }));
        tunnel.browserRes = null;
      } else {
        // Иначе - в очередь
        tunnel.browserQueue.push(data.data);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error('[ESP32] Send error:', err);
      res.writeHead(400);
      res.end('Bad Request');
    }
  });
}

// === Браузер ждет данные от ESP32 (Long Polling) ===
function handleBrowserPoll(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tunnelId = url.searchParams.get('tunnel');

  if (!tunnelId || !tunnels.has(tunnelId)) {
    res.writeHead(404);
    res.end('Tunnel not found');
    return;
  }

  const tunnel = tunnels.get(tunnelId);

  // Если есть данные в очереди - отправляем сразу
  if (tunnel.browserQueue.length > 0) {
    const data = tunnel.browserQueue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: data }));
    return;
  }

  // Иначе - ждем
  tunnel.browserRes = res;

  const timeout = setTimeout(() => {
    if (tunnel.browserRes === res) {
      tunnel.browserRes = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: null }));
    }
  }, LONG_POLL_TIMEOUT);

  req.on('close', () => {
    clearTimeout(timeout);
    if (tunnel.browserRes === res) {
      tunnel.browserRes = null;
    }
  });
}

// === Браузер отправляет данные ESP32 ===
function handleBrowserSend(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tunnelId = url.searchParams.get('tunnel');

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);

      if (!tunnelId || !tunnels.has(tunnelId)) {
        res.writeHead(404);
        res.end('Tunnel not found');
        return;
      }

      const tunnel = tunnels.get(tunnelId);

      // Если ESP32 ждет - отправляем сразу
      if (tunnel.esp32Res) {
        tunnel.esp32Res.writeHead(200, { 'Content-Type': 'application/json' });
        tunnel.esp32Res.end(JSON.stringify({ data: data.data }));
        tunnel.esp32Res = null;
      } else {
        // Иначе - в очередь
        tunnel.esp32Queue.push(data.data);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error('[Browser] Send error:', err);
      res.writeHead(400);
      res.end('Bad Request');
    }
  });
}

// === HTML страница для браузера ===
function serveHTML(req, res) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>ESP32 Tunnel (HTTP)</title>
  <style>
    body { font-family: Arial; margin: 0; padding: 20px; background: #1a1a1a; color: #fff; }
    .status { padding: 10px; background: #2a2a2a; margin-bottom: 20px; }
    .connected { color: #4CAF50; }
    .disconnected { color: #f44336; }
    iframe { width: 100%; height: 80vh; border: 1px solid #3a3a3a; background: white; }
  </style>
</head>
<body>
  <div class="status">
    Status: <span id="status" class="disconnected">Connecting...</span>
  </div>
  <iframe id="frame"></iframe>
  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const tunnelId = urlParams.get('tunnel') || 'default';
    const baseUrl = window.location.origin;
    
    let isPolling = false;
    
    async function poll() {
      if (isPolling) return;
      isPolling = true;
      
      try {
        const resp = await fetch(\`\${baseUrl}/browser/poll?tunnel=\${tunnelId}\`);
        const json = await resp.json();
        
        if (json.data) {
          document.getElementById('status').className = 'connected';
          document.getElementById('status').textContent = 'Connected';
          
          // Показываем данные в iframe
          const iframe = document.getElementById('frame');
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          doc.open();
          doc.write(json.data);
          doc.close();
        }
      } catch (err) {
        console.error('Poll error:', err);
        document.getElementById('status').className = 'disconnected';
        document.getElementById('status').textContent = 'Error';
      }
      
      isPolling = false;
      setTimeout(poll, 100);
    }
    
    async function sendToESP32(data) {
      try {
        await fetch(\`\${baseUrl}/browser/send?tunnel=\${tunnelId}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: data })
        });
      } catch (err) {
        console.error('Send error:', err);
      }
    }
    
    // Начинаем polling
    poll();
    
    // При первом подключении отправляем HTTP GET запрос
    setTimeout(() => {
      const httpRequest = 'GET / HTTP/1.1\\r\\nHost: target\\r\\nConnection: close\\r\\n\\r\\n';
      sendToESP32(httpRequest);
    }, 1000);
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// Очистка мертвых туннелей каждые 60 секунд
setInterval(() => {
  for (const [tunnelId, tunnel] of tunnels.entries()) {
    if (!tunnel.esp32Res && !tunnel.browserRes && 
        tunnel.esp32Queue.length === 0 && tunnel.browserQueue.length === 0) {
      console.log(`[Cleanup] Removing idle tunnel: ${tunnelId}`);
      tunnels.delete(tunnelId);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`HTTP Tunnel Server listening on port ${PORT}`);
  console.log('SERVER_READY');
});
