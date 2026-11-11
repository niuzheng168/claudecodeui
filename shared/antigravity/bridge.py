#!/usr/bin/env python3
"""Codey's private NDJSON transport for the official Google Antigravity SDK.

The parent supplies one run on stdin, then permission replies or cancellation.
Credentials never occur in argv or output. The SDK, not Codey, executes tools
and persists the resumable native conversation.
"""

import asyncio
import contextlib
import getpass
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import threading
import uuid

OUTPUT = sys.stdout
MAX_INPUT = 16 * 1024 * 1024


def emit(event, **fields):
    OUTPUT.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
    OUTPUT.flush()


def config_path():
    return Path(os.environ.get(
        "CODEY_ANTIGRAVITY_CONFIG",
        str(Path.home() / ".config" / "codey" / "antigravity.json"),
    ))


def configure():
    """Interactive terminal-only credential entry; never echo or log the key."""
    if not sys.stdin.isatty():
        raise ValueError("Run codey antigravity login in an interactive terminal.")
    target = config_path()
    existing = json.loads(target.read_text()) if target.exists() else {}
    key = getpass.getpass("Gemini API key (input hidden): ").strip()
    if not key:
        raise ValueError("No API key entered; existing configuration was not changed.")
    existing.update({"apiKey": key, "vertex": False})
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(existing, stream)
            stream.write("\n")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    print("Gemini API credentials saved. Codey will use them on the next turn.")


async def run(request):
    from google.antigravity import Agent, LocalAgentConfig, hooks, types

    pending = {}
    loop = asyncio.get_running_loop()
    agent = None
    cancelled = False
    finished = False
    cwd = Path(request["cwd"]).resolve(strict=True)
    mode = request.get("permissionMode", "default")
    if mode not in ("default", "acceptEdits", "bypassPermissions", "plan"):
        raise ValueError("Unsupported Antigravity permission mode.")
    state = Path(request["stateDir"])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)

    async def cancel():
        nonlocal cancelled
        if finished:
            return
        cancelled = True
        for future in list(pending.values()):
            if not future.done():
                future.set_result({"allow": False, "message": "Run cancelled."})
        if agent is not None and agent.is_started:
            await agent.conversation.cancel()

    def receive(value):
        if value.get("event") == "cancel":
            asyncio.create_task(cancel())
        elif value.get("event") == "decision":
            future = pending.get(value.get("requestId"))
            if future is not None and not future.done():
                future.set_result(value)

    def read_input():
        try:
            while line := sys.stdin.readline(MAX_INPUT + 1):
                if len(line) > MAX_INPUT:
                    raise ValueError("Antigravity bridge input is too large.")
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError("Expected an object.")
                loop.call_soon_threadsafe(receive, value)
        except (ValueError, OSError):
            pass
        finally:
            # A vanished parent must not leave the agent running unattended.
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(lambda: asyncio.create_task(cancel()))

    async def ask(tool_name, value, question=False):
        if cancelled:
            return {"allow": False}
        request_id = str(uuid.uuid4())
        future = loop.create_future()
        pending[request_id] = future
        emit("permission", requestId=request_id, toolName=tool_name,
             input=value, question=question)
        try:
            return await future
        finally:
            pending.pop(request_id, None)

    read_tools = {"view_file", "list_directory", "search_directory", "find_file",
                  "search_web", "read_url_content", "finish", "ask_question",
                  "list_skills", "lookup_skill", "lookup_skills", "get_skill_resources"}
    edit_tools = {"create_file", "edit_file"}

    @hooks.pre_tool_call_decide
    async def permission(tool: types.ToolCall):
        name = str(tool.name)
        # Canonical paths have already been decoded/normalized by the SDK.
        inside = not tool.canonical_path or Path(tool.canonical_path).resolve().is_relative_to(cwd)
        if mode == "plan" and (name not in read_tools or not inside or tool.server_name):
            return types.HookResult(allow=False, message="Plan mode permits only workspace reads.")
        if cancelled:
            return types.HookResult(allow=False, message="Run cancelled.")
        if mode == "bypassPermissions" or (
            inside and not tool.server_name
            and (name in read_tools or (mode == "acceptEdits" and name in edit_tools))
        ):
            return types.HookResult(allow=True)
        answer = await ask(name, tool.args)
        return types.HookResult(
            allow=answer.get("allow") is True,
            message=str(answer.get("message") or ""),
            modified_args=answer.get("updatedInput") if isinstance(answer.get("updatedInput"), dict) else None,
        )

    @hooks.post_tool_call
    async def tool_result(result: types.ToolResult):
        emit("tool_result", result=result.model_dump(mode="json"))

    @hooks.on_interaction
    async def question(spec: types.AskQuestionInteractionSpec):
        answer = await ask("AskUserQuestion", spec.model_dump(mode="json"), question=True)
        if not answer.get("allow"):
            return types.QuestionHookResult(responses=[], cancelled=True)
        updated = answer.get("updatedInput") or {}
        answers = updated.get("answers", {}) if isinstance(updated, dict) else {}
        responses = []
        for entry in spec.questions:
            selected = answers.get(entry.question, "")
            labels = selected if isinstance(selected, list) else [str(selected)]
            ids = [option.id for option in entry.options if option.text in labels or option.id in labels]
            freeform = ", ".join(label for label in labels if not any(
                option.text == label or option.id == label for option in entry.options))
            responses.append(types.QuestionResponse(selected_option_ids=ids, freeform_response=freeform))
        return types.QuestionHookResult(responses=responses)

    credentials = request.get("credentials", {})
    options = types.GeminiModelOptions(
        thinking_level=request.get("effort") or None,
    )
    if credentials.get("vertex"):
        endpoint = types.VertexEndpoint(
            project=credentials.get("project"), location=credentials.get("location"),
            options=options,
        )
    else:
        endpoint = types.GeminiAPIEndpoint(
            api_key=credentials.get("apiKey") or None,
            base_url=credentials.get("baseUrl") or None,
            options=options,
        )
    enabled = [tool for tool in types.BuiltinTools.default()
               if tool != types.BuiltinTools.SCHEDULE]
    enabled.append(types.BuiltinTools.ASK_QUESTION)
    if mode == "plan":
        enabled = [tool for tool in enabled if str(tool) in read_tools]
    mcp_servers = []
    for server in request.get("mcpServers", []):
        common = {"name": server["name"]}
        if server.get("transport") == "stdio":
            mcp_servers.append(types.McpStdioServer(
                **common, command=server["command"], args=server.get("args") or [],
                env=server.get("env") or {}, cwd=server.get("cwd"),
            ))
        else:
            mcp_servers.append(types.McpStreamableHttpServer(
                **common, url=server["url"], headers=server.get("headers") or {},
            ))
    config = LocalAgentConfig(
        models=[
            types.ModelTarget(name=request["model"], endpoint=endpoint),
            types.ModelTarget(name="gemini-3.1-flash-lite-image",
                              types=[types.ModelType.IMAGE], endpoint=endpoint),
        ],
        conversation_id=request["conversationId"],
        session_continuation_mode=(
            types.SessionContinuationMode.RESUME if request.get("resume")
            else types.SessionContinuationMode.CREATE_ONLY
        ),
        save_dir=str(state / "trajectories"), app_data_dir=str(state / "app"),
        workspaces=[str(cwd)],
        capabilities=types.CapabilitiesConfig(
            agent_behavior=types.AgentBehavior.INTERACTIVE,
            enabled_tools=enabled,
        ),
        # All decisions, including MCP calls, pass through the UI-aware hook.
        policies=[], hooks=[permission, tool_result, question],
        mcp_servers=mcp_servers,
        skills_paths=request.get("skillsPaths") or [],
        system_instructions=request.get("instructions") or None,
    )
    threading.Thread(target=read_input, daemon=True).start()
    async with Agent(config) as running:
        agent = running
        if cancelled:
            return
        # The SDK populates conversation_id lazily when the first step arrives.
        # LocalAgentConfig has already accepted our explicit conversation ID.
        emit("ready", conversationId=agent.conversation_id or request["conversationId"])
        prompt = [request["prompt"]]
        for attachment in request.get("attachments", []):
            prompt.append(types.from_file(attachment))
        await agent.conversation.send(prompt)
        async for step in agent.conversation.receive_steps():
            if not step.parent_trajectory_id and step.trajectory_id != request["conversationId"]:
                raise ValueError("The SDK returned an unexpected conversation ID.")
            emit("step", step=step.model_dump(mode="json"))
        finished = True
        emit("result", cancelled=cancelled,
             usage=agent.conversation.total_usage.model_dump(mode="json"))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "configure":
        configure()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--version":
        # Import as well as read metadata: missing dependencies are not installed.
        import google.antigravity  # noqa: F401
        print(importlib.metadata.version("google-antigravity"))
        return
    request = json.loads(sys.stdin.readline(MAX_INPUT + 1))
    # SDK/library diagnostic prints may never corrupt the NDJSON transport.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            asyncio.run(run(request))
        except asyncio.CancelledError:
            emit("result", cancelled=True)
        except Exception as error:
            message = str(error)
            secret = request.get("credentials", {}).get("apiKey")
            if secret:
                message = message.replace(secret, "[redacted]")
            emit("error", message=message)
            raise SystemExit(1) from None


if __name__ == "__main__":
    os.umask(0o077)
    main()
