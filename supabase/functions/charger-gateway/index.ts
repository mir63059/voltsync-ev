import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return respond({ error: "POST required" }, 405);
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!token) return respond({ error: "Device token required" }, 401);

  let packet: Record<string, unknown>;
  try {
    packet = await request.json();
  } catch {
    return respond({ error: "Invalid JSON" }, 400);
  }

  const chargerId = packet.charger_id;
  if (typeof chargerId !== "string" || !/^CHG-[0-9]+$/.test(chargerId)) {
    return respond({ error: "Invalid charger_id" }, 400);
  }
  const tokenName = `CHARGER_${chargerId.replace(/-/g, "_")}_TOKEN`;
  const expectedToken = Deno.env.get(tokenName);
  if (!expectedToken || token !== expectedToken) {
    return respond({ error: "Invalid device token" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return respond({ error: "Gateway is not configured" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: station, error: stationError } = await supabase
    .from("stations")
    .select("id,status")
    .eq("id", chargerId)
    .maybeSingle();
  if (stationError) return respond({ error: stationError.message }, 500);
  if (!station) return respond({ error: "Charger not found" }, 404);

  const voltage = packet.voltage_v;
  const current = packet.current_a;
  const power = packet.power_kw;
  const energy = packet.energy_kwh;
  const hasValidTelemetry = packet.telemetry_valid === true
    && typeof voltage === "number" && Number.isFinite(voltage)
    && voltage > 0 && voltage <= 1000
    && typeof current === "number" && Number.isFinite(current)
    && current >= 0 && current <= 1000
    && typeof power === "number" && Number.isFinite(power)
    && power >= 0 && power <= 1000
    && typeof energy === "number" && Number.isFinite(energy)
    && energy >= 0 && energy <= 1_000_000;
  const deviceRelayOn = packet.relay_on === true;
  const now = new Date().toISOString();
  const { error: heartbeatError } = await supabase
    .from("stations")
    .update({ device_last_seen_at: now })
    .eq("id", chargerId);
  if (heartbeatError) return respond({ error: heartbeatError.message }, 500);

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id")
    .eq("station_id", chargerId)
    .eq("status", "active")
    .maybeSingle();
  if (sessionError) return respond({ error: sessionError.message }, 500);

  let stopRequired = false;
  if (hasValidTelemetry && session && deviceRelayOn) {
    const { data, error } = await supabase.rpc("record_charging_telemetry", {
      p_session_id: session.id,
      p_energy_kwh: energy,
      p_voltage: voltage,
      p_current: current,
      p_power_kw: power,
      p_battery_pct: null,
    });
    if (error) return respond({ error: error.message }, 409);
    stopRequired = data?.stop_required === true;
  } else if (hasValidTelemetry) {
    const updates: Record<string, unknown> = {
      voltage,
      current,
      power_kw: power,
    };
    if (!session) {
      updates.current_kwh = 0;
      updates.status = station.status === "disabled" ? "disabled" : "online";
      updates.battery_pct = null;
    }
    const { error } = await supabase
      .from("stations")
      .update(updates)
      .eq("id", chargerId);
    if (error) return respond({ error: error.message }, 500);
  } else {
    const updates: Record<string, unknown> = {
      voltage: 0,
      current: 0,
      power_kw: 0,
      status: station.status === "disabled" ? "disabled" : "offline",
    };
    const { error } = await supabase
      .from("stations")
      .update(updates)
      .eq("id", chargerId);
    if (error) return respond({ error: error.message }, 500);
  }

  const { data: latestStation, error: latestStationError } = await supabase
    .from("stations")
    .select("status")
    .eq("id", chargerId)
    .single();
  if (latestStationError) {
    return respond({ error: latestStationError.message }, 500);
  }
  const relayOn = !stopRequired
    && hasValidTelemetry
    && Boolean(session)
    && latestStation.status === "charging";

  return respond({
    charger_id: chargerId,
    active_session_id: session?.id ?? null,
    relay_on: relayOn,
    server_time: now,
  });
});
