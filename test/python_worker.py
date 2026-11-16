import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters" / "python"))

import discord
from discord.ext import commands
from discord_testbench import start_testbench


async def main():
    root = Path(sys.argv[1])
    config = json.loads((root / "testbench.config.json").read_text())
    guild_id = config["guildId"]
    channel_id = config["channelIds"][0]
    user_id = config["userIds"][0]
    bot_id = "100000000000000004"
    bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
    async with bot:
        bot._connection.user = discord.ClientUser(state=bot._connection, data={"id": bot_id, "username": "test-bot", "discriminator": "0000", "avatar": None, "bot": True})
        bot._connection._add_guild_from_data({
            "id": guild_id, "name": "Test guild", "owner_id": user_id,
            "roles": [{"id": guild_id, "name": "@everyone", "permissions": "8", "position": 0, "color": 0, "hoist": False, "managed": False, "mentionable": False}],
            "channels": [{"id": channel_id, "name": "tests", "type": 0, "position": 0, "permission_overwrites": []}],
            "members": [], "emojis": [], "stickers": [], "features": []
        })
        bot._ready.set()

        class SubjectModal(discord.ui.Modal, title="Ticket"):
            subject = discord.ui.TextInput(label="Subject", custom_id="subject")

            async def on_submit(self, interaction):
                await interaction.response.defer(thinking=True)
                await interaction.edit_original_response(content=f"Ticket: {self.subject.value}")

        class Controls(discord.ui.View):
            @discord.ui.button(label="Open", custom_id="ticket:open")
            async def open(self, interaction, button):
                await interaction.response.send_modal(SubjectModal(custom_id="ticket:submit"))

            @discord.ui.select(custom_id="color", options=[discord.SelectOption(label="Blue", value="blue")])
            async def color(self, interaction, select):
                await interaction.response.edit_message(content=f"Selected: {select.values[0]}")

        @bot.tree.command(name="ping")
        async def ping(interaction: discord.Interaction, text: str = "Python pong"):
            await interaction.response.send_message(text, view=Controls())

        @bot.tree.command(name="private")
        async def private(interaction: discord.Interaction):
            await interaction.response.send_message("Python private", ephemeral=True)

        handle = await start_testbench(bot, root=root, launch_bridge=False)
        print("READY", flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await handle.close()


asyncio.run(main())
