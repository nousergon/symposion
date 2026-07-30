#!/usr/bin/env python3
"""
Spike: does `claude -p` support live mid-conversation permission-request
resume over a persistent process (stdin/stdout stream-json), or does a
pending permission request require killing and relaunching the process?

Empirical only - prints every raw event line so we can inspect the actual
schema instead of guessing from docs.
"""
import json
import subprocess
import sys
import threading
import time
import uuid

LOG_PATH = "spike_events.jsonl"
SESSION_ID = str(uuid.uuid4())

CMD = [
    "claude", "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--permission-mode", "manual",
    "--include-partial-messages",
    "--verbose",
    "--session-id", SESSION_ID,
]

# Guess #1 at the stream-json input shape (mirrors Claude Agent SDK
# streaming-input convention). If this is wrong, claude will very likely
# emit a validation error on stdout/stderr that reveals the correct shape.
FIRST_MESSAGE = {
    "type": "user",
    "message": {
        "role": "user",
        "content": "Delete the file /tmp/symposion_spike_target.txt using the Bash tool.",
    },
}

def reader(proc, log_f, stop_event, pending_permission):
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        log_f.write(line + "\n")
        log_f.flush()
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            print(f"[RAW/non-json] {line}")
            continue
        etype = evt.get("type")
        subtype = evt.get("subtype")
        print(f"[EVENT] type={etype} subtype={subtype}")
        low = line.lower()
        if "permission" in low or "tool_confirmation" in low or "requires_action" in low:
            print("  ^^^ possible permission-request event, full payload:")
            print("  " + json.dumps(evt, indent=2).replace("\n", "\n  "))
            pending_permission["event"] = evt
        if etype in ("result", "error") or evt.get("stop_reason"):
            print(f"[TERMINAL-ish EVENT] {json.dumps(evt)[:300]}")
    stop_event.set()

def main():
    print(f"session_id={SESSION_ID}")
    print("spawning:", " ".join(CMD))
    proc = subprocess.Popen(
        CMD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    stop_event = threading.Event()
    pending_permission = {}
    t = threading.Thread(target=reader, args=(proc, open(LOG_PATH, "w"), stop_event, pending_permission), daemon=True)
    t.start()

    first_line = json.dumps(FIRST_MESSAGE)
    print(f"[SEND] {first_line}")
    proc.stdin.write(first_line + "\n")
    proc.stdin.flush()

    # Wait up to 45s for a permission-request event to show up.
    waited = 0
    while waited < 45 and not pending_permission and not stop_event.is_set():
        time.sleep(1)
        waited += 1

    if pending_permission:
        print("\n--- Got a pending permission-like event. Attempting a response guess. ---")
        # Guess #1 at the response shape.
        resp = {
            "type": "tool_permission_result",
            "result": "allow",
        }
        line = json.dumps(resp)
        print(f"[SEND] {line}")
        try:
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
        except BrokenPipeError:
            print("[SEND FAILED] stdin already closed - process likely exited while waiting.")
    else:
        print("\n--- No permission-like event observed within 45s. ---")

    # Give it a bit more time to react either way, then wrap up.
    waited2 = 0
    while waited2 < 20 and not stop_event.is_set():
        time.sleep(1)
        waited2 += 1

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    print(f"\nexit_code={proc.returncode}")
    print(f"full raw event log: {LOG_PATH}")

if __name__ == "__main__":
    main()
