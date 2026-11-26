/*
  RideaseVX — ESP32 + PZEM-004T
  Libraries: PZEM004Tv2, ArduinoJson
  Configure device_secrets.h from device_secrets.example.h before compiling.
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <PZEM004Tv2.h>
#include "device_secrets.h"

#define CHARGER_ID "CHG-001"
#define RELAY_PIN 25
#define RELAY_ACTIVE_LOW true
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

const char* GATEWAY_URL = "https://atucbucsqqtadfgzowiy.supabase.co/functions/v1/charger-gateway";
const unsigned long POLL_INTERVAL_MS = 2000;
const unsigned long COMMAND_TIMEOUT_MS = 8000;

PZEM004Tv2 pzem(PZEM_RX_PIN, PZEM_TX_PIN);
bool relayOn = false;
bool mustObserveIdle = true;
unsigned long lastPollMs = 0;
unsigned long lastSuccessfulCommandMs = 0;
float sessionEnergyBaseline = 0;

void setRelay(bool on) {
  relayOn = on;
  const int onLevel = RELAY_ACTIVE_LOW ? LOW : HIGH;
  digitalWrite(RELAY_PIN, on ? onLevel : !onLevel);
}

void failSafeOff(const char* reason) {
  if (relayOn) {
    Serial.printf("Fail-safe: relay OFF (%s)\n", reason);
  }
  setRelay(false);
  mustObserveIdle = true;
}

void sendGatewayPoll() {
  if (WiFi.status() != WL_CONNECTED) return;

  const float voltage = pzem.voltage();
  const float current = pzem.current();
  const float powerW = pzem.power();
  const float totalEnergy = pzem.energy();
  const bool telemetryValid = isfinite(voltage) && voltage > 0
      && isfinite(current) && current >= 0
      && isfinite(powerW) && powerW >= 0
      && isfinite(totalEnergy) && totalEnergy >= 0;

  StaticJsonDocument<256> packet;
  packet["charger_id"] = CHARGER_ID;
  packet["telemetry_valid"] = telemetryValid;
  packet["relay_on"] = relayOn;
  if (telemetryValid) {
    packet["voltage_v"] = voltage;
    packet["current_a"] = current;
    packet["power_kw"] = powerW / 1000.0f;
    packet["energy_kwh"] = relayOn
        ? max(0.0f, totalEnergy - sessionEnergyBaseline)
        : 0.0f;
  }

  String requestBody;
  serializeJson(packet, requestBody);

  WiFiClientSecure tlsClient;
  tlsClient.setCACert(SUPABASE_ROOT_CA);
  HTTPClient http;
  http.setTimeout(5000);
  if (!http.begin(tlsClient, GATEWAY_URL)) {
    Serial.println("Could not initialize secure gateway connection");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
  http.addHeader("Authorization", String("Bearer ") + CHARGER_DEVICE_TOKEN);

  const int httpCode = http.POST(requestBody);
  if (httpCode < 200 || httpCode >= 300) {
    Serial.printf("Gateway request failed: HTTP %d\n", httpCode);
    if (httpCode > 0) Serial.println(http.getString());
    http.end();
    return;
  }

  StaticJsonDocument<256> reply;
  const DeserializationError parseError = deserializeJson(reply, http.getString());
  http.end();
  if (parseError) {
    Serial.printf("Invalid gateway response: %s\n", parseError.c_str());
    return;
  }
  lastSuccessfulCommandMs = millis();

  const bool requestedOn = reply["relay_on"] | false;
  const char* sessionId = reply["active_session_id"] | "";
  const bool hasSession = sessionId[0] != '\0';

  if (!hasSession) {
    mustObserveIdle = false;
    if (relayOn) setRelay(false);
  } else if (!requestedOn) {
    failSafeOff("gateway denied charging command");
  } else if (mustObserveIdle) {
    setRelay(false);
    Serial.println("Active session requires an idle/stop cycle before this device can charge");
  } else if (!relayOn) {
    sessionEnergyBaseline = totalEnergy;
    setRelay(true);
    Serial.println("Relay ON: active app session");
  }

  Serial.printf("Meter: %.1f V, %.2f A, %.3f kW; desired relay: %s\n",
                telemetryValid ? voltage : 0,
                telemetryValid ? current : 0,
                telemetryValid ? powerW / 1000.0f : 0,
                requestedOn ? "ON" : "OFF");
}

void setup() {
  Serial.begin(115200);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_NETWORK_NAME, WIFI_NETWORK_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  const unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("Wi-Fi connection timed out; relay remains OFF");
  }
}

void loop() {
  const unsigned long now = millis();
  if (now - lastPollMs >= POLL_INTERVAL_MS) {
    lastPollMs = now;
    sendGatewayPoll();
  }

  if (lastSuccessfulCommandMs == 0
      || now - lastSuccessfulCommandMs > COMMAND_TIMEOUT_MS) {
    failSafeOff("gateway command timeout");
  }
  delay(10);
}
