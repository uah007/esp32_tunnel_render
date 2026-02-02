const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// HTTP сервер для health checks и статики
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } 
  else if (req.url === '/' || req.url.startsWith('/?')) {
    // Раздаем HTML страницу
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(200);
      res.end('ESP32 Tunnel Server - WebSocket only');
    }
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket сервер
const wss = new WebSocket.Server({ server: httpServer });

// Хранилище активных туннелей
// tunnelId -> { esp32: WebSocket, browser: WebSocket, targetInfo: {ip, port} }
const tunnels = new Map();

wss.on('connection', (ws, req) => {
  console.log('Новое WebSocket соединение:', req.socket.remoteAddress);
  
  let clientType = null; // 'esp32' или 'browser'
  let tunnelId = null;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // ESP32 регистрация
      if (msg.type === 'register_esp32') {
        clientType = 'esp32';
        tunnelId = msg.tunnelId || generateTunnelId();
        
        console.log(`ESP32 зарегистрировался, tunnel ID: ${tunnelId}`);
        
        if (!tunnels.has(tunnelId)) {
          tunnels.set(tunnelId, {});
        }
        
        const tunnel = tunnels.get(tunnelId);
        tunnel.esp32 = ws;
        tunnel.targetInfo = msg.targetInfo; // {ip, port}
        
        ws.send(JSON.stringify({
          type: 'registered',
          tunnelId: tunnelId
        }));
        
        console.log(`Целевое устройство: ${msg.targetInfo.ip}:${msg.targetInfo.port}`);
        return;
      }
      
      // Браузер регистрация
      if (msg.type === 'register_browser') {
        clientType = 'browser';
        tunnelId = msg.tunnelId;
        
        console.log(`Браузер подключился к tunnel ID: ${tunnelId}`);
        
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel || !tunnel.esp32) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Tunnel not found or ESP32 not connected'
          }));
          ws.close();
          return;
        }
        
        tunnel.browser = ws;
        
        ws.send(JSON.stringify({
          type: 'connected',
          targetInfo: tunnel.targetInfo
        }));
        
        return;
      }
      
      // Relay данных
      if (msg.type === 'data') {
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel) return;
        
        if (clientType === 'browser' && tunnel.esp32) {
          // Браузер → ESP32
          tunnel.esp32.send(JSON.stringify({
            type: 'data',
            data: msg.data
          }));
        } else if (clientType === 'esp32' && tunnel.browser) {
          // ESP32 → Браузер
          tunnel.browser.send(JSON.stringify({
            type: 'data',
            data: msg.data
          }));
        }
      }
      
    } catch (err) {
      console.error('Ошибка парсинга сообщения:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log(`WebSocket закрыт (${clientType}, tunnel: ${tunnelId})`);
    
    if (tunnelId && tunnels.has(tunnelId)) {
      const tunnel = tunnels.get(tunnelId);
      
      // Закрываем оба конца туннеля
      if (tunnel.esp32 && tunnel.esp32 !== ws) {
        tunnel.esp32.close();
      }
      if (tunnel.browser && tunnel.browser !== ws) {
        tunnel.browser.close();
      }
      
      tunnels.delete(tunnelId);
      console.log(`Tunnel ${tunnelId} удален`);
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket ошибка:', err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log("SERVER_READY"); // Сигнал для Python
});

function generateTunnelId() {
  return Math.random().toString(36).substring(2, 15);
}

// Периодическая очистка мертвых туннелей
setInterval(() => {
  for (const [tunnelId, tunnel] of tunnels.entries()) {
    const esp32Dead = !tunnel.esp32 || tunnel.esp32.readyState !== WebSocket.OPEN;
    const browserDead = !tunnel.browser || tunnel.browser.readyState !== WebSocket.OPEN;
    
    if (esp32Dead && browserDead) {
      console.log(`Очистка мертвого туннеля: ${tunnelId}`);
      tunnels.delete(tunnelId);
    }
  }
}, 30000); // каждые 30 секунд
