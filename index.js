// Discord Voice Channel Timer Bot (ST!Timer style)
// Works in ANY Voice Channel across your Discord server - no category restriction!
// Commands: /start, /stop, /timer (no /pause or /resume)

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
  ]
});

// Active timers: channelId => timer object
const activeTimers = new Map();

// Signature ST!Timer color: #F04747
const ST_COLOR = 0xF04747;

// ONLY 3 slash commands: /start, /stop, /timer (/pause & /resume removed)
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

    // 2. Register directly to all guilds so commands update INSTANTLY with zero cache delay!
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
  await registerCommands(CLIENT_ID || client.user.id);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  // If user runs removed commands, show ST!Timer styled embed
  if (cmd === "pause" || cmd === "resume") {
    const removedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "⚠️ **Command Removed**",
        "The `/" + cmd + "` command has been removed.",
        "➔ **Please use /start, /stop, or /timer**",
        ":stn_bforyou: Good luck!",
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
    const notConnectedEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        "❌ **Not Connected**",
        "You must be connected to a voice channel to use this command.",
        "➔ **Join any voice channel in the server, then run /start**",
        ":stn_bforyou: Good luck!",
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
      intervalId: null
    };

    timerData.intervalId = setInterval(() => {
      timerData.remainingSeconds -= 1;

      if (timerData.remainingSeconds <= 0) {
        if (timerData.phase === "session") {
          // Session finished -> Break begins
          timerData.phase = "break";
          timerData.remainingSeconds = timerData.breakMinutes * 60;
          timerData.totalSeconds = timerData.remainingSeconds;

          const breakEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              "☕ **Break time started**",
              "Focus timer: **" + timerData.sessionMinutes + " minutes work** – **" + timerData.breakMinutes + " minutes break**",
              "➔ **[BREAK] Next session will be in " + timerData.breakMinutes + " minutes**",
              "Take a break! | Session " + timerData.sessionNumber,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          voiceChannel.send({ embeds: [breakEmbed] }).catch(console.error);
        } else if (timerData.phase === "break") {
          // Break finished -> Next session begins
          timerData.sessionNumber += 1;
          timerData.phase = "session";
          timerData.remainingSeconds = timerData.sessionMinutes * 60;
          timerData.totalSeconds = timerData.remainingSeconds;

          const workEmbed = new EmbedBuilder()
            .setColor(ST_COLOR)
            .setDescription([
              ":emoji_30: **New study session started**",
              "Focus timer: **" + timerData.sessionMinutes + " minutes work** – **" + timerData.breakMinutes + " minutes break**",
              "➔ **[WORK] Next break will be in " + timerData.sessionMinutes + " minutes**",
              ":stn_bforyou: Good luck! | Session " + timerData.sessionNumber,
              "Do not change the timer without permissions of others"
            ].join("\n"));

          voiceChannel.send({ embeds: [workEmbed] }).catch(console.error);
        }
      }
    }, 1000);

    activeTimers.set(voiceChannel.id, timerData);

    // Embed matching ST!Timer format
    const embed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        ":emoji_30: **New study session started**",
        "Focus timer: **" + sessionTime + " minutes work** – **" + breakTime + " minutes break**",
        "➔ **[WORK] Next break will be in " + sessionTime + " minutes**",
        ":stn_bforyou: Good luck! | Session 1",
        "Do not change the timer without permissions of others"
      ].join("\n"));

    await interaction.reply({ embeds: [embed] });
  } else if (cmd === "stop") {
    const timer = activeTimers.get(voiceChannel.id);
    if (timer) {
      clearInterval(timer.intervalId);
      const sessionsCount = timer.sessionNumber || 1;
      activeTimers.delete(voiceChannel.id);

      const stopEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          ":st92_water: **Study session stopped**",
          "Focus timer: **" + timer.sessionMinutes + " minutes work** – **" + timer.breakMinutes + " minutes break**",
          "➔ **[STOP] Timer stopped for this channel after " + sessionsCount + " " + (sessionsCount === 1 ? "session" : "sessions") + "**",
          "Good work! | Session " + sessionsCount,
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [stopEmbed] });
    } else {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          ":emoji_31: **Timer information**",
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          ":stn_bforyou: Good luck!",
          "Do not change the timer without permissions of others"
        ].join("\n"));

      await interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }
  } else if (cmd === "timer" || cmd === "time") {
    const timer = activeTimers.get(voiceChannel.id);
    if (!timer) {
      const noTimerEmbed = new EmbedBuilder()
        .setColor(ST_COLOR)
        .setDescription([
          ":emoji_31: **Timer information**",
          "No active timer running in this voice channel.",
          "➔ **Use /start to begin a study session!**",
          ":stn_bforyou: Good luck!",
          "Do not change the timer without permissions of others"
        ].join("\n"));
      return interaction.reply({ embeds: [noTimerEmbed], ephemeral: true });
    }

    const mins = Math.max(1, Math.ceil(timer.remainingSeconds / 60));
    const isWork = timer.phase === "session";
    const phaseTitle = isWork ? "Timer information: Work!" : "Timer information: Break!";
    const nextTarget = isWork
      ? "➔ **[WORK] Next break will be in " + mins + " " + (mins === 1 ? "minute" : "minutes") + "**"
      : "➔ **[BREAK] Next session will be in " + mins + " " + (mins === 1 ? "minute" : "minutes") + "**";
    const wishText = isWork
      ? ":stn_bforyou: Good luck! | Session " + (timer.sessionNumber || 1)
      : "Take a break! | Session " + (timer.sessionNumber || 1);

    const timeEmbed = new EmbedBuilder()
      .setColor(ST_COLOR)
      .setDescription([
        ":emoji_31: **" + phaseTitle + "**",
        "Focus timer: **" + timer.sessionMinutes + " minutes work** – **" + timer.breakMinutes + " minutes break**",
        nextTarget,
        wishText,
        "Do not change the timer without permissions of others"
      ].join("\n"));

    await interaction.reply({ embeds: [timeEmbed] });
  }
});

client.login(TOKEN);
