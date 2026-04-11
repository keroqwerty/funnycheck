"use strict";

require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  ActivityType
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

/* =================================
   ENV
================================= */
const TOKEN = String(process.env.TOKEN || "").trim();
const PREFIX = String(process.env.PREFIX || ".").trim() || ".";
const VOICE_CHANNEL_ID = String(process.env.VOICE_CHANNEL_ID || "").trim();
const AUTO_VOICECHANNEL_JOIN =
  String(process.env.AUTO_VOICECHANNEL_JOIN || "true").trim().toLowerCase() === "true";
const STATUS_TEXT = String(process.env.STATUS_TEXT || ".yardim | klasik bot").trim();
const FOTO_YT_ROLE_NAME = String(process.env.FOTO_YT_ROLE_NAME || "Foto YT").trim();
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) {
  console.error("[FATAL] TOKEN bulunamadı.");
  process.exit(1);
}

/* =================================
   CLIENT
================================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel],
  allowedMentions: {
    parse: [],
    repliedUser: false
  }
});

/* =================================
   EXPRESS KEEPALIVE
================================= */
const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).send("Bot aktif");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    ready: client.isReady?.() || false,
    bot: client.user?.tag || null,
    wsStatus: client.ws?.status ?? null,
    wsPing: client.ws?.ping ?? null,
    uptimeSec: Math.floor(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    guilds: client.guilds?.cache?.size || 0,
    autoVoiceJoin: AUTO_VOICECHANNEL_JOIN,
    voiceChannelId: VOICE_CHANNEL_ID || null,
    timestamp: new Date().toISOString()
  });
});

app.use((_req, res) => {
  res.status(200).send("OK");
});

const server = app.listen(PORT, () => {
  console.log(`[WEB] Server ${PORT} portunda aktif.`);
});

server.on("error", (err) => {
  console.error("[WEB ERROR]", err);
});

/* =================================
   GLOBAL SAFETY / STATE
================================= */
Error.stackTraceLimit = 50;
process.setMaxListeners(50);

let voiceReconnectLock = false;
let voiceReconnectTimeout = null;
let trackedVoiceGuildId = null;

let loginInProgress = false;
let reloginTimeout = null;
let destroyInProgress = false;
let startupFinished = false;
let lastReadyAt = 0;
let lastGatewayHealthyAt = Date.now();

let watchdogInterval = null;
let cooldownCleanupInterval = null;

const cooldowns = new Map();
const COMMAND_COOLDOWN_MS = 3000;

/* =================================
   SECURITY CONFIG
================================= */
const ALLOWED_COMMANDS = new Set([
  "yardim",
  "yardım",
  "help",
  "av",
  "spotify",
  "spo",
  "vip",
  "foto",
  "serverinfo",
  "nuke"
]);

const BLOCKED_COMMANDS = new Set([
  "eval",
  "exec",
  "token",
  "shell",
  "cmd",
  "powershell",
  "bash",
  "debug",
  "console",
  "terminal",
  "join",
  "leave"
]);

const DISCORD_TOKEN_LIKE_REGEX =
  /\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6,10}\.[A-Za-z0-9_-]{20,40}\b/g;

const SUSPICIOUS_CONTENT_REGEX =
  /\b(eval|new Function|child_process|execSync|spawn|fork|process\.env|client\.token|Buffer\.from\s*\(.+base64|require\s*\(\s*['"`]child_process['"`]\s*\))\b/i;

/* =================================
   SAFE LOGGING / REDACTION
================================= */
function redactSensitive(input) {
  if (input == null) return input;

  let text;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }

  if (TOKEN) {
    text = text.split(TOKEN).join("[REDACTED_TOKEN]");
  }

  text = text.replace(DISCORD_TOKEN_LIKE_REGEX, "[REDACTED_TOKEN_LIKE]");
  return text;
}

function safeLog(...args) {
  console.log(...args.map(redactSensitive));
}

function safeError(...args) {
  console.error(...args.map(redactSensitive));
}

/* =================================
   HELPERS
================================= */
function normalizeCommandName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC");
}

function formatDuration(ms) {
  if (!ms || Number.isNaN(ms) || ms < 0) return "Bilinmiyor";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}g`);
  if (hours > 0) parts.push(`${hours}sa`);
  if (minutes > 0) parts.push(`${minutes}dk`);
  parts.push(`${seconds}sn`);

  return parts.join(" ");
}

function parseUserId(input) {
  if (!input) return null;

  const mention = String(input).match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];

  const rawId = String(input).match(/^(\d{17,20})$/);
  if (rawId) return rawId[1];

  return null;
}

async function resolveMember(message, text) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;

  const id = parseUserId(text);
  if (!id) return null;

  try {
    return await message.guild.members.fetch(id);
  } catch {
    return null;
  }
}

function isOnCooldown(userId) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;

  if (now - last < COMMAND_COOLDOWN_MS) return true;

  cooldowns.set(userId, now);
  return false;
}

function cleanupCooldowns() {
  const now = Date.now();
  for (const [userId, last] of cooldowns.entries()) {
    if (now - last > COMMAND_COOLDOWN_MS * 3) {
      cooldowns.delete(userId);
    }
  }
}

function isAdminMember(member, guild) {
  if (!member || !guild) return false;

  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.id === guild.ownerId
  );
}

async function deleteMessageSilently(message) {
  try {
    if (message.deletable) {
      await message.delete().catch(() => null);
    }
  } catch {}
}

function escapeMarkdownText(text) {
  return String(text || "").replace(/([\\_*~`>|])/g, "\\$1");
}

function formatDiscordTimestamp(date) {
  if (!date) return "Bilinmiyor";
  const unix = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${unix}:F>`;
}

async function getOrCreateRoleByName(guild, roleName, reason) {
  let role = guild.roles.cache.find((r) => r.name === roleName);

  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      reason
    });
  }

  return role;
}

async function addRoleSafely(message, targetMember, role, reason) {
  const me = message.guild.members.me || (await message.guild.members.fetchMe().catch(() => null));
  if (!me) {
    return { ok: false, message: "Bot kendi üye bilgisini çekemedi." };
  }

  if (role.position >= me.roles.highest.position) {
    return {
      ok: false,
      message: `\`${role.name}\` rolü botun en yüksek rolünden yukarıda veya aynı seviyede. Bot rolünü üste taşı.`
    };
  }

  if (targetMember.roles.highest.position >= me.roles.highest.position && message.guild.ownerId !== me.id) {
    return {
      ok: false,
      message: "Hedef kullanıcının en yüksek rolü botunkine eşit veya daha yukarıda."
    };
  }

  if (targetMember.roles.cache.has(role.id)) {
    return {
      ok: false,
      message: `${targetMember} kullanıcısında zaten \`${role.name}\` rolü var.`
    };
  }

  await targetMember.roles.add(role, reason);
  return { ok: true };
}

/* =================================
   VOICE
================================= */
async function getTargetVoiceChannel() {
  if (!AUTO_VOICECHANNEL_JOIN) return null;
  if (!VOICE_CHANNEL_ID) return null;

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel) return null;

  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    return null;
  }

  return channel;
}

function clearReconnectTimer() {
  if (voiceReconnectTimeout) {
    clearTimeout(voiceReconnectTimeout);
    voiceReconnectTimeout = null;
  }
}

function clearReloginTimer() {
  if (reloginTimeout) {
    clearTimeout(reloginTimeout);
    reloginTimeout = null;
  }
}

function markGatewayHealthy() {
  lastGatewayHealthyAt = Date.now();
}

function scheduleRelogin(delay = 10_000, reason = "Bilinmiyor") {
  if (reloginTimeout) return;

  safeLog(`[RELOGIN] ${delay}ms sonra yeniden bağlanılacak. Sebep: ${reason}`);

  reloginTimeout = setTimeout(async () => {
    reloginTimeout = null;
    await relogin(reason);
  }, delay);
}

async function safeDestroyClient() {
  if (destroyInProgress) return;
  destroyInProgress = true;

  try {
    clearReconnectTimer();

    for (const guild of client.guilds.cache.values()) {
      const conn = getVoiceConnection(guild.id);
      if (conn) {
        try {
          conn.destroy();
        } catch {}
      }
    }

    if (client.isReady?.() || client.ws?.status != null) {
      try {
        client.destroy();
      } catch (err) {
        safeError("[CLIENT DESTROY ERROR]", err);
      }
    }
  } finally {
    destroyInProgress = false;
  }
}

async function relogin(reason = "Bilinmiyor") {
  if (loginInProgress) return;

  safeLog(`[RELOGIN] Başlatıldı. Sebep: ${reason}`);

  await safeDestroyClient();
  await startBot();
}

async function connectToConfiguredVoice() {
  if (!AUTO_VOICECHANNEL_JOIN) return null;
  if (voiceReconnectLock) return null;

  voiceReconnectLock = true;

  try {
    const channel = await getTargetVoiceChannel();
    if (!channel) {
      safeLog("[VOICE] Hedef ses kanalı bulunamadı veya geçersiz.");
      return null;
    }

    const guild = channel.guild;
    trackedVoiceGuildId = guild.id;

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      safeLog("[VOICE] Bot member bilgisi alınamadı.");
      return null;
    }

    const perms = channel.permissionsFor(me);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms.has(PermissionsBitField.Flags.Connect)
    ) {
      safeLog("[VOICE] Ses kanalına bağlanma yetkisi yok.");
      return null;
    }

    const existing = getVoiceConnection(guild.id);

    if (existing) {
      const currentChannelId = existing.joinConfig?.channelId;
      const state = existing.state?.status;

      if (
        currentChannelId === channel.id &&
        state !== VoiceConnectionStatus.Destroyed &&
        state !== VoiceConnectionStatus.Disconnected
      ) {
        return existing;
      }

      try {
        existing.destroy();
      } catch (err) {
        safeError("[VOICE] Eski bağlantı silinirken hata:", err);
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    connection.on("stateChange", (oldState, newState) => {
      safeLog(`[VOICE] ${oldState.status} -> ${newState.status}`);

      if (
        newState.status === VoiceConnectionStatus.Disconnected ||
        newState.status === VoiceConnectionStatus.Destroyed
      ) {
        scheduleVoiceReconnect();
      }
    });

    connection.on("error", (err) => {
      safeError("[VOICE CONNECTION ERROR]", err);
      scheduleVoiceReconnect();
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    safeLog(`[VOICE] Bağlandı: ${channel.name}`);

    clearReconnectTimer();
    return connection;
  } catch (err) {
    safeError("[VOICE] Bağlanırken hata:", err);
    scheduleVoiceReconnect();
    return null;
  } finally {
    voiceReconnectLock = false;
  }
}

function scheduleVoiceReconnect(delay = 10_000) {
  if (!AUTO_VOICECHANNEL_JOIN) return;
  if (!VOICE_CHANNEL_ID) return;
  if (voiceReconnectTimeout) return;

  voiceReconnectTimeout = setTimeout(async () => {
    voiceReconnectTimeout = null;
    await connectToConfiguredVoice();
  }, delay);
}

async function voiceWatchdog() {
  try {
    if (!AUTO_VOICECHANNEL_JOIN) return;
    if (!VOICE_CHANNEL_ID || !trackedVoiceGuildId) return;

    const channel = await getTargetVoiceChannel();
    if (!channel) return;

    const conn = getVoiceConnection(trackedVoiceGuildId);

    if (!conn) {
      safeLog("[VOICE WATCHDOG] Connection yok, tekrar bağlanılıyor.");
      await connectToConfiguredVoice();
      return;
    }

    const currentChannelId = conn.joinConfig?.channelId;
    const state = conn.state?.status;

    if (
      currentChannelId !== channel.id ||
      state === VoiceConnectionStatus.Destroyed ||
      state === VoiceConnectionStatus.Disconnected
    ) {
      safeLog("[VOICE WATCHDOG] Connection bozuk, tekrar bağlanılıyor.");
      try {
        conn.destroy();
      } catch {}
      await connectToConfiguredVoice();
    }
  } catch (err) {
    safeError("[VOICE WATCHDOG ERROR]", err);
  }
}

/* =================================
   SENSITIVE MESSAGE PROTECTION
================================= */
async function tryDeleteSensitiveMessage(message) {
  if (!message.guild) return false;
  if (!message.deletable) return false;

  const hasTokenLike = DISCORD_TOKEN_LIKE_REGEX.test(message.content);
  DISCORD_TOKEN_LIKE_REGEX.lastIndex = 0;

  if (!hasTokenLike) return false;

  await message.delete().catch(() => null);

  try {
    await message.author
      .send(
        "Güvenlik nedeniyle token benzeri görünen bir mesajın silindi. Bot tokenini veya benzer hassas verileri paylaşma."
      )
      .catch(() => null);
  } catch {}

  return true;
}

/* =================================
   PRESENCE
================================= */
async function applyPresence() {
  try {
    if (!client.user) return;

    client.user.setPresence({
      status: "idle",
      activities: [
        {
          name: STATUS_TEXT,
          type: ActivityType.Watching
        }
      ]
    });
  } catch (err) {
    safeError("[PRESENCE ERROR]", err);
  }
}

/* =================================
   WATCHDOGS
================================= */
async function gatewayWatchdog() {
  try {
    const now = Date.now();

    if (client.isReady?.()) {
      markGatewayHealthy();
    }

    const wsPing = client.ws?.ping;
    const wsStatus = client.ws?.status;

    if (typeof wsPing === "number" && wsPing >= 0 && wsPing < 60_000) {
      markGatewayHealthy();
    }

    const sinceHealthy = now - lastGatewayHealthyAt;
    const sinceReady = lastReadyAt ? now - lastReadyAt : null;

    if (!startupFinished) return;

    if (!client.isReady?.() && sinceHealthy > 180_000) {
      safeError("[WATCHDOG] Client ready değil, kontrollü relogin başlatılıyor.");
      scheduleRelogin(5_000, "Client ready değil / gateway stale");
      return;
    }

    if (typeof wsPing === "number" && wsPing > 30_000) {
      safeError(`[WATCHDOG] Ping aşırı yüksek: ${wsPing}ms`);
    }

    if (
      typeof wsStatus === "number" &&
      !client.isReady?.() &&
      sinceHealthy > 180_000 &&
      (sinceReady == null || sinceReady > 180_000)
    ) {
      scheduleRelogin(5_000, `WS status unhealthy: ${wsStatus}`);
      return;
    }

    const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memoryMb > 450) {
      safeError(`[WATCHDOG] Yüksek RAM kullanımı: ${memoryMb}MB`);
    }

    await voiceWatchdog();
  } catch (err) {
    safeError("[WATCHDOG ERROR]", err);
  }
}

function startIntervals() {
  if (!watchdogInterval) {
    watchdogInterval = setInterval(() => {
      gatewayWatchdog();
    }, 60_000);
  }

  if (!cooldownCleanupInterval) {
    cooldownCleanupInterval = setInterval(() => {
      cleanupCooldowns();
    }, 60_000);
  }
}

/* =================================
   PROCESS EVENTS
================================= */
process.on("unhandledRejection", (reason) => {
  safeError("[UNHANDLED REJECTION]", reason);
});

process.on("uncaughtException", (error) => {
  safeError("[UNCAUGHT EXCEPTION]", error);
});

process.on("uncaughtExceptionMonitor", (error) => {
  safeError("[UNCAUGHT EXCEPTION MONITOR]", error);
});

process.on("SIGTERM", async () => {
  safeLog("[SIGTERM] Kapatılıyor...");
  try {
    clearReconnectTimer();
    clearReloginTimer();
    await safeDestroyClient();
    server.close?.();
  } catch (err) {
    safeError("[SIGTERM ERROR]", err);
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  safeLog("[SIGINT] Kapatılıyor...");
  try {
    clearReconnectTimer();
    clearReloginTimer();
    await safeDestroyClient();
    server.close?.();
  } catch (err) {
    safeError("[SIGINT ERROR]", err);
  } finally {
    process.exit(0);
  }
});

/* =================================
   CLIENT EVENTS
================================= */
client.on("error", (err) => {
  safeError("[CLIENT ERROR]", err);
});

client.on("warn", (info) => {
  safeLog("[CLIENT WARN]", info);
});

client.on("shardError", (err) => {
  safeError("[SHARD ERROR]", err);
});

client.on("shardDisconnect", (event, shardId) => {
  safeError(`[SHARD DISCONNECT] shard=${shardId} code=${event?.code} reason=${event?.reason || "Yok"}`);
  scheduleRelogin(10_000, "Shard disconnect");
});

client.on("shardReconnecting", (shardId) => {
  safeLog(`[SHARD RECONNECTING] shard=${shardId}`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  safeLog(`[SHARD RESUME] shard=${shardId} replayed=${replayedEvents}`);
  markGatewayHealthy();
});

client.on("invalidated", () => {
  safeError("[INVALIDATED] Session invalidated.");
  scheduleRelogin(15_000, "Session invalidated");
});

client.on("ready", async () => {
  lastReadyAt = Date.now();
  markGatewayHealthy();
  startupFinished = true;

  safeLog(`[READY] ${client.user.tag} giriş yaptı.`);
  await applyPresence();
  await connectToConfiguredVoice();
});

client.ws.on("debug", () => {
  markGatewayHealthy();
});

client.on("raw", () => {
  markGatewayHealthy();
});

/* =================================
   COMMANDS
================================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    await tryDeleteSensitiveMessage(message);

    if (!message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    if (raw.length > 500) return;

    const args = raw.split(/\s+/);
    const command = normalizeCommandName(args.shift());
    const restText = args.join(" ").trim();

    if (!command) return;

    if (!ALLOWED_COMMANDS.has(command) && !BLOCKED_COMMANDS.has(command)) {
      return;
    }

    if (BLOCKED_COMMANDS.has(command)) {
      await deleteMessageSilently(message);
      return;
    }

    if (SUSPICIOUS_CONTENT_REGEX.test(raw)) {
      await deleteMessageSilently(message);
      return;
    }

    const helpCommands = new Set(["yardim", "yardım", "help"]);
    const restrictedCommands = new Set(["vip", "foto", "nuke"]);

    if (helpCommands.has(command)) {
      if (!isAdminMember(message.member, message.guild)) {
        await deleteMessageSilently(message);
        return;
      }
    }

    if (isOnCooldown(message.author.id)) return;

    if (command === "yardim" || command === "yardım" || command === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle("Komutlar")
        .setDescription(
          [
            `\`${PREFIX}av\` → Kendi avatarını gösterir`,
            `\`${PREFIX}av @user\` → Etiketlenen kişinin avatarını gösterir`,
            `\`${PREFIX}spotify\` / \`${PREFIX}spo\` → Spotify bilgisi`,
            `\`${PREFIX}spotify @user\` → Etiketlenen kişinin Spotify bilgisi`,
            `\`${PREFIX}serverinfo\` → Sunucu bilgilerini gösterir`,
            `\`${PREFIX}vip @user\` veya \`${PREFIX}vip ID\` → Special rolü verir`,
            `\`${PREFIX}foto @user\` veya \`${PREFIX}foto ID\` → Foto YT rolü verir`,
            `\`${PREFIX}nuke\` → Bulunduğun kanalı sıfırlar`
          ].join("\n")
        )
        .setFooter({ text: `${message.guild.name}` });

      return message.reply({ embeds: [embed] });
    }

    if (command === "av") {
      const member = (await resolveMember(message, restText)) || message.member;
      const avatar = member.user.displayAvatarURL({
        size: 4096,
        extension: "png"
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${member.user.tag} avatarı`)
        .setImage(avatar)
        .setDescription(`[Tarayıcıda aç](${avatar})`);

      return message.reply({ embeds: [embed] });
    }

    if (command === "spotify" || command === "spo") {
      const member = (await resolveMember(message, restText)) || message.member;

      if (!member.presence) {
        return message.reply(
          "Presence bilgisi görünmüyor. Developer Portal'da Presence Intent açık olmalı."
        );
      }

      const spotifyActivity = member.presence.activities.find(
        (a) => a.name === "Spotify"
      );

      if (!spotifyActivity) {
        return message.reply("Bu kullanıcı şu an Spotify dinlemiyor.");
      }

      const track = spotifyActivity.details || "Bilinmiyor";
      const artist = spotifyActivity.state || "Bilinmiyor";
      const album = spotifyActivity.assets?.largeText || "Bilinmiyor";
      const cover = spotifyActivity.assets?.largeImageURL?.() || null;

      const startedAt = spotifyActivity.timestamps?.start?.getTime?.() || null;
      const endsAt = spotifyActivity.timestamps?.end?.getTime?.() || null;

      const elapsed = startedAt ? Date.now() - startedAt : null;
      const total = startedAt && endsAt ? endsAt - startedAt : null;

      const spotifyUrl = spotifyActivity.syncId
        ? `https://open.spotify.com/track/${spotifyActivity.syncId}`
        : null;

      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setAuthor({ name: `${member.user.tag} Spotify dinliyor` })
        .addFields(
          { name: "Şarkı", value: track, inline: false },
          { name: "Sanatçı", value: artist, inline: false },
          { name: "Albüm", value: album, inline: false },
          {
            name: "Süre",
            value: `${formatDuration(elapsed)} / ${formatDuration(total)}`,
            inline: false
          }
        )
        .setFooter({ text: "Spotify Activity" });

      if (cover) embed.setThumbnail(cover);
      if (spotifyUrl) embed.setDescription(`[Spotify'da aç](${spotifyUrl})`);

      return message.reply({ embeds: [embed] });
    }

    if (command === "serverinfo") {
      const guild = message.guild;

      await guild.fetch().catch(() => null);

      const owner =
        (await guild.fetchOwner().catch(() => null)) || null;

      const totalMembers = guild.memberCount || 0;
      const botCount = guild.members.cache.filter((m) => m.user.bot).size;
      const userCount = totalMembers - botCount;

      const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size;
      const voiceChannels = guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
      ).size;
      const categoryCount = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).size;
      const roleCount = guild.roles.cache.size;
      const emojiCount = guild.emojis.cache.size;

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${guild.name} - Sunucu Bilgisi`)
        .addFields(
          { name: "Sunucu ID", value: guild.id, inline: true },
          { name: "Sahip", value: owner ? `${owner.user.tag}` : "Bilinmiyor", inline: true },
          { name: "Oluşturulma", value: formatDiscordTimestamp(guild.createdAt), inline: false },
          { name: "Üye", value: `Toplam: ${totalMembers}\nKullanıcı: ${userCount}\nBot: ${botCount}`, inline: true },
          { name: "Kanallar", value: `Yazı: ${textChannels}\nSes: ${voiceChannels}\nKategori: ${categoryCount}`, inline: true },
          { name: "Diğer", value: `Rol: ${roleCount}\nEmoji: ${emojiCount}`, inline: true }
        )
        .setFooter({ text: `${guild.name}` });

      if (guild.iconURL()) {
        embed.setThumbnail(guild.iconURL({ size: 4096, extension: "png" }));
      }

      return message.reply({ embeds: [embed] });
    }

    if (restrictedCommands.has(command)) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles) && command !== "nuke") {
        return;
      }

      if (command === "nuke" && !message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return;
      }
    }

    if (command === "vip") {
      const targetMember = await resolveMember(message, restText);
      if (!targetMember) {
        return message.reply("Bir kullanıcı etiketle veya geçerli bir ID yaz.");
      }

      const role = await getOrCreateRoleByName(
        message.guild,
        "Special",
        "VIP komutu için otomatik oluşturuldu"
      );

      const result = await addRoleSafely(
        message,
        targetMember,
        role,
        `${message.author.tag} tarafından VIP verildi`
      );

      if (!result.ok) {
        return message.reply(result.message);
      }

      return message.reply(`✅ ${targetMember} kullanıcısına başarıyla Special rolü verildi.`);
    }

    if (command === "foto") {
      const targetMember = await resolveMember(message, restText);
      if (!targetMember) {
        return message.reply("Bir kullanıcı etiketle veya geçerli bir ID yaz.");
      }

      const role = await getOrCreateRoleByName(
        message.guild,
        FOTO_YT_ROLE_NAME,
        "Foto komutu için otomatik oluşturuldu"
      );

      const result = await addRoleSafely(
        message,
        targetMember,
        role,
        `${message.author.tag} tarafından foto yt verildi`
      );

      if (!result.ok) {
        return message.reply(result.message);
      }

      return message.reply(`${targetMember} kullanıcısına başarıyla foto yt verildi.`);
    }

    if (command === "nuke") {
      const oldChannel = message.channel;
      if (!oldChannel || typeof oldChannel.clone !== "function") {
        return message.reply("Bu kanal nuke için uygun değil.");
      }

      const me = message.guild.members.me || (await message.guild.members.fetchMe().catch(() => null));
      if (!me) {
        return message.reply("Bot kendi yetkilerini kontrol edemedi.");
      }

      const perms = oldChannel.permissionsFor(me);
      if (
        !perms ||
        !perms.has(PermissionsBitField.Flags.ManageChannels) ||
        !perms.has(PermissionsBitField.Flags.ViewChannel)
      ) {
        return message.reply("Bu kanalda gerekli yetkilere sahip değilim.");
      }

      const oldPosition = oldChannel.rawPosition;
      const oldParentId = oldChannel.parentId;
      const oldName = oldChannel.name;

      const newChannel = await oldChannel.clone({
        name: oldName,
        reason: `${message.author.tag} tarafından nuke kullanıldı`
      });

      if (oldParentId) {
        await newChannel
          .setParent(oldParentId, { lockPermissions: false })
          .catch(() => null);
      }

      await newChannel.setPosition(oldPosition).catch(() => null);
      await oldChannel.delete(`${message.author.tag} tarafından nuke kullanıldı`);
      await newChannel.setPosition(oldPosition).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(0xff3b30)
        .setTitle("💥 Kanal Nukelendi")
        .setDescription(`Bu kanal ${escapeMarkdownText(message.author.tag)} tarafından yenilendi.`);

      try {
        await newChannel.send({ embeds: [embed] });
      } catch {}

      return;
    }
  } catch (error) {
    safeError("[COMMAND ERROR]", error);
    try {
      await message.reply("Komut çalışırken bir hata oluştu.");
    } catch {}
  }
});

/* =================================
   START / LOGIN
================================= */
async function startBot() {
  if (loginInProgress) return;
  loginInProgress = true;

  try {
    clearReloginTimer();

    if (client.token) {
      try {
        await safeDestroyClient();
      } catch {}
    }

    safeLog("[LOGIN] Discord'a bağlanılıyor...");
    await client.login(TOKEN);
    markGatewayHealthy();
  } catch (err) {
    safeError("[LOGIN ERROR]", err);
    scheduleRelogin(15_000, "Login başarısız");
  } finally {
    loginInProgress = false;
  }
}

startIntervals();
startBot();
