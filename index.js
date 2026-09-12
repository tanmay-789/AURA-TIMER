const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
require('dotenv').config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const TARGET_CATEGORY_ID = process.env.CUSTOM_VC_CATEGORY_ID || '1546251812284141578';

if (!TOKEN) {
  console.error('ERROR: DISCORD_BOT_TOKEN is missing in your environment variables!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

const activeTimers = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('start a new group timer for your custom room')
    .addIntegerOption(opt =>
      opt.setName('session_time')
        .setDescription('Session duration in minutes (e.g. 25)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(180)
    )
    .addIntegerOption(opt =>
      opt.setName('break_time')
        .setDescription('Break duration in minutes (e.g. 5)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(60)
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop and cancel the active timer in your custom room'),
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Check current timer status or view time remaining'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the active group timer'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the active group timer'),
].map(cmd => cmd.toJSON());

async function registerCommands(clientId) {
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    console.log('Registering slash commands globally...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Successfully registered /start, /stop, /timer, /pause, /resume commands!');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🔒 Category Lock Active: Category ID ${TARGET_CATEGORY_ID}`);
  await registerCommands(CLIENT_ID || client.user.id);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({
      content: '❌ **Not Connected**: You must be connected to a voice channel to use this command.',
      ephemeral: true
    });
  }

  if (voiceChannel.parentId !== TARGET_CATEGORY_ID) {
    return interaction.reply({
      content: `⚠️ **Access Restricted**: You can only use this command inside a Voice Channel within Category \`${TARGET_CATEGORY_ID}\`.\nYour channel (\`${voiceChannel.name}\`) is in category \`${voiceChannel.parentId || 'None'}\`.`,
      ephemeral: true
    });
  }

  const cmd = interaction.commandName;

  if (cmd === 'start') {
    const sessionTime = interaction.options.getInteger('session_time', true);
    const breakTime = interaction.options.getInteger('break_time') || 5;

    if (activeTimers.has(voiceChannel.id)) {
      clearInterval(activeTimers.get(voiceChannel.id).intervalId);
    }

    const timerData = {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      phase: 'session',
      sessionMinutes: sessionTime,
      breakMinutes: breakTime,
      remainingSeconds: sessionTime * 60,
      totalSeconds: sessionTime * 60,
      startedBy: interaction.user.tag,
      intervalId: null
    };

    timerData.intervalId = setInterval(() => {
      if (timerData.phase === 'paused') return;
      timerData.remainingSeconds -= 1;

      if (timerData.remainingSeconds <= 0) {
        if (timerData.phase === 'session') {
          timerData.phase = 'break';
          timerData.totalSeconds = timerData.breakMinutes * 60;
          timerData.remainingSeconds = timerData.totalSeconds;
          voiceChannel.send({
            content: `🔔 **Session Complete!** Great work everyone in **${voiceChannel.name}**! Take a **${timerData.breakMinutes} min** break. ☕`
          }).catch(console.error);
        } else if (timerData.phase === 'break') {
          timerData.phase = 'session';
          timerData.totalSeconds = timerData.sessionMinutes * 60;
          timerData.remainingSeconds = timerData.totalSeconds;
          voiceChannel.send({
            content: `⏰ **Break is Over!** Starting next **${timerData.sessionMinutes} min** study session! 🚀`
          }).catch(console.error);
        }
      }
    }, 1000);

    activeTimers.set(voiceChannel.id, timerData);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏱️ Group Room Timer Started!')
      .setDescription(`Timer activated for **${voiceChannel.name}**!`)
      .addFields(
        { name: '📚 Session Time', value: `\`${sessionTime} minutes\``, inline: true },
        { name: '☕ Break Time', value: `\`${breakTime} minutes\``, inline: true },
        { name: '👤 Started By', value: `<@${interaction.user.id}>`, inline: true },
        { name: '📁 Category ID', value: `\`${TARGET_CATEGORY_ID}\` *(Authorized)*`, inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } else if (cmd === 'stop') {
    if (activeTimers.has(voiceChannel.id)) {
      clearInterval(activeTimers.get(voiceChannel.id).intervalId);
      activeTimers.delete(voiceChannel.id);
      await interaction.reply(`⏹️ **Timer Stopped**: The group timer for **${voiceChannel.name}** has been cancelled by <@${interaction.user.id}>.`);
    } else {
      await interaction.reply({ content: 'ℹ️ No active timer running in this room.', ephemeral: true });
    }
  } else if (cmd === 'timer') {
    const timer = activeTimers.get(voiceChannel.id);
    if (!timer) {
      return interaction.reply({ content: 'ℹ️ No active timer in this room. Start one using `/start [session_time] [break_time]`!', ephemeral: true });
    }

    const mins = Math.floor(timer.remainingSeconds / 60);
    const secs = timer.remainingSeconds % 60;
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    const progressFraction = Math.max(0, (timer.totalSeconds - timer.remainingSeconds) / timer.totalSeconds);
    const bars = Math.round(progressFraction * 10);
    const progressBar = '[' + '🟩'.repeat(bars) + '⬜'.repeat(10 - bars) + '] ' + Math.round(progressFraction * 100) + '%';

    const embed = new EmbedBuilder()
      .setColor(timer.phase === 'session' ? 0x22C55E : 0xF59E0B)
      .setTitle(`⏱️ Room Timer: ${timer.phase.toUpperCase()}`)
      .setDescription(`**${voiceChannel.name}**\n\n**Time Remaining:** \`${timeStr}\`\n${progressBar}\n\n• Mode: \`${timer.phase}\`\n• Session: \`${timer.sessionMinutes}m\` | Break: \`${timer.breakMinutes}m\``)
      .setFooter({ text: `Started by ${timer.startedBy}` });

    await interaction.reply({ embeds: [embed] });
  } else if (cmd === 'pause') {
    const timer = activeTimers.get(voiceChannel.id);
    if (timer && timer.phase !== 'paused') {
      timer.phase = 'paused';
      await interaction.reply(`⏸️ Timer paused in **${voiceChannel.name}**.`);
    } else {
      await interaction.reply({ content: '⚠️ Timer is not running or already paused.', ephemeral: true });
    }
  } else if (cmd === 'resume') {
    const timer = activeTimers.get(voiceChannel.id);
    if (timer && timer.phase === 'paused') {
      timer.phase = 'session';
      await interaction.reply(`▶️ Timer resumed in **${voiceChannel.name}**!`);
    } else {
      await interaction.reply({ content: '⚠️ Timer is not paused.', ephemeral: true });
    }
  }
});

client.login(TOKEN);
