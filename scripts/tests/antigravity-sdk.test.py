"""Contract tests against the installed, real SDK and its native harness.

Only the remote Gemini model API is replaced with a loopback fixture. These
tests exercise SDK serialization, native tool execution, approvals, and actual
on-disk conversation resume, rather than a mocked Agent.

Run: <sdk-venv>/bin/python scripts/tests/antigravity-sdk.test.py
"""

import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid

BRIDGE = Path(__file__).resolve().parents[2] / "shared" / "antigravity" / "bridge.py"


class FixtureApi(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.server.requests.append((self.path, request))
        parts = self.server.parts.pop(0) if self.server.parts else [{"text": "SDK contract response"}]
        payload = {
            "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 17, "candidatesTokenCount": 4, "totalTokenCount": 21},
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())


class SdkContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codey-google-sdk-test-")
        self.root = Path(self.temp.name)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureApi)
        self.server.requests = []
        self.server.parts = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.conversation_id = str(uuid.uuid4())

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_bridge(self, prompt, *, resume=False, mode="default", allow=None,
                   model="gemini-4-carbon", cancel_on_permission=False):
        request = {
            "cwd": str(self.root), "stateDir": str(self.root / "state"),
            "conversationId": self.conversation_id, "resume": resume,
            "model": model, "effort": "medium", "prompt": prompt,
            "permissionMode": mode,
            "credentials": {"apiKey": "fixture-key",
                            "baseUrl": f"http://127.0.0.1:{self.server.server_port}"},
        }
        env = {**os.environ, "GOOGLE_GENAI_USE_VERTEXAI": "false", "GOOGLE_GENAI_USE_ENTERPRISE": "false"}
        with (self.root / "stderr.log").open("w") as stderr:
            proc = subprocess.Popen([sys.executable, str(BRIDGE)], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=stderr, text=True, env=env)
            timer = threading.Timer(30, proc.kill)
            timer.start()
            events = []
            try:
                proc.stdin.write(json.dumps(request) + "\n")
                proc.stdin.flush()
                for line in proc.stdout:
                    event = json.loads(line)
                    events.append(event)
                    if event["event"] == "permission":
                        if cancel_on_permission:
                            proc.stdin.write('{"event":"cancel"}\n')
                            proc.stdin.flush()
                            continue
                        self.assertIsNotNone(allow, "Unexpected interactive permission")
                        proc.stdin.write(json.dumps({
                            "event": "decision", "requestId": event["requestId"], "allow": allow,
                        }) + "\n")
                        proc.stdin.flush()
                    if event["event"] in ("result", "error"):
                        proc.stdin.close()
                code = proc.wait(timeout=5)
                self.assertEqual(code, 0, events)
                self.assertFalse(any(event["event"] == "error" for event in events), events)
                self.assertEqual(sum(event["event"] == "result" for event in events), 1, events)
                return events
            finally:
                timer.cancel()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                if not proc.stdin.closed:
                    proc.stdin.close()
                proc.stdout.close()

    def test_selected_model_effort_streaming_and_native_resume(self):
        first = self.run_bridge("Remember the word river.")
        self.assertEqual(first[0], {"event": "ready", "conversationId": self.conversation_id})
        url, request = self.server.requests[0]
        self.assertIn("/gemini-4-carbon:streamGenerateContent", url)
        self.assertEqual(request["generationConfig"]["thinkingConfig"]["thinkingLevel"].lower(), "medium")
        self.assertTrue(any(event.get("step", {}).get("content_delta") == "SDK contract response" for event in first))
        second = self.run_bridge("What word did I ask you to remember?", resume=True, model="gemini-4-argon")
        self.assertIn("/gemini-4-argon:streamGenerateContent", self.server.requests[-1][0])
        serialized = json.dumps(self.server.requests[-1][1]["contents"])
        self.assertIn("Remember the word river.", serialized)
        self.assertIn("SDK contract response", serialized)
        self.assertEqual(second[0]["conversationId"], self.conversation_id)
        self.assertGreater(second[-1]["usage"]["total_token_count"], first[-1]["usage"]["total_token_count"])

    def configure_write(self, target):
        self.server.parts = [[{"functionCall": {
            "name": "write_to_file",
            "args": {"TargetFile": str(target), "CodeContent": "real SDK write\n",
                     "Overwrite": False, "Description": "Test permitted SDK execution",
                     "toolAction": "Writing fixture"},
        }}], [{"text": "Done."}]]

    def test_real_sdk_tool_is_not_executed_when_user_denies(self):
        target = self.root / "denied.txt"
        self.configure_write(target)
        events = self.run_bridge("Create denied.txt", allow=False)
        self.assertTrue(any(event["event"] == "permission" for event in events))
        self.assertFalse(target.exists())

    def test_real_sdk_tool_executes_after_user_approval(self):
        target = self.root / "approved.txt"
        self.configure_write(target)
        events = self.run_bridge("Create approved.txt", allow=True)
        self.assertTrue(any(event["event"] == "permission" for event in events))
        self.assertEqual(target.read_text(), "real SDK write\n")
        self.assertTrue(any(event["event"] == "tool_result" for event in events))

    def test_plan_mode_does_not_expose_mutating_tools(self):
        self.run_bridge("Inspect only", mode="plan")
        tools = self.server.requests[0][1].get("tools", [])
        names = {function["name"] for tool in tools for function in tool.get("functionDeclarations", [])}
        self.assertNotIn("write_to_file", names)
        self.assertNotIn("run_command", names)
        self.assertNotIn("replace_file_content", names)

    def test_real_sdk_cancellation_withdraws_pending_approval_without_writing(self):
        target = self.root / "cancelled.txt"
        self.configure_write(target)
        events = self.run_bridge("Create cancelled.txt", cancel_on_permission=True)
        self.assertTrue(events[-1].get("cancelled"))
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
