const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'shop',
  description: 'View the shop',
  async execute({ message, interaction }) {
    const discordUser = message ? message.author : interaction.user;
    const embed = new EmbedBuilder()
      .setColor('#f4e66c')
      .setTitle('Shop')
      .setImage('https://files.catbox.moe/py98kw.png')

    if (message) return message.channel.send({ embeds: [embed] });
    return interaction.reply({ embeds: [embed] });
  }
};
