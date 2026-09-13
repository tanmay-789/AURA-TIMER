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
const EMOJI_WISH = "<:stn_bforyou:1544939254671478794>";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

// Active timers: channelId => timer state
const activeTimers = new Map();

// Signature ST!Timer color: #F04747
const ST_COLOR = 0xF04747;

// Exactly 3 clean slash commands (/start, /stop, /timer)
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
 * Register commands cleanly without duplicates:
 * 1. Clears global application commands completely (eliminates duplicate entries)
 * 2. Registers clean single set of commands to each joined guild for 0-second instant activation
 */
async function registerCleanCommands(clientId) {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    console.log("Cleaning up duplicate commands and syncing fresh slash commands...");

    // Clear global commands to remove duplicate entries in slash menu
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log("✅ Cleared global application commands (prevents duplicates).");

    // Register strictly to guilds currently joined
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

client.on("guildCreate", async (guild) => {
  try {
    await guild.commands.set(commands);
    console.log(`Registered slash commands for newly joined server: ${guild.name}`);
  } catch (e) {
    console.error("Failed to register commands for new guild:", e);
  }
});

// Helper to build embed exactly matching ST!Timer screenshot
function buildTimerEmbed(phase, sessionMins, breakMins, targetUnix, sessionNum) {
  const isWork = phase === "session";
  const header = isWork
    ? `${EMOJI_WORK} **New study session started**`
    : "☕ **Break time started**";

  const targetLine = isWork
    ? `➔ **[WORK] Next break will be** <t:${targetUnix}:R>`
    : `➔ **[BREAK] Next session will be** <t:${targetUnix}:R>`;

  const subLine = isWork
    ? `Good luck! | Session ${sessionNum}`
    : `Take a break! | Session ${sessionNum}`;

  return new EmbedBuilder()
    .setColor(ST_COLOR)
    .setDescription([
      header,
      `Focus timer: **${sessionMins} minutes work** – **${breakMins} minutes break**`,
      "",
      targetLine,
      subLine,
      `${EMOJI_WISH} Do not change the timer without permissions of others`
    ].join("\n"));
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // Legacy commands removed notice
  if (cmd === "pause" || cmd === "resume") {
    const removedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "⚠️ **Command Removed**",
        `The \`/${cmd}\` command has been removed.`,
        "➔ **Please use /start, /stop, or /timer**",
        "Good luck!",
        `${EMOJI_WISH} Do not change the timer without permissions of others`
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
        "Good luck!",
        `${EMOJI_WISH} Do not change the timer without permissions of others`
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
    const targetEndTime = now + durationMs;
    const targetUnix = Math.floor(targetEndTime / 1000);

    const timerData = {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      sessionNumber: 1,
      phase: "session", // 'session' | 'break'
      sessionMinutes: sessionTime,
      breakMinutes: breakTime,
      targetEndTime: targetEndTime,
      startedBy: interaction.user.tag,
      intervalId: null,
      message: null,
      tickCount: 0
    };

    // Embed matching screenshot exactly:
    // Line 1: <:emoji_30:1522204006221480006> **New study session started**
    // Line 2: Focus timer: **50 minutes work** – **10 minutes break**
    // Line 3: ➔ **[WORK] Next break will be** <t:1789382944:R>
    // Line 4: Good luck! | Session 1
    // Line 5: <:stn_bforyou:1544939254671478794> Do not change the timer without permissions of others
    const initialEmbed = buildTimerEmbed("session", sessionTime, breakTime, targetUnix, 1);

    const replyMsg = await interaction.reply({ embeds: [initialEmbed], fetchReply: true });
    timerData.message = replyMsg;

    // Timer Loop: 1-second interval with live 10-second embed updates
    timerData.intervalId = setInterval(async () => {
      const currentTime = Date.now();
      const remainingMs = timerData.targetEndTime - currentTime;

      // 1. Transition when current phase ends
      if (remainingMs <= 0) {
        if (timerData.phase === "session") {
          // Work session finished -> Break begins
          timerData.phase = "break";
          timerData.targetEndTime = Date.now() + (timerData.breakMinutes * 60 * 1000);
          timerData.tickCount = 0;
          const nextTargetUnix = Math.floor(timerData.targetEndTime / 1000);

          const breakEmbed = buildTimerEmbed("break", timerData.sessionMinutes, timerData.breakMinutes, nextTargetUnix, timerData.sessionNumber);

          try {
            const sentBreakMsg = await voiceChannel.send({ embeds: [breakEmbed] });
            timerData.message = sentBreakMsg; // Live updates continue on the new break message
          } catch (e) {
            console.error("Failed to send break announcement:", e);
          }
        } else if (timerData.phase === "break") {
          // Break finished -> Next session begins
          timerData.sessionNumber += 1;
          timerData.phase = "session";
          timerData.targetEndTime = Date.now() + (timerData.sessionMinutes * 60 * 1000);
          timerData.tickCount = 0;
          const nextTargetUnix = Math.floor(timerData.targetEndTime / 1000);

          const workEmbed = buildTimerEmbed("session", timerData.sessionMinutes, timerData.breakMinutes, nextTargetUnix, timerData.sessionNumber);

          try {
            const sentWorkMsg = await voiceChannel.send({ embeds: [workEmbed] });
            timerData.message = sentWorkMsg; // Live updates continue on the new work message
          } catch (e) {
            console.error("Failed to send work announcement:", e);
          }
        }
        return;
      }

      // 2. Auto-Update every 10 seconds (refreshes message without Discord rate limit)
      timerData.tickCount = (timerData.tickCount || 0) + 1;
      if (timerData.tickCount >= 10 && timerData.message) {
        timerData.tickCount = 0;
        try {
          const currentTargetUnix = Math.floor(timerData.targetEndTime / 1000);
          const liveEmbed = buildTimerEmbed(
            timerData.phase,
            timerData.sessionMinutes,
            timerData.breakMinutes,
            currentTargetUnix,
            timerData.sessionNumber
          );
          await timerData.message.edit({ embeds: [liveEmbed] });
        } catch (err) {
          // Ignore if message was deleted
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
          "",
          `➔ **[STOP] Timer stopped for this channel after ${sessionsCount} ${sessionsCount === 1 ? "session" : "sessions"}**`,
          `Good work! | Session ${sessionsCount}`,
          `${EMOJI_WISH} Do not change the timer without permissions of others`
        ].join("\n"));

      await interaction.reply({ embeds: [stopEmbed] });
    } else {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${EMOJI_INFO} **Timer information**`,
          "No active timer running in this voice channel.",
          "",
          "➔ **Use /start to begin a study session!**",
          "Good luck!",
          `${EMOJI_WISH} Do not change the timer without permissions of others`
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
          "",
          "➔ **Use /start to begin a study session!**",
          "Good luck!",
          `${EMOJI_WISH} Do not change the timer without permissions of others`
        ].join("\n"));
      return interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }

    const isWork = timer.phase === "session";
    const phaseTitle = isWork ? "Timer information: Work!" : "Timer information: Break!";
    const targetUnix = Math.floor(timer.targetEndTime / 1000);
    const targetLine = isWork
      ? `➔ **[WORK] Next break will be** <t:${targetUnix}:R>`
      : `➔ **[BREAK] Next session will be** <t:${targetUnix}:R>`;
    const subLine = isWork
      ? `Good luck! | Session ${timer.sessionNumber || 1}`
      : `Take a break! | Session ${timer.sessionNumber || 1}`;

    const timeEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        `${EMOJI_INFO} **${phaseTitle}**`,
        `Focus timer: **${timer.sessionMinutes} minutes work** – **${timer.breakMinutes} minutes break**`,
        "",
        targetLine,
        subLine,
        `${EMOJI_WISH} Do not change the timer without permissions of others`
      ].join("\n"));

    await interaction.reply({ embeds: [timeEmbed] });
  }
});

client.login(TOKEN);
