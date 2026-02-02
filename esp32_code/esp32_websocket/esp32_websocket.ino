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
  delay(1000);
  
  connectWiFi();

  paramsMutex = xSemaphoreCreateMutex();

  mqttClient.setServer(mqtt_server, 1883);
  mqttClient.setCallback(mqttCallback);

  // WebSocket event handler
  webSocket.onEvent(webSocketEvent);
  
  // ВАЖНО: Отключаем проверку SSL сертификата для Render.com
  webSocket.setReconnectInterval(5000);

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
// Формат: "your-app.onrender.com,443,192.168.1.254,80"
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
      Serial.println("[WSc] Disconnected!");
      wsConnected = false;
      break;
      
    case WStype_CONNECTED:
      {
        Serial.printf("[WSc] Connected to url: %s\n", payload);
        wsConnected = true;
        
        // Регистрируемся как ESP32
        StaticJsonDocument<256> doc;
        doc["type"] = "register_esp32";
        doc["tunnelId"] = tunnelId;
        JsonObject targetInfo = doc.createNestedObject("targetInfo");
        targetInfo["ip"] = targetHost;
        targetInfo["port"] = targetPort;
        
        String jsonStr;
        serializeJson(doc, jsonStr);
        webSocket.sendTXT(jsonStr);
        Serial.println("[WSc] Registration sent");
      }
      break;
      
    case WStype_TEXT:
      {
        Serial.printf("[WSc] Received text: %s\n", payload);
        
        // Получили данные от сервера
        StaticJsonDocument<2048> doc;
        DeserializationError error = deserializeJson(doc, payload, length);
        
        if (error) {
          Serial.print("[WSc] JSON parse error: ");
          Serial.println(error.c_str());
          return;
        }
        
        const char* msgType = doc["type"];
        
        if (strcmp(msgType, "registered") == 0) {
          Serial.println("[WSc] ESP32 successfully registered!");
        }
        else if (strcmp(msgType, "data") == 0) {
          // Данные от браузера → отправляем целевому устройству
          const char* data = doc["data"];
          if (targetConnected && targetClient.connected()) {
            targetClient.print(data);
            Serial.printf("[WSc] Sent to target: %d bytes\n", strlen(data));
          } else {
            Serial.println("[WSc] Warning: Target not connected, dropping data");
          }
        }
      }
      break;
      
    case WStype_BIN:
      Serial.printf("[WSc] Received binary length: %u\n", length);
      break;
      
    case WStype_ERROR:
      Serial.printf("[WSc] Error!\n");
      break;
      
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;
  }
}

// === MQTT Task ===
void mqttTask(void* pv) {
  for (;;) {
    if (!mqttClient.connected()) {
      Serial.println("[MQTT] Connecting...");
      String clientId = "ESP32_Tunnel_" + String(random(0xffff), HEX);
      if (mqttClient.connect(clientId.c_str())) {
        Serial.println("[MQTT] Connected!");
        mqttClient.subscribe(mqtt_topic);
        Serial.printf("[MQTT] Subscribed to: %s\n", mqtt_topic);
      } else {
        Serial.print("[MQTT] Failed, rc=");
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
        Serial.println("[Tunnel] Parameters changed, resetting connections");
        
        webSocket.disconnect();
        if (targetClient.connected()) targetClient.stop();
        
        wsConnected = false;
        targetConnected = false;
        paramsChanged = false;
      }
      xSemaphoreGive(paramsMutex);
    }

    // Подключение к WebSocket серверу
    if (paramsReceived && !wsConnected && !webSocket.isConnected()) {
      Serial.printf("[Tunnel] Connecting to WebSocket: %s:%u%s\n", 
                    nodeServerHost.c_str(), nodeServerPort, nodeServerPath.c_str());
      
      // Определяем использовать WSS (secure) или WS
      bool useSSL = (nodeServerPort == 443);
      
      if (useSSL) {
        // WSS (для Render.com) - БЕЗ проверки сертификата
        webSocket.beginSSL(nodeServerHost, nodeServerPort, nodeServerPath, "", "");
        Serial.println("[Tunnel] Using WSS (secure WebSocket)");
      } else {
        // WS (для локального тестирования)
        webSocket.begin(nodeServerHost, nodeServerPort, nodeServerPath);
        Serial.println("[Tunnel] Using WS (plain WebSocket)");
      }
      
      vTaskDelay(pdMS_TO_TICKS(2000)); // Даем время на подключение
    }

    // WebSocket loop
    webSocket.loop();
    
    if (wsConnected) {
      // Подключаемся к целевому устройству если еще не подключены
      if (!targetConnected) {
        Serial.printf("[Tunnel] Connecting to target: %s:%u\n", targetHost.c_str(), targetPort);
        if (targetClient.connect(targetHost.c_str(), targetPort)) {
          Serial.println("[Tunnel] Connected to target!");
          targetConnected = true;
        } else {
          Serial.println("[Tunnel] Failed to connect to target, retry in 3 sec");
          vTaskDelay(pdMS_TO_TICKS(3000));
        }
      }
      
      // Читаем данные от целевого устройства и отправляем через WebSocket
      if (targetConnected && targetClient.connected()) {
        while (targetClient.available()) {
          int bytesRead = targetClient.read(sendBuffer, BUFFER_SIZE);
          if (bytesRead > 0) {
            // Преобразуем в строку для JSON
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
            
            Serial.printf("[Tunnel] Sent to browser: %d bytes\n", bytesRead);
          }
        }
      } else if (targetConnected) {
        // Соединение с целевым потеряно
        Serial.println("[Tunnel] Target connection lost");
        targetClient.stop();
        targetConnected = false;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
