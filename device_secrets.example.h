#pragma once

#define WIFI_NETWORK_NAME "YOUR_WIFI_NAME"
#define WIFI_NETWORK_PASSWORD "YOUR_WIFI_PASSWORD"
#define CHARGER_DEVICE_TOKEN "SET_THE_CHARGER_CHG_001_TOKEN_SECRET"
#define SUPABASE_PUBLISHABLE_KEY "YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY"

// Paste the trusted CA certificate for your Supabase HTTPS endpoint here.
// Do not use setInsecure() for a charger control connection.
#define SUPABASE_ROOT_CA R"ROOT_CA(-----BEGIN CERTIFICATE-----
PASTE_TRUSTED_ROOT_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----)ROOT_CA"
