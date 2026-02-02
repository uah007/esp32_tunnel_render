const http = require('http');
const PORT = process.env.PORT || 8080;

// Хранилище туннелей
const tunnels = new Map();

// Timeout для long polling
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

  // 🔧 НОВОЕ: Список активных туннелей
  if (req.url === '/tunnels') {
    const tunnelList = Array.from(tunnels.keys()).map(id => {
      const tunnel = tunnels.get(id);
      return {
        id: id,
        target: tunnel.targetInfo,
        esp32Connected: !!tunnel.esp32Res || tunnel.esp32Queue.length > 0,
        browserConnected: !!tunnel.browserRes || tunnel.browserQueue.length > 0
      };
    });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tunnels: tunnelList }, null, 2));
    return;
  }

  // 🔧 НОВОЕ: Главная страница - список туннелей
  if (req.url === '/') {
    serveMainPage(res);
    return;
  }

  // Страница туннеля
  if (req.url.startsWith('/?tunnel=')) {
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

// === Главная страница со списком туннелей ===
function serveMainPage(res) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>ESP32 Tunnel Server</title>
  <style>
    body { 
      font-family: Arial; 
      margin: 0; 
      padding: 20px; 
      background: #1a1a1a; 
      color: #fff; 
    }
    h1 { color: #4CAF50; }
    .tunnels { 
      background: #2a2a2a; 
      padding: 20px; 
      border-radius: 8px; 
      margin-top: 20px;
    }
    .tunnel {
      background: #3a3a3a;
      padding: 15px;
      margin: 10px 0;
      border-radius: 5px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tunnel-info {
      flex: 1;
    }
    .tunnel-id {
      font-size: 18px;
      font-weight: bold;
      color: #4CAF50;
      margin-bottom: 5px;
    }
    .tunnel-target {
      color: #999;
      font-size: 14px;
    }
    .tunnel-status {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .status-badge {
      padding: 5px 10px;
      border-radius: 3px;
      font-size: 12px;
    }
    .status-connected {
      background: #4CAF50;
      color: white;
    }
    .status-disconnected {
      background: #666;
      color: white;
    }
    .open-btn {
      background: #4CAF50;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
    }
    .open-btn:hover {
      background: #45a049;
    }
    .no-tunnels {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    .refresh-btn {
      background: #2196F3;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>🌐 ESP32 Tunnel Server</h1>
  <div class="tunnels">
    <h2>Active Tunnels</h2>
    <button class="refresh-btn" onclick="loadTunnels()">🔄 Refresh</button>
    <div id="tunnelList"></div>
  </div>
  
  <script>
    async function loadTunnels() {
      try {
        const resp = await fetch('/tunnels');
        const data = await resp.json();
        
        const listEl = document.getElementById('tunnelList');
        
        if (data.tunnels.length === 0) {
          listEl.innerHTML = '<div class="no-tunnels">No active tunnels. Send MQTT command to ESP32 to create one.</div>';
          return;
        }
        
        listEl.innerHTML = data.tunnels.map(t => \`
          <div class="tunnel">
            <div class="tunnel-info">
              <div class="tunnel-id">\${t.id}</div>
              <div class="tunnel-target">Target: \${t.target.ip}:\${t.target.port}</div>
            </div>
            <div class="tunnel-status">
              <span class="status-badge \${t.esp32Connected ? 'status-connected' : 'status-disconnected'}">
                ESP32: \${t.esp32Connected ? '✓' : '✗'}
              </span>
              <span class="status-badge \${t.browserConnected ? 'status-connected' : 'status-disconnected'}">
                Browser: \${t.browserConnected ? '✓' : '✗'}
              </span>
              <button class="open-btn" onclick="window.open('/?tunnel=\${t.id}', '_blank')">
                Open Tunnel
              </button>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        console.error('Failed to load tunnels:', err);
      }
    }
    
    // Загружаем туннели при загрузке страницы
    loadTunnels();
    
    // Автообновление каждые 3 секунды
    setInterval(loadTunnels, 3000);
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

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

      console.log(`[ESP32] ✅ Registered tunnel: ${tunnelId}, target: ${targetInfo.ip}:${targetInfo.port}`);
      
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

  if (tunnel.esp32Queue.length > 0) {
    const data = tunnel.esp32Queue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: data }));
    return;
  }

  tunnel.esp32Res = res;

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

      if (tunnel.browserRes) {
        tunnel.browserRes.writeHead(200, { 'Content-Type': 'application/json' });
        tunnel.browserRes.end(JSON.stringify({ data: data.data }));
        tunnel.browserRes = null;
      } else {
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

  if (tunnel.browserQueue.length > 0) {
    const data = tunnel.browserQueue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: data }));
    return;
  }

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

      if (tunnel.esp32Res) {
        tunnel.esp32Res.writeHead(200, { 'Content-Type': 'application/json' });
        tunnel.esp32Res.end(JSON.stringify({ data: data.data }));
        tunnel.esp32Res = null;
      } else {
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tunnelId = url.searchParams.get('tunnel');

  // 🔧 ПРОВЕРКА: существует ли туннель?
  if (!tunnels.has(tunnelId)) {
    const errorHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Tunnel Not Found</title>
  <style>
    body { 
      font-family: Arial; 
      margin: 0; 
      padding: 20px; 
      background: #1a1a1a; 
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .error {
      background: #2a2a2a;
      padding: 40px;
      border-radius: 8px;
      text-align: center;
      max-width: 500px;
    }
    h1 { color: #f44336; }
    .info { color: #999; margin: 20px 0; }
    .tunnel-id { 
      background: #3a3a3a; 
      padding: 10px; 
      border-radius: 5px; 
      font-family: monospace;
      margin: 10px 0;
    }
    a {
      color: #4CAF50;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="error">
    <h1>❌ Tunnel Not Found</h1>
    <div class="info">
      The tunnel ID you're looking for doesn't exist:
      <div class="tunnel-id">${tunnelId}</div>
    </div>
    <p>Make sure ESP32 is connected and registered.</p>
    <p><a href="/">← Back to tunnel list</a></p>
  </div>
</body>
</html>`;
    
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(errorHtml);
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>ESP32 Tunnel - ${tunnelId}</title>
  <style>
    body { font-family: Arial; margin: 0; padding: 20px; background: #1a1a1a; color: #fff; }
    .status { padding: 15px; background: #2a2a2a; margin-bottom: 20px; border-radius: 5px; }
    .connected { color: #4CAF50; }
    .disconnected { color: #f44336; }
    .waiting { color: #FFC107; }
    iframe { width: 100%; height: 70vh; border: 1px solid #3a3a3a; background: white; }
    .info { color: #999; font-size: 12px; }
    .debug { 
      background: #2a2a2a; 
      padding: 15px; 
      margin-top: 10px; 
      border-radius: 5px;
      font-family: monospace;
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
    }
    .debug-line { margin: 3px 0; color: #888; }
    .debug-line.success { color: #4CAF50; }
    .debug-line.error { color: #f44336; }
    .debug-line.warning { color: #FFC107; }
    .controls {
      margin: 10px 0;
    }
    button {
      background: #4CAF50;
      color: white;
      border: none;
      padding: 8px 15px;
      border-radius: 3px;
      cursor: pointer;
      margin-right: 10px;
    }
    button:hover {
      background: #45a049;
    }
  </style>
</head>
<body>
  <div class="status">
    <div>
      Status: <span id="status" class="waiting">Waiting for ESP32...</span>
      <span class="info" style="float: right;">Tunnel: ${tunnelId}</span>
    </div>
    <div class="info" style="margin-top: 5px;">
      Polls: <span id="pollCount">0</span> | 
      Received: <span id="dataCount">0</span> bytes |
      Sent: <span id="sentCount">0</span> requests
    </div>
  </div>
  
  <div class="controls">
    <button onclick="sendInitialRequest()">🔄 Send HTTP Request</button>
    <button onclick="clearDebug()">🗑️ Clear Debug</button>
  </div>
  
  <iframe id="frame"></iframe>
  
  <div class="debug">
    <strong>Debug Log:</strong>
    <div id="debugLog"></div>
  </div>
  
  <script>
    const tunnelId = '${tunnelId}';
    const baseUrl = window.location.origin;
    
    let isPolling = false;
    let pollCount = 0;
    let dataCount = 0;
    let sentCount = 0;
    let requestSent = false;
    let accumulatedData = '';
    let lastDataTime = 0;
    
    function log(msg, type = 'info') {
      const debugLog = document.getElementById('debugLog');
      const line = document.createElement('div');
      line.className = 'debug-line ' + type;
      line.textContent = new Date().toLocaleTimeString() + ' - ' + msg;
      debugLog.appendChild(line);
      debugLog.scrollTop = debugLog.scrollHeight;
      console.log('[' + type.toUpperCase() + ']', msg);
    }
    
    function clearDebug() {
      document.getElementById('debugLog').innerHTML = '';
    }
    
    function renderData() {
      if (accumulatedData.length > 0) {
        const iframe = document.getElementById('frame');
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write(accumulatedData);
        doc.close();
        log('Rendered ' + accumulatedData.length + ' bytes total', 'success');
      }
    }
    
    async function poll() {
      if (isPolling) return;
      isPolling = true;
      
      try {
        pollCount++;
        document.getElementById('pollCount').textContent = pollCount;
        
        const resp = await fetch(baseUrl + '/browser/poll?tunnel=' + tunnelId);
        const json = await resp.json();
        
        if (json.data) {
          const chunkSize = json.data.length;
          dataCount += chunkSize;
          document.getElementById('dataCount').textContent = dataCount;
          document.getElementById('status').className = 'connected';
          document.getElementById('status').textContent = 'Connected ✓';
          
          accumulatedData += json.data;
          lastDataTime = Date.now();
          
          log('Received chunk: ' + chunkSize + ' bytes (total: ' + accumulatedData.length + ')', 'success');
          
          // Рендерим после 500ms без новых данных
          setTimeout(function() {
            if (Date.now() - lastDataTime >= 500) {
              renderData();
            }
          }, 600);
        } else {
          // Нет данных - нормально для long polling
          if (pollCount % 10 === 0) {
            log('Polling... waiting for data', 'info');
          }
        }
      } catch (err) {
        log('Poll error: ' + err.message, 'error');
        document.getElementById('status').className = 'disconnected';
        document.getElementById('status').textContent = 'Error ✗';
      }
      
      isPolling = false;
      setTimeout(poll, 100);
    }
    
    async function sendToESP32(data) {
      try {
        sentCount++;
        document.getElementById('sentCount').textContent = sentCount;
        
        const resp = await fetch(baseUrl + '/browser/send?tunnel=' + tunnelId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: data })
        });
        
        if (resp.ok) {
          log('Sent request to ESP32 (' + data.length + ' bytes)', 'success');
          document.getElementById('status').className = 'waiting';
          document.getElementById('status').textContent = 'Request sent, waiting...';
        } else {
          log('Send failed: HTTP ' + resp.status, 'error');
        }
      } catch (err) {
        log('Send error: ' + err.message, 'error');
      }
    }
    
    function sendInitialRequest() {
      const httpRequest = 'GET / HTTP/1.1' + String.fromCharCode(13, 10) + 
                          'Host: target' + String.fromCharCode(13, 10) + 
                          'Connection: close' + String.fromCharCode(13, 10) + 
                          String.fromCharCode(13, 10);
      log('Sending HTTP request to target device...', 'warning');
      sendToESP32(httpRequest);
      requestSent = true;
    }
    
    log('Starting tunnel interface...', 'info');
    log('Tunnel ID: ${tunnelId}', 'info');
    poll();
    
    // Автоматически отправляем запрос через 2 секунды
    setTimeout(function() {
      if (!requestSent) {
        log('Auto-sending initial HTTP request...', 'warning');
        sendInitialRequest();
      }
    }, 2000);
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
  console.log(`🚀 HTTP Tunnel Server listening on port ${PORT}`);
  console.log(`📡 Open http://localhost:${PORT} to see active tunnels`);
  console.log('SERVER_READY');
});
