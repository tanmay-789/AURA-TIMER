// Discord Voice Channel Timer Bot (ST!Timer style)
// Universal Voice Channel Mode - Works in ANY Voice Channel!
// Commands: /start, /stop, /timer

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
require("dotenv").config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN) {
  console.error("ERROR: DISCORD_BOT_TOKEN is missing in your environment variables!");
  process.exit(1);
}

// User-provided exact custom Discord server emojis
const EMOJI_WORK = "<:emoji_30:1522204006221480006>";
const EMOJI_INFO = "<:emoji_31:1534127948288884787>";
const EMOJI_STOP = "<:st92_water:1544945964589260843>";
const EMOJI_WISH = "<:stn_bforyou:1548637495921737860>";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

// Active timers: channelId => timer state
const activeTimers = new Map();

// Signature ST!Timer color
const ST_COLOR = 0xF04747;

// Format seconds into clean readable running time
function formatRemaining(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (s === 0) {
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  if (m === 0) {
    return `${s} ${s === 1 ? "second" : "seconds"}`;
  }
  return `${m}m ${s}s`;
}

// Exactly 3 clean slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("start a new group timer for your custom room")
    .addIntegerOption(opt =>
      opt.setName("session_time")
        .setDescription("session_time in minutes")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(180)
    )
    .addIntegerOption(opt =>
      opt.setName("break_time")
        .setDescription("break_time in minutes (mandatory)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(60)
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("stop a session"),
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Check current phase and time left"),
].map(cmd => cmd.toJSON());

/**
 * Register commands without duplicates:
 * Clears global commands completely and registers strictly per-guild.
 * This ensures:
 * 1. Zero duplicate commands (having both global and guild causes Discord to show 2 copies of each command)
 * 2. Instant activation with 0 seconds delay (no 1-hour global cache wait)
 */
async function registerCleanCommands(clientId) {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    console.log("Cleaning up duplicate commands and syncing fresh slash commands...");

    // 1. Clear global commands to remove any duplicate global copies
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log("✅ Cleared global application commands (prevents duplicate commands in slash menu).");

    // 2. Register single clean set of commands to each joined guild
    const guilds = await client.guilds.fetch();
    for (const [guildId, oAuth2Guild] of guilds) {
      try {
        const guild = await oAuth2Guild.fetch();
        await guild.commands.set(commands);
        console.log(`✅ Synced clean commands (/start, /stop, /timer) to guild: ${guild.name}`);
      } catch (err) {
        console.warn(`Warning: Could not sync commands to guild ${guildId}:`, err.message);
      }
    }
  } catch (error) {
    console.error("Failed to sync commands:", error);
  }
}

client.once("ready", async () => {
  console.log("✅ Logged in as " + client.user.tag);
  console.log("🌐 Universal Voice Channel Mode active.");
  await registerCleanCommands(CLIENT_ID || client.user.id);
});

// If invited to a new server, register commands immediately
client.on("guildCreate", async (guild) => {
  try {
    await guild.commands.set(commands);
    console.log(`Registered slash commands for newly joined server: ${guild.name}`);
  } catch (e) {
    console.error("Failed to register commands for new guild:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // If user tries legacy /pause or /resume
  if (cmd === "pause" || cmd === "resume") {
    const removedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "⚠️ **Command Removed**",
        `The \`/${cmd}\` command has been removed.`,
        "➔ **Please use /start, /stop, or /timer**",
        `${EMOJI_WISH} Good luck!`,
        "Do not change the timer without permissions of others"
      ].join("\n"));
    return interaction.reply({ embeds: [removedEmbed], ephemeral: true });
  }

  // Detect member voice channel
  let member = interaction.member;
  if ((!member || !member.voice || !member.voice.channel) && interaction.guild) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch (e) {
      // ignore
    }
  }

  let voiceChannel = member?.voice?.channel;
  if (!voiceChannel && interaction.channel && typeof interaction.channel.isVoiceBased === "function" && interaction.channel.isVoiceBased()) {
    voiceChannel = interaction.channel;
  }

  if (!voiceChannel) {
    const notConnectedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "❌ **Not Connected**",
        "You must be connected to a voice channel to use this command.",
        "➔ **Join any voice channel in the server, then run /start**",
        `${EMOJI_WISH} Good luck!`,
        "Do not change the timer without permissions of others"
      ].join("\n"));
    return interaction.reply({ embeds: [notConnectedEmbed], ephemeral: true });
  }

  // --- /start ---
  if (cmd === "start") {
    const sessionTime = interaction.options.getInteger("session_time", true);
    const breakTime = interaction.options.getInteger("break_time", true);

    // Cancel existing timer in this channel
    if (activeTimers.has(voiceChannel.id)) {
      const oldTimer = activeTimers.get(voiceChannel.id);
      if (oldTimer?.intervalId) clearInterval(oldTimer.intervalId);
      activeTimers.delete(voiceChannel.id);
    }

    const now = Date.now();
    const durationMs = sessionTime * 60 * 1000;

    const timerData = {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      sessionNumber: 1,
      phase: "session", // 'session' | 'break'
      sessionMinutes: sessionTime,
      breakMinutes: breakTime,
      targetEndTime: now + durationMs,
      startedBy: interaction.user.tag,
      intervalId: null,
      message: null,
      tickCount: 0
    };

    // Initial embed matching ST!Timer format exactly
    const initialEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        `${EMOJI_WORK} **New study session started**`,
        `Focus timer: **${sessionTime} minutes work** – **${breakTime} minutes break**`,
        `➔ **[WORK] Next break will be in ${sessionTime} minutes**`,
        `${EMOJI_WISH} Good luck! | Session 1`,
        "Do not change the timer without permissions of others"
      ].join("\n"));

    // Reply and capture the message so we can edit it live every 10s
    const replyMsg = await interaction.reply({ embeds: [initialEmbed], fetchReply: true });
    timerData.message = replyMsg;

    // Timer Loop: 1-second precision with Date.now() timestamp math
    timerData.intervalId = setInterval(async () => {
      const currentTime = Date.now();
      const remainingSeconds = Math.max(0, Math.round((timerData.targetEndTime - currentTime) / 1000));

      // 1. Transition when time expires
      if (remainingSeconds <= 0) {
        if (timerData.phase === "session") {
          // Work ended -> Break begins
          timerData.phase = "break";
          timerData.targetEndTime = Date.now() + (timerData.breakMinutes * 60 * 1000);
          timerData.tickCount = 0;

          const breakEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              "☕ **Break time started**",
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              `➔ **[BREAK] Next session will be in ${timerData.breakMinutes} minutes**`,
              `Take a break! | Session ${timerData.sessionNumber}`,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          try {
            const sentBreakMsg = await voiceChannel.send({ embeds: [breakEmbed] });
            timerData.message = sentBreakMsg; // Live updates continue on the new break message
          } catch (e) {
            console.error("Failed to send break announcement:", e);
          }
        } else if (timerData.phase === "break") {
          // Break ended -> Next Work session begins
          timerData.sessionNumber += 1;
          timerData.phase = "session";
          timerData.targetEndTime = Date.now() + (timerData.sessionMinutes * 60 * 1000);
          timerData.tickCount = 0;

          const workEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              `${EMOJI_WORK} **New study session started**`,
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              `➔ **[WORK] Next break will be in ${timerData.sessionMinutes} minutes**`,
              `${EMOJI_WISH} Good luck! | Session ${timerData.sessionNumber}`,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          try {
            const sentWorkMsg = await voiceChannel.send({ embeds: [workEmbed] });
            timerData.message = sentWorkMsg; // Live updates continue on the new work message
          } catch (e) {
            console.error("Failed to send new work session announcement:", e);
          }
        }
        return;
      }

      // 2. Live Update Every 10 Seconds
      timerData.tickCount = (timerData.tickCount || 0) + 1;
      if (timerData.tickCount >= 10 && timerData.message) {
        timerData.tickCount = 0;
        try {
          const isWork = timerData.phase === "session";
          const header = isWork
            ? `${EMOJI_WORK} **New study session started**`
            : "☕ **Break time started**";
          const nextTarget = isWork
            ? `➔ **[WORK] Next break will be in ${formatRemaining(remainingSeconds)}**`
            : `➔ **[BREAK] Next session will be in ${formatRemaining(remainingSeconds)}**`;
          const wish = isWork
            ? `${EMOJI_WISH} Good luck! | Session ${timerData.sessionNumber}`
            : `Take a break! | Session ${timerData.sessionNumber}`;

          const updatedEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              header,
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              nextTarget,
              wish,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          await timerData.message.edit({ embeds: [updatedEmbed] });
        } catch (err) {
          // If message was deleted by user or permissions changed, safely ignore
        }
      }
    }, 1000);

    activeTimers.set(voiceChannel.id, timerData);
  }

  // --- /stop ---
  else if (cmd === "stop") {
    const timer = activeTimers.get(voiceChannel.id);
    if (timer) {
      if (timer.intervalId) clearInterval(timer.intervalId);
      const sessionsCount = timer.sessionNumber || 1;
      activeTimers.delete(voiceChannel.id);

      const stopEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${EMOJI_STOP} **Study session stopped**`,
          `Focus timer: **${timer.sessionMinutes} minutes work** – **${timer.breakMinutes} minutes break**`,
          `➔ **[STOP] Timer stopped for this channel after ${sessionsCount} ${sessionsCount === 1 ? "session" : "sessions"}**`,
          `Good work! | Session ${sessionsCount}`,
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [stopEmbed] });
    } else {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${EMOJI_INFO} **Timer information**`,
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          `${EMOJI_WISH} Good luck!`,
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }
  }

  // --- /timer ---
  else if (cmd === "timer" || cmd === "time") {
    const timer = activeTimers.get(voiceChannel.id);
    if (!timer) {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${EMOJI_INFO} **Timer information**`,
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          `${EMOJI_WISH} Good luck!`,
          "Do not change the timer without permissions of others"
        ].join("\n"));
      return interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }

    const currentRemaining = Math.max(0, Math.round((timer.targetEndTime - Date.now()) / 1000));
    const isWork = timer.phase === "session";
    const phaseTitle = isWork ? "Timer information: Work!" : "Timer information: Break!";
    const targetText = isWork
      ? `➔ **[WORK] Next break will be in ${formatRemaining(currentRemaining)}**`
      : `➔ **[BREAK] Next session will be in ${formatRemaining(currentRemaining)}**`;
    const wishText = isWork
      ? `${EMOJI_WISH} Good luck! | Session ${timer.sessionNumber || 1}`
      : `Take a break! | Session ${timer.sessionNumber || 1}`;

    const timeEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        `${EMOJI_INFO} **${phaseTitle}**`,
        `Focus timer: **${timer.sessionMinutes} minutes work** – **${timer.breakMinutes} minutes break**`,
        targetText,
        wishText,
        "Do not change the timer without permissions of others"
      ].join("\n"));

    await interaction.reply({ embeds: [timeEmbed] });
  }
});

client.login(TOKEN);
