import asyncio
import hmac
import json
import os
import secrets
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import aiohttp
from aiohttp import web
import discord


def _loopback(value):
    url = urlparse(value)
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1") or not url.port or url.username or url.password or url.query or url.fragment:
        raise ValueError("Callback URLs must use an HTTP loopback port")
    return value


def _payload(content=None, **kwargs):
    unsupported = set(kwargs) - {"embed", "embeds", "view", "ephemeral", "allowed_mentions", "silent", "suppress_embeds", "tts"}
    if unsupported:
        raise NotImplementedError("Unsupported synthetic response options: " + ", ".join(sorted(unsupported)))
    result = {}
    if content is not None:
        result["content"] = str(content)
    if "embed" in kwargs:
        result["embeds"] = [kwargs["embed"].to_dict()] if kwargs["embed"] else []
    if "embeds" in kwargs:
        result["embeds"] = [embed.to_dict() for embed in kwargs["embeds"]]
    if "view" in kwargs:
        result["components"] = kwargs["view"].to_components() if kwargs["view"] else []
    view = kwargs.get("view")
    components_v2 = view is not None and getattr(view, "has_components_v2", lambda: False)()
    flags = (32768 if components_v2 else 0) | (64 if kwargs.get("ephemeral") else 0) | (4096 if kwargs.get("silent") else 0) | (4 if kwargs.get("suppress_embeds") else 0)
    if flags:
        result["flags"] = flags
    if "tts" in kwargs:
        result["tts"] = kwargs["tts"]
    return result


class TestbenchInteraction(discord.Interaction):
    def __init__(self, *, data, state, callback, session):
        super().__init__(data=data, state=state)
        self._test_callback = callback
        self._test_session = session
        self._test_response = TestbenchResponse(self)
        self._test_followup = TestbenchFollowup(self)
        self.extras["testbench"] = True

    @property
    def response(self):
        return self._test_response

    @property
    def followup(self):
        return self._test_followup

    async def _call(self, method, *args):
        callback = self._test_callback
        async with self._test_session.post(_loopback(callback["url"]), headers={"Authorization": "Bearer " + callback["token"]}, json={"method": method, "args": args}, allow_redirects=False) as response:
            result = await response.json()
            if response.status != 200:
                raise RuntimeError(result.get("error", "Testbench callback failed"))
            value = result.get("result")
            if isinstance(value, dict) and value.get("message"):
                return discord.Message(state=self._state, channel=self.channel, data=value["message"])
            return value

    def _store_view(self, view, message):
        if view is not None:
            self._state.store_view(view, message.id if message else None)

    async def original_response(self):
        return await self._call("fetchReply")

    async def edit_original_response(self, *, content=None, **kwargs):
        message = await self._call("editReply", _payload(content, **kwargs))
        self._store_view(kwargs.get("view"), message)
        return message

    async def delete_original_response(self):
        await self._call("deleteReply")


class TestbenchResponse:
    def __init__(self, parent):
        self.parent = parent
        self.type = None

    def is_done(self):
        return self.type is not None

    async def _ack(self, method, response_type, *args):
        if self.is_done():
            raise discord.InteractionResponded(self.parent)
        result = await self.parent._call(method, *args)
        self.type = response_type
        return result

    async def send_message(self, content=None, **kwargs):
        payload = _payload(content, **kwargs)
        payload["fetchReply"] = True
        message = await self._ack("reply", discord.InteractionResponseType.channel_message, payload)
        self.parent._store_view(kwargs.get("view"), message)
        return SimpleNamespace(resource=message, message_id=message.id, type=self.type)

    async def defer(self, *, ephemeral=False, thinking=False):
        update = self.parent.type in (discord.InteractionType.component, discord.InteractionType.modal_submit) and not thinking
        method = "deferUpdate" if update else "deferReply"
        kind = discord.InteractionResponseType.deferred_message_update if update else discord.InteractionResponseType.deferred_channel_message
        await self._ack(method, kind, *([] if update else [{"flags": 64 if ephemeral else 0}]))
        return SimpleNamespace(resource=None, type=self.type)

    async def edit_message(self, *, content=None, **kwargs):
        await self._ack("update", discord.InteractionResponseType.message_update, _payload(content, **kwargs))
        self.parent._store_view(kwargs.get("view"), self.parent.message)

    async def send_modal(self, modal):
        await self._ack("showModal", discord.InteractionResponseType.modal, modal.to_dict())
        self.parent._state.store_view(modal)

    async def autocomplete(self, choices):
        await self._ack("respond", discord.InteractionResponseType.autocomplete_result, [choice.to_dict() for choice in choices])


class TestbenchFollowup:
    def __init__(self, parent):
        self.parent = parent

    async def send(self, content=None, *, wait=True, **kwargs):
        message = await self.parent._call("followUp", _payload(content, **kwargs))
        self.parent._store_view(kwargs.get("view"), message)
        return message if wait else None

    async def edit_message(self, message_id, *, content=None, **kwargs):
        if str(message_id) != "@original":
            raise NotImplementedError("Only original-reply webhook edits are supported")
        return await self.parent.edit_original_response(content=content, **kwargs)

    async def delete_message(self, message_id):
        if str(message_id) != "@original":
            raise NotImplementedError("Only original-reply webhook deletion is supported")
        await self.parent.delete_original_response()


async def _dispatch(bot, interaction):
    if interaction.type in (discord.InteractionType.application_command, discord.InteractionType.autocomplete):
        tree = getattr(bot, "tree", None) or bot._connection._command_tree
        if tree is None:
            raise RuntimeError("The client has no application command tree")
        await tree._call(interaction)
        if interaction.command_failed:
            raise RuntimeError("The command tree reported a failed command or check")
        return
    store = bot._connection._view_store
    data = interaction.data
    if interaction.type == discord.InteractionType.component:
        key = (data["component_type"], data["custom_id"])
        item = store._views.get(interaction.message.id, {}).get(key) or store._views.get(None, {}).get(key)
        if item is None or item.view is None:
            raise RuntimeError("No registered view callback matches the component. Dynamic items require a custom dispatcher.")
        item._refresh_state(interaction, data)
        if not await item._run_checks(interaction) or not await item.view.interaction_check(interaction):
            raise RuntimeError("View interaction check rejected the test identity")
        await item.callback(interaction)
        return
    if interaction.type == discord.InteractionType.modal_submit:
        modal = store._modals.get(data["custom_id"])
        if modal is None:
            raise RuntimeError("No captured or registered modal matches this custom ID")
        resolved = discord.app_commands.Namespace._get_resolved_items(interaction, data.get("resolved", {}))
        modal._refresh(interaction, data.get("components", []), resolved)
        if not await modal.interaction_check(interaction):
            raise RuntimeError("Modal interaction check rejected the test identity")
        await modal.on_submit(interaction)
        modal.stop()
        return
    raise NotImplementedError("Unsupported interaction type")


class TestbenchHandle:
    def __init__(self, runner, descriptor, token, process=None):
        self.runner = runner
        self.descriptor = descriptor
        self.token = token
        self.process = process

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        await self.runner.cleanup()
        if self.descriptor.exists() and json.loads(self.descriptor.read_text())["token"] == self.token:
            self.descriptor.unlink()


async def start_testbench(bot, *, root=".", launch_bridge=True, dispatch=None):
    if not bot.is_ready():
        raise RuntimeError("Start Testbench after the Discord client is ready")
    root = Path(root).resolve()
    config = json.loads((root / "testbench.config.json").read_text(encoding="utf-8"))
    directory = root / ".testbench"
    directory.mkdir(exist_ok=True, mode=0o700)
    descriptor = directory / "adapter.json"
    if descriptor.exists():
        raise RuntimeError("An adapter descriptor already exists. Stop that adapter or remove its stale descriptor after checking its process.")
    token = secrets.token_hex(32)
    lock = asyncio.Lock()

    async def handle(request):
        if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + token):
            return web.json_response({"error": "Unauthorized"}, status=401)
        if request.headers.get("Origin"):
            return web.json_response({"error": "Browser-origin requests are not accepted"}, status=403)
        if lock.locked():
            return web.json_response({"error": "An adapter interaction is still running"}, status=409)
        async with lock:
            try:
                body = await request.json()
                if body.get("version") != 1:
                    raise ValueError("Unsupported adapter protocol version")
                data = body["interaction"]
                if data.get("guild_id") != config["guildId"] or data["member"]["user"]["id"] not in config["userIds"]:
                    raise ValueError("Interaction is outside the configured test guild or identities")
                _loopback(body["callback"]["url"])
                if len(body["callback"]["token"]) < 32:
                    raise ValueError("Invalid callback secret")
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=config.get("timeoutMs", 15000) / 1000)) as session:
                    interaction = TestbenchInteraction(data=data, state=bot._connection, callback=body["callback"], session=session)
                    await (dispatch or (lambda value: _dispatch(bot, value)))(interaction)
                return web.json_response({"handled": True, "errors": []})
            except Exception as error:
                message = str(error)
                bot_token = getattr(bot.http, "token", None)
                if bot_token:
                    message = message.replace(bot_token, "[REDACTED]")
                return web.json_response({"handled": True, "errors": [message]})

    app = web.Application(client_max_size=1048576)
    app.router.add_post("/interactions", handle)
    runner = web.AppRunner(app, shutdown_timeout=5)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        with descriptor.open("x", encoding="utf-8") as file:
            json.dump({"version": 1, "pid": os.getpid(), "url": f"http://127.0.0.1:{port}/interactions", "token": token}, file)
        os.chmod(descriptor, 0o600)
        process = None
        if launch_bridge:
            runtime = json.loads((directory / "runtime.json").read_text(encoding="utf-8"))
            environment = dict(os.environ)
            environment["DISCORD_BOT_TOKEN"] = bot.http.token
            process = await asyncio.create_subprocess_exec(runtime["node"], runtime["cli"], "bridge", "--root", str(root), env=environment)
        return TestbenchHandle(runner, descriptor, token, process)
    except BaseException:
        await runner.cleanup()
        if descriptor.exists() and json.loads(descriptor.read_text())["token"] == token:
            descriptor.unlink()
        raise
