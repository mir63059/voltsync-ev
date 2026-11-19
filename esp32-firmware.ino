/*
  RideaseVX — ESP32 + PZEM-004T charger firmware
  Required libraries: PubSubClient, PZEM004Tv2 (or PZEM004T) by Mandulaj
  Hardware: PZEM TX->ESP32 RX2, PZEM RX->ESP32 TX2 (3.3V logic; isolate mains side)
  MQTT topics:
    voltsync/CHG-001/telemetry  (ESP32 -> broker)
    voltsync/CHG-001/command    (broker -> ESP32)
  Optional: configure SUPABASE_* and send REST PATCH to /rest/v1/chargers?id=eq.CHG-001
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <PZEM004Tv2.h>

#define CHARGER_ID "CHG-001"
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST = "broker.example.com";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "";
const char* MQTT_PASSWORD = "";

// Optional Supabase REST mirror. Never put the service-role key in firmware.
const char* SUPABASE_URL = ""; // https://project.supabase.co
const char* SUPABASE_ANON_KEY = "";

#define RELAY_PIN 25
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
PZEM004Tv2 pzem(PZEM_RX_PIN, PZEM_TX_PIN);

const char* TELEMETRY_TOPIC = "voltsync/CHG-001/telemetry";
const char* COMMAND_TOPIC = "voltsync/CHG-001/command";

bool chargingEnabled = false;
bool mqttWasConnected = false;
unsigned long lastTelemetryMs = 0;
float sessionKwhAtStart = 0;
float sessionEnergyKwh = 0;

void logPacket(const char* direction, const String& payload) {
  Serial.printf("[%s] %s: %s\n", direction, CHARGER_ID, payload.c_str());
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String packet;
  packet.reserve(length);
  for (unsigned int i = 0; i < length; i++) packet += (char)payload[i];
  logPacket("MQTT COMMAND", packet);

  packet.toUpperCase();
  if (packet.indexOf("\"COMMAND\":\"START\"") >= 0 || packet.indexOf("START") >= 0) {
    chargingEnabled = true;
    digitalWrite(RELAY_PIN, HIGH);
    sessionKwhAtStart = pzem.energy();
  } else if (packet.indexOf("\"COMMAND\":\"STOP\"") >= 0 || packet.indexOf("STOP") >= 0) {
    chargingEnabled = false;
    digitalWrite(RELAY_PIN, LOW);
  } else if (packet.indexOf("DISABLE") >= 0) {
    chargingEnabled = false;
    digitalWrite(RELAY_PIN, LOW);
  } else if (packet.indexOf("ENABLE") >= 0) {
    digitalWrite(RELAY_PIN, LOW); // Remains offline until an explicit START command.
  }
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500); Serial.print('.');
  }
  Serial.println();
  Serial.printf("Wi-Fi: %s\n", WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "offline");
}

void connectMqtt() {
  if (mqtt.connected()) return;
  String clientId = String("volt-") + CHARGER_ID + '-' + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.print("Connecting MQTT...");
  bool ok = mqtt.connect(clientId.c_str(), MQTT_USER[0] ? MQTT_USER : NULL,
                        MQTT_PASSWORD[0] ? MQTT_PASSWORD : NULL);
  if (ok) {
    mqtt.subscribe(COMMAND_TOPIC, 1);
    mqtt.publish((String("voltsync/") + CHARGER_ID + "/status").c_str(),
                 "{\"charger_id\":\"CHG-001\",\"status\":\"online\"}", true);
    Serial.println(" connected");
  } else {
    Serial.printf(" failed, rc=%d\n", mqtt.state());
  }
}

void mirrorSupabase(float voltage, float current, float energy, int batteryPct) {
  if (strlen(SUPABASE_URL) == 0 || strlen(SUPABASE_ANON_KEY) == 0) return;
  WiFiClientSecure secure;
  secure.setInsecure();
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/chargers?id=eq." + CHARGER_ID;
  if (!http.begin(secure, url)) return;
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=minimal");
  String body = "{\"status\":" + String(chargingEnabled ? "\"charging\"" : "\"online\"") +
                ",\"voltage\":" + String(voltage, 1) +
                ",\"current\":" + String(current, 1) +
                ",\"current_kwh\":" + String(energy, 3) +
                ",\"battery_pct\":" + String(batteryPct) +
                ",\"updated_at\":\"" + String(millis()) + "\"}";
  http.PATCH(body); // RLS must permit the firmware/role; prefer an authenticated backend RPC in production.
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  pzem.resetEnergy();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  connectWifi();
}

void loop() {
  connectWifi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastTelemetryMs < 2000) return;
  lastTelemetryMs = now;

  float voltage = pzem.voltage();
  float current = pzem.current();
  float totalKwh = pzem.energy();
  float power = pzem.power();
  if (isnan(voltage) || isnan(current)) { voltage = 0; current = 0; power = 0; }

  if (chargingEnabled) {
    sessionEnergyKwh = max(0.0f, totalKwh - sessionKwhAtStart);
  } else {
    sessionEnergyKwh = 0;
  }

  int batteryPct = chargingEnabled ? min(100, 42 + (int)(sessionEnergyKwh * 100.0f / 50.0f)) : 42;
  String payload = "{\"charger_id\":\"" CHARGER_ID
                   "\",\"status\":\"" + String(chargingEnabled ? "charging" : "online") +
                   "\",\"voltage_v\":" + String(voltage, 1) +
                   ",\"current_a\":" + String(current, 1) +
                   ",\"power_kw\":" + String(power / 1000.0f, 3) +
                   ",\"energy_kwh\":" + String(sessionEnergyKwh, 3) +
                   ",\"battery_pct\":" + String(batteryPct) +
                   ",\"relay_on\":" + String(chargingEnabled ? "true" : "false") +
                   ",\"timestamp_ms\":" + String(now) + "}";

  if (mqtt.connected()) {
    mqtt.publish(TELEMETRY_TOPIC, payload.c_str(), false);
  }
  logPacket("MQTT TELEMETRY", payload);
  mirrorSupabase(voltage, current, sessionEnergyKwh, batteryPct);
}
