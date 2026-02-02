# 📝 Шпаргалка - Команды и настройки

## 🚀 Быстрый деплой

### 1. GitHub Commands
```bash
# Создать репозиторий
git init
git add .
git commit -m "Initial commit - ESP32 Tunnel"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

### 2. Render.com Settings
```
Name: esp32-tunnel
Environment: Node
Build Command: npm install
Start Command: npm start
Plan: Free
```

### 3. UptimeRobot Settings
```
Monitor Type: HTTP(s)
Friendly Name: ESP32 Tunnel Keep-Alive
URL: https://YOUR-APP.onrender.com/health
Interval: 5 minutes
```

---

## 🔧 ESP32 Библиотеки

### Arduino IDE - Library Manager
```
1. PubSubClient by Nick O'Leary
2. ArduinoJson by Benoit Blanchon
3. arduinoWebSockets by Markus Sattler
```

### PlatformIO - platformio.ini
```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
lib_deps = 
    knolleary/PubSubClient@^2.8
    bblanchon/ArduinoJson@^6.21.3
    links2004/WebSockets@^2.4.1
```

---

## 📡 MQTT Форматы команд

### Render.com (production)
```
your-app.onrender.com,443,192.168.1.100,80
```

### Локальное тестирование
```
localhost,8080,192.168.1.100,80
```

### С доменным именем
```
tunnel.example.com,443,192.168.1.254,80
```

### Разные порты целевого устройства
```
your-app.onrender.com,443,192.168.1.200,8080  # IP камера
your-app.onrender.com,443,192.168.1.1,80      # Роутер
your-app.onrender.com,443,192.168.1.150,3000  # Node.js app
```

---

## 🌐 URLs для доступа

### Health Check
```
https://YOUR-APP.onrender.com/health
```

### Веб-интерфейс с туннелем
```
https://YOUR-APP.onrender.com/?tunnel=TUNNEL_ID
```

### WebSocket endpoint
```
wss://YOUR-APP.onrender.com/
```

---

## 🔍 Тестирование

### Проверка health endpoint
```bash
curl https://your-app.onrender.com/health
# Ответ: OK
```

### Тест WebSocket соединения
```bash
# Установка wscat
npm install -g wscat

# Подключение
wscat -c wss://your-app.onrender.com

# После подключения отправить:
{"type":"register_browser","tunnelId":"test123"}
```

### Проверка DNS
```bash
nslookup your-app.onrender.com
ping your-app.onrender.com
```

---

## 🐛 Отладка ESP32

### Serial Monitor команды
```
Скорость: 115200 baud
Новая строка: Both NL & CR
```

### Что искать в логах
```
✅ "WiFi connected" - подключение к WiFi
✅ "MQTT connected" - подключение к MQTT
✅ "MQTT message received" - получена команда
✅ "WebSocket connected" - подключение к серверу
✅ "ESP32 successfully registered" - регистрация успешна
✅ "Connected to target" - подключение к целевому устройству
```

### Типичные ошибки
```
❌ "Failed to connect to target" 
   → Проверьте IP адрес целевого устройства

❌ "MQTT connect failed, rc=-2"
   → Проверьте MQTT broker адрес

❌ "WebSocket disconnected"
   → Проверьте URL и порт сервера (443 для Render.com)
```

---

## 📊 Render.com Логи

### Просмотр логов
```
Dashboard → Your Service → Logs (tab)
```

### Что искать
```
✅ "Сервер запущен на порту 8080"
✅ "SERVER_READY"
✅ "Новое WebSocket соединение"
✅ "ESP32 зарегистрировался"
```

---

## 🔐 Переменные окружения (опционально)

### В Render.com Dashboard

```
# Для production можно добавить:
NODE_ENV=production
PORT=8080  # Render сам устанавливает, но можно задать явно
```

### В коде сервера (если нужно)
```javascript
const PORT = process.env.PORT || 8080;
const SECRET = process.env.SECRET || 'default-secret';
```

---

## 📦 npm команды

### Локальная разработка
```bash
# Установка зависимостей
npm install

# Запуск сервера
npm start

# Или напрямую
node server_websocket.js
```

### Проверка версий
```bash
node --version  # должно быть >=18.0.0
npm --version
```

---

## 🌍 Публичные MQTT брокеры

### Бесплатные опции
```
broker.emqx.io:1883          # Основной (используется в проекте)
test.mosquitto.org:1883      # Альтернатива
mqtt.eclipseprojects.io:1883 # Еще один вариант
```

### С аутентификацией
```
Для production лучше использовать:
- HiveMQ Cloud (бесплатный tier)
- CloudMQTT (бесплатный tier)
```

---

## 🔧 Конфигурация WiFi ESP32

### В коде esp32_websocket.ino
```cpp
// WiFi
const char* ssid = "YOUR_WIFI_NAME";
const char* password = "YOUR_WIFI_PASSWORD";

// MQTT
const char* mqtt_server = "broker.emqx.io";
const char* mqtt_topic = "YOUR_UNIQUE_TOPIC";  // Придумайте уникальный!
```

### Примеры уникальных топиков
```
user_12345_tunnel
myhouse_esp32_bridge
tunnel_SecretCode123
```

---

## 📱 Python GUI (если адаптируете)

### WebSocket клиент для Python
```python
import websocket
import json

ws = websocket.WebSocketApp(
    "wss://your-app.onrender.com",
    on_message=on_message,
    on_open=on_open
)

def on_open(ws):
    ws.send(json.dumps({
        'type': 'register_browser',
        'tunnelId': 'tunnel123'
    }))
```

### Библиотеки
```bash
pip install websocket-client
pip install paho-mqtt  # для MQTT
```

---

## 🚨 Emergency Commands

### Если нужно срочно перезапустить сервис
```
Render.com Dashboard → Manual Deploy → Deploy latest commit
```

### Если UptimeRobot не работает
```
Можно временно использовать cron-job.org:
URL: https://your-app.onrender.com/health
Interval: */5 * * * * (каждые 5 минут)
```

### Если ESP32 завис
```
Нажмите кнопку RESET на плате
Или отключите/подключите питание
```

---

## 📈 Мониторинг

### UptimeRobot Dashboard
```
https://uptimerobot.com/dashboard
```

### Render.com Metrics
```
Dashboard → Your Service → Metrics
- Request count
- Response time
- CPU/Memory usage
```

---

## 🔗 Полезные ссылки

### Документация
```
Render.com Docs:  https://render.com/docs
WebSocket API:    https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
ESP32 Arduino:    https://docs.espressif.com/projects/arduino-esp32/
```

### Инструменты
```
WebSocket Tester: https://www.websocket.org/echo.html
MQTT Explorer:    http://mqtt-explorer.com/
JSON Validator:   https://jsonlint.com/
```

---

## 💾 Backup стратегия

### Что бэкапить
```
✅ Код сервера (в GitHub автоматически)
✅ Код ESP32 (в GitHub)
✅ Настройки UptimeRobot (скриншот)
✅ URL сервиса Render.com (записать)
```

### Как восстановить
```
1. Создать новый Web Service на Render.com
2. Подключить тот же GitHub репозиторий
3. Обновить URL в MQTT командах
4. Обновить UptimeRobot monitor
```

---

## ✅ Чеклист запуска

```
□ GitHub репозиторий создан
□ Код загружен в GitHub
□ Render.com Web Service создан
□ Деплой успешен (проверить логи)
□ Health check работает (/health → OK)
□ UptimeRobot настроен и активен
□ ESP32 библиотеки установлены
□ WiFi credentials настроены в коде ESP32
□ Код загружен на ESP32
□ ESP32 подключился к WiFi
□ ESP32 подключился к MQTT
□ MQTT команда отправлена с правильным URL
□ ESP32 подключился к WebSocket
□ Браузер открывает интерфейс
□ Туннель работает!
```

---

## 🎉 Готово!

Сохраните эту шпаргалку - она содержит все необходимые команды и настройки!
