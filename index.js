// Discord Voice Channel Timer Bot (ST!Timer style)
// Works in ANY Voice Channel across your Discord server - no category restriction!
// Commands: /start, /stop, /timer (no /pause or /resume)
// Features: Auto-updating running time every 10 seconds, custom emoji resolution (<:name:id>)

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
require("dotenv").config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN) {
  console.error("ERROR: DISCORD_BOT_TOKEN is missing in your environment variables!");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildExpressions || GatewayIntentBits.GuildEmojisAndStickers,
  ]
});

// Active timers: channelId => timer object
const activeTimers = new Map();

// Signature ST!Timer color: #F04747
const ST_COLOR = 0xF04747;

// Format seconds into human readable running time
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

// Resolve custom Discord server emojis (<:name:id> or <a:name:id>)
async function resolveEmoji(discordClient, guild, name, fallback = "") {
  if (!name) return fallback;
  // If already full custom emoji format <:name:id> or <a:name:id>
  if (/^<a?:\w+:\d+>$/.test(name)) return name;

  const clean = name.replace(/^:|:$/g, "").toLowerCase();

  // 1. Check optional environment variable ID (e.g. EMOJI_30_ID="123456789")
  const envId = process.env[clean.toUpperCase() + "_ID"] || process.env[clean.toUpperCase()];
  if (envId && /^\d+$/.test(envId.trim())) {
    return `<:${clean}:${envId.trim()}>`;
  }

  // 2. Search guild emojis
  let emoji = guild?.emojis?.cache?.find(e => e.name.toLowerCase() === clean);
  if (!emoji && guild?.emojis?.fetch) {
    try {
      const fetched = await guild.emojis.fetch();
      emoji = fetched.find(e => e.name.toLowerCase() === clean);
    } catch (e) {
      // ignore
    }
  }

  // 3. Search client-wide emoji cache across all servers
  if (!emoji && discordClient?.emojis?.cache) {
    emoji = discordClient.emojis.cache.find(e => e.name.toLowerCase() === clean);
  }

  // 4. Search partial match
  if (!emoji && discordClient?.emojis?.cache) {
    emoji = discordClient.emojis.cache.find(e => e.name.toLowerCase().includes(clean));
  }

  if (emoji) {
    return emoji.toString(); // Outputs <:emoji_30:123456789012345678>
  }

  // 5. Fallback icon so ugly plain text ":emoji_30:" is never shown
  return fallback || `:${clean}:`;
}

// ONLY 3 slash commands: /start, /stop, /timer
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

async function registerCommands(clientId) {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    console.log("Registering clean slash commands (/start, /stop, /timer)...");

    // 1. Register global commands
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Successfully registered global slash commands: /start, /stop, /timer");

    // 2. Register directly to all guilds so commands update INSTANTLY with zero cache delay
    try {
      const guilds = await client.guilds.fetch();
      for (const [guildId, oAuth2Guild] of guilds) {
        const guild = await oAuth2Guild.fetch();
        await guild.commands.set(commands);
      }
      console.log(`Instant guild sync: Updated slash commands in ${guilds.size} server(s) with zero cache delay!`);
    } catch (e) {
      console.log("Guild sync info:", e.message);
    }
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
}

client.once("ready", async () => {
  console.log("✅ Logged in as " + client.user.tag);
  console.log("🌐 Universal Voice Mode: Bot works in ALL voice channels!");
  console.log("⏱️ Auto-Update: Embeds will update running time every 10 seconds!");
  await registerCommands(CLIENT_ID || client.user.id);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // If user runs removed commands, show ST!Timer styled embed
  if (cmd === "pause" || cmd === "resume") {
    const goodLuckEmoji = await resolveEmoji(client, interaction.guild, "stn_bforyou", "🌸");
    const removedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "⚠️ **Command Removed**",
        "The `/" + cmd + "` command has been removed.",
        "➔ **Please use /start, /stop, or /timer**",
        `${goodLuckEmoji} Good luck!`,
        "Do not change the timer without permissions of others"
      ].join("\n"));
    return interaction.reply({ embeds: [removedEmbed], ephemeral: true });
  }

  // 1. Resolve member and voice channel
  let member = interaction.member;
  if ((!member || !member.voice || !member.voice.channel) && interaction.guild) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch (e) {
      console.warn("Could not fetch member voice state:", e);
    }
  }

  // Voice channel detection (voice state or voice channel text chat)
  let voiceChannel = member?.voice?.channel;
  if (!voiceChannel && interaction.channel && typeof interaction.channel.isVoiceBased === "function" && interaction.channel.isVoiceBased()) {
    voiceChannel = interaction.channel;
  }

  if (!voiceChannel) {
    const goodLuckEmoji = await resolveEmoji(client, interaction.guild, "stn_bforyou", "🌸");
    const notConnectedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "❌ **Not Connected**",
        "You must be connected to a voice channel to use this command.",
        "➔ **Join any voice channel in the server, then run /start**",
        `${goodLuckEmoji} Good luck!`,
        "Do not change the timer without permissions of others"
      ].join("\n"));
    return interaction.reply({ embeds: [notConnectedEmbed], ephemeral: true });
  }

  if (cmd === "start") {
    const sessionTime = interaction.options.getInteger("session_time", true);
    const breakTime = interaction.options.getInteger("break_time", true);

    // Clear any previous timer in this channel
    if (activeTimers.has(voiceChannel.id)) {
      clearInterval(activeTimers.get(voiceChannel.id).intervalId);
      activeTimers.delete(voiceChannel.id);
    }

    const emoji30 = await resolveEmoji(client, interaction.guild, "emoji_30", "🐹");
    const emojiGoodLuck = await resolveEmoji(client, interaction.guild, "stn_bforyou", "🌸");

    const timerData = {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      sessionNumber: 1,
      phase: "session",
      sessionMinutes: sessionTime,
      breakMinutes: breakTime,
      remainingSeconds: sessionTime * 60,
      totalSeconds: sessionTime * 60,
      startedBy: interaction.user.tag,
      intervalId: null,
      message: null,
      guild: interaction.guild,
      voiceChannel: voiceChannel
    };

    // Embed matching ST!Timer format
    const embed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        `${emoji30} **New study session started**`,
        `Focus timer: **${sessionTime} minutes work** – **${breakTime} minutes break**`,
        `➔ **[WORK] Next break will be in ${formatRemaining(timerData.remainingSeconds)}**`,
        `${emojiGoodLuck} Good luck! | Session 1`,
        "Do not change the timer without permissions of others"
      ].join("\n"));

    await interaction.reply({ embeds: [embed] });

    // Store reply message reference so we can edit it every 10 seconds
    try {
      timerData.message = await interaction.fetchReply();
    } catch (e) {
      console.warn("Could not fetch reply for live edits:", e.message);
    }

    timerData.intervalId = setInterval(async () => {
      timerData.remainingSeconds -= 1;

      // AUTOMATIC LIVE UPDATE EVERY 10 SECONDS
      if (timerData.remainingSeconds > 0 && timerData.remainingSeconds % 10 === 0 && timerData.message) {
        try {
          const isWork = timerData.phase === "session";
          const currentHeaderEmoji = isWork
            ? await resolveEmoji(client, timerData.guild, "emoji_30", "🐹")
            : "☕";
          const currentGoodLuck = await resolveEmoji(client, timerData.guild, "stn_bforyou", "🌸");

          const headerText = isWork
            ? `${currentHeaderEmoji} **New study session started**`
            : "☕ **Break time started**";

          const targetText = isWork
            ? `➔ **[WORK] Next break will be in ${formatRemaining(timerData.remainingSeconds)}**`
            : `➔ **[BREAK] Next session will be in ${formatRemaining(timerData.remainingSeconds)}**`;

          const wishLine = isWork
            ? `${currentGoodLuck} Good luck! | Session ${timerData.sessionNumber}`
            : `Take a break! | Session ${timerData.sessionNumber}`;

          const liveEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              headerText,
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              targetText,
              wishLine,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          await timerData.message.edit({ embeds: [liveEmbed] });
        } catch (err) {
          // If message was deleted or cannot be edited, don't crash the bot
        }
      }

      // Phase transitions
      if (timerData.remainingSeconds <= 0) {
        if (timerData.phase === "session") {
          // Work session finished -> Break begins
          timerData.phase = "break";
          timerData.remainingSeconds = timerData.breakMinutes * 60;
          timerData.totalSeconds = timerData.remainingSeconds;

          const breakEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              "☕ **Break time started**",
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              `➔ **[BREAK] Next session will be in ${formatRemaining(timerData.remainingSeconds)}**`,
              `Take a break! | Session ${timerData.sessionNumber}`,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          try {
            const sentBreakMsg = await voiceChannel.send({ embeds: [breakEmbed] });
            timerData.message = sentBreakMsg; // Edit this break message every 10 seconds
          } catch (e) {
            console.error("Failed to send break message:", e);
          }
        } else if (timerData.phase === "break") {
          // Break finished -> Next session begins
          timerData.sessionNumber += 1;
          timerData.phase = "session";
          timerData.remainingSeconds = timerData.sessionMinutes * 60;
          timerData.totalSeconds = timerData.remainingSeconds;

          const nextEmoji30 = await resolveEmoji(client, timerData.guild, "emoji_30", "🐹");
          const nextGoodLuck = await resolveEmoji(client, timerData.guild, "stn_bforyou", "🌸");

          const workEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              `${nextEmoji30} **New study session started**`,
              `Focus timer: **${timerData.sessionMinutes} minutes work** – **${timerData.breakMinutes} minutes break**`,
              `➔ **[WORK] Next break will be in ${formatRemaining(timerData.remainingSeconds)}**`,
              `${nextGoodLuck} Good luck! | Session ${timerData.sessionNumber}`,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          try {
            const sentWorkMsg = await voiceChannel.send({ embeds: [workEmbed] });
            timerData.message = sentWorkMsg; // Edit this work message every 10 seconds
          } catch (e) {
            console.error("Failed to send work message:", e);
          }
        }
      }
    }, 1000);

    activeTimers.set(voiceChannel.id, timerData);
  } else if (cmd === "stop") {
    const timer = activeTimers.get(voiceChannel.id);
    if (timer) {
      clearInterval(timer.intervalId);
      const sessionsCount = timer.sessionNumber || 1;
      activeTimers.delete(voiceChannel.id);

      const waterEmoji = await resolveEmoji(client, interaction.guild, "st92_water", "💧");

      const stopEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${waterEmoji} **Study session stopped**`,
          `Focus timer: **${timer.sessionMinutes} minutes work** – **${timer.breakMinutes} minutes break**`,
          `➔ **[STOP] Timer stopped for this channel after ${sessionsCount} ${sessionsCount === 1 ? "session" : "sessions"}**`,
          `Good work! | Session ${sessionsCount}`,
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [stopEmbed] });
    } else {
      const infoEmoji = await resolveEmoji(client, interaction.guild, "emoji_31", "ℹ️");
      const goodLuckEmoji = await resolveEmoji(client, interaction.guild, "stn_bforyou", "🌸");

      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${infoEmoji} **Timer information**`,
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          `${goodLuckEmoji} Good luck!`,
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }
  } else if (cmd === "timer" || cmd === "time") {
    const timer = activeTimers.get(voiceChannel.id);
    const infoEmoji = await resolveEmoji(client, interaction.guild, "emoji_31", "ℹ️");
    const goodLuckEmoji = await resolveEmoji(client, interaction.guild, "stn_bforyou", "🌸");

    if (!timer) {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          `${infoEmoji} **Timer information**`,
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          `${goodLuckEmoji} Good luck!`,
          "Do not change the timer without permissions of others"
        ].join("\n"));
      return interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }

    const isWork = timer.phase === "session";
    const phaseTitle = isWork ? "Timer information: Work!" : "Timer information: Break!";
    const targetText = isWork
      ? `➔ **[WORK] Next break will be in ${formatRemaining(timer.remainingSeconds)}**`
      : `➔ **[BREAK] Next session will be in ${formatRemaining(timer.remainingSeconds)}**`;
    const wishText = isWork
      ? `${goodLuckEmoji} Good luck! | Session ${timer.sessionNumber || 1}`
      : `Take a break! | Session ${timer.sessionNumber || 1}`;

    const timeEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        `${infoEmoji} **${phaseTitle}**`,
        `Focus timer: **${timer.sessionMinutes} minutes work** – **${timer.breakMinutes} minutes break**`,
        targetText,
        wishText,
        "Do not change the timer without permissions of others"
      ].join("\n"));

    await interaction.reply({ embeds: [timeEmbed] });
  }
});

client.login(TOKEN);
