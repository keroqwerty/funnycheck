"use strict";

require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const TOKEN = String(process.env.TOKEN || "").trim();
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
  console.error("[FATAL] TOKEN yok");
  process.exit(1);
}

const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("bot aktif");
});

app.listen(PORT, () => {
  console.log(`[WEB] Server ${PORT} portunda aktif.`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`[READY] ${client.user.tag} giriş yaptı`);
});

client.on("error", (err) => {
  console.error("[CLIENT ERROR]", err);
});

client.on("warn", (msg) => {
  console.log("[WARN]", msg);
});

client.on("shardError", (err) => {
  console.error("[SHARD ERROR]", err);
});

client.on("shardDisconnect", (event, id) => {
  console.error(`[SHARD DISCONNECT] shard=${id} code=${event?.code} reason=${event?.reason || "yok"}`);
});

client.on("shardReconnecting", (id) => {
  console.log(`[SHARD RECONNECTING] shard=${id}`);
});

client.on("invalidated", () => {
  console.error("[INVALIDATED] oturum geçersiz");
});

(async () => {
  try {
    console.log("[LOGIN] Discord'a bağlanılıyor...");
    await client.login(TOKEN);
    console.log("[LOGIN OK] login çağrısı döndü");
  } catch (err) {
    console.error("[LOGIN ERROR]", err);
  }
})();
