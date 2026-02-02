#include <WiFi.h>
#include <PubSubClient.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------- WiFi ----------------
const char* ssid = "Cisco";
const char* password = "123456798";

// ---------------- MQTT ----------------
const char* mqtt_server = "broker.emqx.io";
const char* mqtt_topic = "096523062";

// 🔧 ФИКСИРОВАННЫЙ TUNNEL ID - используйте этот же в браузере!
const char* FIXED_TUNNEL_ID = "esp32-tunnel-001";

WiFiClient mqttWiFiClient;
PubSubClient mqttClient(mqttWiFiClient);

// ---------------- HTTP clients ----------------
HTTPClient httpRegister;
HTTPClient httpPoll;
HTTPClient httpSend;

// ---------------- TCP client для целевого устройства ----------------
WiFiClient targetClient;

// ---------------- Parameters ----------------
String nodeServerUrl = "";
String targetHost = "";
uint16_t targetPort = 80;
String tunnelId = FIXED_TUNNEL_ID;  // 🔧 Используем фиксированный ID

volatile bool paramsReceived = false;
volatile bool paramsChanged = false;
volatile bool registered = false;
volatile bool targetConnected = false;

SemaphoreHandle_t paramsMutex;

// Буфер
#define BUFFER_SIZE 1024
uint8_t sendBuffer[BUFFER_SIZE];

// Таймер для keepalive
unsigned long lastTargetCheck = 0;
const unsigned long TARGET_CHECK_INTERVAL = 5000;

void mqttCallback(char* topic, byte* payload, unsigned int length);
void mqttTask(void* pv);
void tunnelTask(void* pv);

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

  xTaskCreatePinnedToCore(mqttTask, "MQTT", 4096, NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(tunnelTask, "TUNNEL", 10240, NULL, 2, NULL, 1);
}

void loop() {}

// === MQTT Callback ===
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.print("[MQTT] Received: ");
  Serial.println(msg);

  // Парсим: URL,targetIP,targetPort
  int idx[2], found = 0;
  for (int i = 0; i < (int)msg.length() && found < 2; i++) {
    if (msg[i] == ',') idx[found++] = i;
  }
  if (found < 2) {
    Serial.println("[MQTT] ERROR: Expected format: URL,targetIP,targetPort");
    return;
  }

  String newUrl = msg.substring(0, idx[0]);
  newUrl.trim();
  
  String newTargetHost = msg.substring(idx[0] + 1, idx[1]);
  newTargetHost.trim();
  
  uint16_t newTargetPort = msg.substring(idx[1] + 1).toInt();

  if (newUrl.length() == 0 || newTargetHost.length() == 0 || newTargetPort == 0) {
    Serial.println("[MQTT] ERROR: Invalid data");
    return;
  }

  if (xSemaphoreTake(paramsMutex, portMAX_DELAY) == pdTRUE) {
    bool changed = (newUrl != nodeServerUrl) || 
                   (newTargetHost != targetHost) || 
                   (newTargetPort != targetPort);

    if (changed) {
      nodeServerUrl = newUrl;
      targetHost = newTargetHost;
      targetPort = newTargetPort;
      paramsChanged = true;
      paramsReceived = true;
      
      // 🔧 УБРАНО: tunnelId = String(random(100000, 999999));
      // Используем фиксированный FIXED_TUNNEL_ID
      
      Serial.println("===== CONFIG =====");
      Serial.printf("Server: %s\n", nodeServerUrl.c_str());
      Serial.printf("Target: %s:%u\n", targetHost.c_str(), targetPort);
      Serial.printf("Tunnel ID: %s\n", tunnelId.c_str());
      Serial.println("");
      Serial.println("🌐 Open in browser:");
      Serial.printf("   %s/?tunnel=%s\n", nodeServerUrl.c_str(), tunnelId.c_str());
      Serial.println("==================");
    }
    xSemaphoreGive(paramsMutex);
  }
}

// === MQTT Task ===
void mqttTask(void* pv) {
  for (;;) {
    if (!mqttClient.connected()) {
      Serial.println("[MQTT] Connecting...");
      String clientId = "ESP32_HTTP_" + String(random(0xffff), HEX);
      if (mqttClient.connect(clientId.c_str())) {
        Serial.println("[MQTT] ✅ Connected");
        mqttClient.subscribe(mqtt_topic);
      } else {
        Serial.printf("[MQTT] ❌ Failed: %d\n", mqttClient.state());
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
        Serial.println("[Tunnel] 🔄 Reset");
        if (targetClient.connected()) targetClient.stop();
        registered = false;
        targetConnected = false;
        paramsChanged = false;
      }
      xSemaphoreGive(paramsMutex);
    }

    // Регистрация туннеля
    if (paramsReceived && !registered) {
      Serial.println("[Tunnel] 📝 Registering...");
      
      String registerUrl = nodeServerUrl + "/esp32/register";
      
      httpRegister.begin(registerUrl);
      httpRegister.addHeader("Content-Type", "application/json");
      
      StaticJsonDocument<256> doc;
      doc["tunnelId"] = tunnelId;
      JsonObject targetInfo = doc.createNestedObject("targetInfo");
      targetInfo["ip"] = targetHost;
      targetInfo["port"] = targetPort;
      
      String jsonStr;
      serializeJson(doc, jsonStr);
      
      int httpCode = httpRegister.POST(jsonStr);
      
      if (httpCode == 200) {
        Serial.println("[Tunnel] ✅ Registered!");
        Serial.println("");
        Serial.println("🌐 Open in browser:");
        Serial.printf("   %s/?tunnel=%s\n", nodeServerUrl.c_str(), tunnelId.c_str());
        Serial.println("");
        registered = true;
      } else {
        Serial.printf("[Tunnel] ❌ Register failed: %d\n", httpCode);
        httpRegister.end();
        vTaskDelay(pdMS_TO_TICKS(3000));
        continue;
      }
      
      httpRegister.end();
    }

    if (registered) {
      // 1. Проверяем/подключаемся к целевому устройству
      unsigned long now = millis();
      if (!targetConnected || !targetClient.connected()) {
        if (targetClient.connected()) {
          targetClient.stop();
        }
        
        Serial.printf("[Tunnel] 🎯 Connecting to %s:%u\n", targetHost.c_str(), targetPort);
        if (targetClient.connect(targetHost.c_str(), targetPort, 5000)) {
          Serial.println("[Tunnel] ✅ Target connected!");
          targetConnected = true;
          lastTargetCheck = now;
        } else {
          Serial.println("[Tunnel] ❌ Target connection failed");
          targetConnected = false;
          vTaskDelay(pdMS_TO_TICKS(3000));
          continue;
        }
      }

      // 2. Keepalive: периодически проверяем соединение
      if (targetConnected && (now - lastTargetCheck > TARGET_CHECK_INTERVAL)) {
        if (!targetClient.connected()) {
          Serial.println("[Tunnel] ❌ Target lost (keepalive check)");
          targetClient.stop();
          targetConnected = false;
          continue;
        }
        lastTargetCheck = now;
      }

      // 3. Читаем данные от целевого устройства (НЕБЛОКИРУЮЩЕЕ)
      if (targetConnected && targetClient.available()) {
        int bytesRead = targetClient.read(sendBuffer, BUFFER_SIZE);
        if (bytesRead > 0) {
          String sendUrl = nodeServerUrl + "/esp32/send?tunnel=" + tunnelId;
          
          String data = "";
          for (int i = 0; i < bytesRead; i++) {
            data += (char)sendBuffer[i];
          }
          
          StaticJsonDocument<3072> sendDoc;
          sendDoc["data"] = data;
          
          String sendJsonStr;
          serializeJson(sendDoc, sendJsonStr);
          
          httpSend.begin(sendUrl);
          httpSend.addHeader("Content-Type", "application/json");
          httpSend.setTimeout(5000);
          int httpCode = httpSend.POST(sendJsonStr);
          
          if (httpCode == 200) {
            Serial.printf("[Tunnel] 📤 -> Browser: %d bytes\n", bytesRead);
          } else {
            Serial.printf("[Tunnel] ⚠️ Send to browser failed: %d\n", httpCode);
          }
          
          httpSend.end();
        }
      }

      // 4. Polling: получаем данные от браузера
      String pollUrl = nodeServerUrl + "/esp32/poll?tunnel=" + tunnelId;
      
      httpPoll.begin(pollUrl);
      httpPoll.setTimeout(10000);  // 10 секунд timeout
      
      int httpCode = httpPoll.GET();
      
      if (httpCode == 200) {
        String payload = httpPoll.getString();
        
        StaticJsonDocument<2048> doc;
        if (deserializeJson(doc, payload) == DeserializationError::Ok) {
          if (doc.containsKey("data") && !doc["data"].isNull()) {
            const char* data = doc["data"];
            
            // Отправляем данные целевому устройству
            if (targetConnected && targetClient.connected()) {
              targetClient.print(data);
              Serial.printf("[Tunnel] 📥 -> Target: %d bytes\n", strlen(data));
            } else {
              Serial.println("[Tunnel] ⚠️ Target not connected, dropping browser data");
            }
          }
        }
      } else if (httpCode == -1) {
        // Timeout - это нормально для long polling
      } else {
        Serial.printf("[Tunnel] ⚠️ Poll failed: %d\n", httpCode);
      }
      
      httpPoll.end();
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
