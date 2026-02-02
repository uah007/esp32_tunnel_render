#include <WiFi.h>
#include <PubSubClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------------- WiFi ----------------
const char* ssid = "Cisco";
const char* password = "123456798";

// ---------------- MQTT ----------------
const char* mqtt_server = "broker.emqx.io";
const char* mqtt_topic = "096523062";

WiFiClient mqttWiFiClient;
PubSubClient mqttClient(mqttWiFiClient);

// ---------------- WebSocket ----------------
WebSocketsClient webSocket;

// ---------------- TCP client для целевого устройства ----------------
WiFiClient targetClient;

// ---------------- Parameters ----------------
String nodeServerHost = "";  // WebSocket сервер (например, your-app.onrender.com)
uint16_t nodeServerPort = 443;  // 443 для WSS (HTTPS WebSocket)
String nodeServerPath = "/";

String targetHost = "";   // IP целевого устройства
uint16_t targetPort = 80;

String tunnelId = "";

volatile bool paramsReceived = false;
volatile bool paramsChanged = false;

volatile bool wsConnected = false;
volatile bool targetConnected = false;

SemaphoreHandle_t paramsMutex;

// Буфер для исходящих данных
#define BUFFER_SIZE 1024
uint8_t sendBuffer[BUFFER_SIZE];
size_t sendBufferLen = 0;

// Forward declarations
void mqttCallback(char* topic, byte* payload, unsigned int length);
void mqttTask(void* pv);
void tunnelTask(void* pv);
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length);

void connectWiFi() {
  Serial.print("Connecting to WiFi ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");
  Serial.print("Bridge IP: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  connectWiFi();

  paramsMutex = xSemaphoreCreateMutex();

  mqttClient.setServer(mqtt_server, 1883);
  mqttClient.setCallback(mqttCallback);

  // WebSocket event handler
  webSocket.onEvent(webSocketEvent);

  // Создаем задачу для MQTT на ядре 0
  xTaskCreatePinnedToCore(
    mqttTask,
    "MQTT",
    4096,
    NULL,
    1,
    NULL,
    0
  );

  // Создаем задачу для туннеля на ядре 1
  xTaskCreatePinnedToCore(
    tunnelTask,
    "TUNNEL",
    8192,
    NULL,
    2,
    NULL,
    1
  );
}

void loop() {
  // Основной цикл пустой
}

// === MQTT Callback ===
// Формат: "your-app.onrender.com,443,192.168.1.254,80" или "ws://localhost:8080,8080,192.168.1.254,80"
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.print("MQTT message received: ");
  Serial.println(msg);

  // Парсим: host,port,targetIP,targetPort
  int idx[3], found = 0;
  for (int i = 0; i < (int)msg.length() && found < 3; i++) {
    if (msg[i] == ',') idx[found++] = i;
  }
  if (found < 3) {
    Serial.println("MQTT payload format error (expected: wsHost,wsPort,targetIP,targetPort)");
    return;
  }

  String newNodeHost = msg.substring(0, idx[0]);
  newNodeHost.trim();
  uint16_t newNodePort = msg.substring(idx[0] + 1, idx[1]).toInt();
  
  String newTargetHost = msg.substring(idx[1] + 1, idx[2]);
  newTargetHost.trim();
  uint16_t newTargetPort = msg.substring(idx[2] + 1).toInt();

  if (newNodePort == 0 || newTargetPort == 0) {
    Serial.println("Invalid port numbers");
    return;
  }

  if (newNodeHost.length() == 0 || newTargetHost.length() == 0) {
    Serial.println("Invalid host addresses");
    return;
  }

  if (xSemaphoreTake(paramsMutex, portMAX_DELAY) == pdTRUE) {
    bool changed = (newNodeHost != nodeServerHost) ||
                   (newNodePort != nodeServerPort) ||
                   (newTargetHost != targetHost) ||
                   (newTargetPort != targetPort);

    if (changed) {
      nodeServerHost = newNodeHost;
      nodeServerPort = newNodePort;
      targetHost = newTargetHost;
      targetPort = newTargetPort;
      paramsChanged = true;
      paramsReceived = true;
      
      // Генерируем tunnel ID
      tunnelId = String(random(100000, 999999));
      
      Serial.println("Parameters updated from MQTT:");
      Serial.printf("  WebSocket: %s:%u\n", nodeServerHost.c_str(), nodeServerPort);
      Serial.printf("  Target: %s:%u\n", targetHost.c_str(), targetPort);
      Serial.printf("  Tunnel ID: %s\n", tunnelId.c_str());
    }
    xSemaphoreGive(paramsMutex);
  }
}

// === WebSocket Event Handler ===
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected");
      wsConnected = false;
      break;
      
    case WStype_CONNECTED:
      Serial.println("WebSocket connected");
      wsConnected = true;
      
      // Регистрируемся как ESP32
      {
        StaticJsonDocument<256> doc;
        doc["type"] = "register_esp32";
        doc["tunnelId"] = tunnelId;
        JsonObject targetInfo = doc.createNestedObject("targetInfo");
        targetInfo["ip"] = targetHost;
        targetInfo["port"] = targetPort;
        
        String jsonStr;
        serializeJson(doc, jsonStr);
        webSocket.sendTXT(jsonStr);
        Serial.println("Sent ESP32 registration");
      }
      break;
      
    case WStype_TEXT:
      {
        // Получили данные от сервера
        StaticJsonDocument<2048> doc;
        DeserializationError error = deserializeJson(doc, payload, length);
        
        if (error) {
          Serial.print("JSON parse error: ");
          Serial.println(error.c_str());
          return;
        }
        
        const char* msgType = doc["type"];
        
        if (strcmp(msgType, "registered") == 0) {
          Serial.println("ESP32 successfully registered");
        }
        else if (strcmp(msgType, "data") == 0) {
          // Данные от браузера → отправляем целевому устройству
          const char* data = doc["data"];
          if (targetConnected && targetClient.connected()) {
            targetClient.print(data);
            Serial.printf("Sent to target: %d bytes\n", strlen(data));
          }
        }
      }
      break;
      
    case WStype_BIN:
      // Binary data не используем в этой версии
      break;
      
    case WStype_ERROR:
      Serial.println("WebSocket error");
      break;
  }
}

// === MQTT Task ===
void mqttTask(void* pv) {
  for (;;) {
    if (!mqttClient.connected()) {
      Serial.println("Connecting to MQTT...");
      if (mqttClient.connect("ESP32_WST_Client")) {
        Serial.println("MQTT connected");
        mqttClient.subscribe(mqtt_topic);
      } else {
        Serial.print("MQTT connect failed, rc=");
        Serial.print(mqttClient.state());
        Serial.println(" retry in 5 sec");
        vTaskDelay(pdMS_TO_TICKS(5000));
        continue;
      }
    }
    mqttClient.loop();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// === Tunnel Task ===
void tunnelTask(void* pv) {
  for (;;) {
    // Проверяем изменения параметров
    if (xSemaphoreTake(paramsMutex, portMAX_DELAY) == pdTRUE) {
      if (paramsChanged) {
        Serial.println("Parameters changed, resetting connections");
        
        webSocket.disconnect();
        if (targetClient.connected()) targetClient.stop();
        
        wsConnected = false;
        targetConnected = false;
        paramsChanged = false;
      }
      xSemaphoreGive(paramsMutex);
    }

    // Подключение к WebSocket серверу
    if (paramsReceived && !wsConnected) {
      Serial.printf("Connecting to WebSocket: %s:%u%s\n", 
                    nodeServerHost.c_str(), nodeServerPort, nodeServerPath.c_str());
      
      // Определяем использовать WSS (secure) или WS
      bool useSSL = (nodeServerPort == 443);
      
      if (useSSL) {
        // WSS (для Render.com и других HTTPS хостингов)
        webSocket.beginSSL(nodeServerHost, nodeServerPort, nodeServerPath);
      } else {
        // WS (для локального тестирования)
        webSocket.begin(nodeServerHost, nodeServerPort, nodeServerPath);
      }
      
      vTaskDelay(pdMS_TO_TICKS(1000));
    }

    // WebSocket loop
    if (wsConnected) {
      webSocket.loop();
      
      // Подключаемся к целевому устройству если еще не подключены
      if (!targetConnected) {
        Serial.printf("Connecting to target: %s:%u\n", targetHost.c_str(), targetPort);
        if (targetClient.connect(targetHost.c_str(), targetPort)) {
          Serial.println("Connected to target");
          targetConnected = true;
        } else {
          Serial.println("Failed to connect to target, retry in 3 sec");
          vTaskDelay(pdMS_TO_TICKS(3000));
        }
      }
      
      // Читаем данные от целевого устройства и отправляем через WebSocket
      if (targetConnected && targetClient.connected()) {
        while (targetClient.available()) {
          int bytesRead = targetClient.read(sendBuffer, BUFFER_SIZE);
          if (bytesRead > 0) {
            // Кодируем в base64 или отправляем как текст
            // Для простоты отправим как текст (если это HTTP)
            String data = "";
            for (int i = 0; i < bytesRead; i++) {
              data += (char)sendBuffer[i];
            }
            
            StaticJsonDocument<3072> doc;
            doc["type"] = "data";
            doc["data"] = data;
            
            String jsonStr;
            serializeJson(doc, jsonStr);
            webSocket.sendTXT(jsonStr);
            
            Serial.printf("Sent to browser: %d bytes\n", bytesRead);
          }
        }
      } else if (targetConnected) {
        // Соединение с целевым потеряно
        Serial.println("Target connection lost");
        targetClient.stop();
        targetConnected = false;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
