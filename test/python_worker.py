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

        class AdvancedModal(discord.ui.Modal):
            def __init__(self):
                super().__init__(title="Preferences", custom_id="advanced:submit")
                self.consent = discord.ui.Checkbox(custom_id="consent")
                self.priority = discord.ui.RadioGroup(custom_id="priority", options=[discord.RadioGroupOption(label="High", value="high"), discord.RadioGroupOption(label="Low", value="low")])
                self.days = discord.ui.CheckboxGroup(custom_id="days", options=[discord.CheckboxGroupOption(label="Monday", value="monday"), discord.CheckboxGroupOption(label="Friday", value="friday")])
                self.color = discord.ui.Select(custom_id="color", options=[discord.SelectOption(label="Blue", value="blue")])
                self.person = discord.ui.UserSelect(custom_id="person")
                for text, component in [("Consent", self.consent), ("Priority", self.priority), ("Days", self.days), ("Color", self.color), ("Person", self.person)]:
                    self.add_item(discord.ui.Label(text=text, component=component))

            async def on_submit(self, interaction):
                assert self.consent.value is True
                assert self.priority.value == "high"
                assert self.days.values == ["monday", "friday"]
                assert self.color.values == ["blue"]
                assert str(self.person.values[0].id) == user_id
                await interaction.response.send_message("Python modern fields verified")

        class EntityModal(discord.ui.Modal):
            def __init__(self):
                super().__init__(title="Resources", custom_id="entities:submit")
                self.role = discord.ui.RoleSelect(custom_id="role")
                self.channel = discord.ui.ChannelSelect(custom_id="channel")
                self.mentionable = discord.ui.MentionableSelect(custom_id="mentionable", max_values=2)
                for text, component in [("Role", self.role), ("Channel", self.channel), ("Mentionable", self.mentionable)]:
                    self.add_item(discord.ui.Label(text=text, component=component))

            async def on_submit(self, interaction):
                assert str(self.role.values[0].id) == guild_id
                assert str(self.channel.values[0].id) == channel_id
                assert {str(value.id) for value in self.mentionable.values} == {user_id, guild_id}
                await interaction.response.send_message("Python resource fields verified")

        class UploadModal(discord.ui.Modal):
            def __init__(self):
                super().__init__(title="Attachment", custom_id="upload:submit")
                self.files = discord.ui.FileUpload(custom_id="files")
                self.add_item(discord.ui.Label(text="Files", component=self.files))

            async def on_submit(self, interaction):
                assert self.files.values[0].filename == "report.txt"
                await interaction.response.send_message("Python attachment metadata verified")

        class OpenAdvanced(discord.ui.Button):
            def __init__(self):
                super().__init__(label="Preferences", custom_id="advanced:open")

            async def callback(self, interaction):
                await interaction.response.send_modal(AdvancedModal())

        class V2Controls(discord.ui.LayoutView):
            def __init__(self):
                super().__init__()
                self.add_item(discord.ui.Container(discord.ui.TextDisplay("Python v2 controls"), discord.ui.Separator(), discord.ui.ActionRow(OpenAdvanced())))

        @bot.tree.command(name="ping")
        async def ping(interaction: discord.Interaction, text: str = "Python pong"):
            await interaction.response.send_message(text, view=Controls())

        @bot.tree.command(name="private")
        async def private(interaction: discord.Interaction):
            await interaction.response.send_message("Python private", ephemeral=True)

        @bot.tree.command(name="v2")
        async def v2(interaction: discord.Interaction):
            await interaction.response.send_message(view=V2Controls())

        @bot.tree.command(name="entities")
        async def entities(interaction: discord.Interaction):
            await interaction.response.send_modal(EntityModal())

        @bot.tree.command(name="upload")
        async def upload(interaction: discord.Interaction):
            await interaction.response.send_modal(UploadModal())

        handle = await start_testbench(bot, root=root, launch_bridge=False)
        print("READY", flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await handle.close()


asyncio.run(main())
