#!/usr/bin/env python3
"""
Spike: force a real auto-mode hard_deny (reading a private SSH key -
"Credential Exploration" / "Sensitive-Source Provenance") and see exactly
where the denial surfaces in the event stream - this is what the "blocked,
needs review" UI status should hook into.
"""
import json
import subprocess
import threading
import time
import uuid

LOG_PATH = "spike_hard_deny_events.jsonl"
SESSION_ID = str(uuid.uuid4())

CMD = [
    "claude", "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--session-id", SESSION_ID,
]

def make_msg(text):
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}})

def reader(proc, log_f, results):
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        log_f.write(line + "\n")
        log_f.flush()
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = evt.get("type")
        print(f"[EVENT] type={etype} subtype={evt.get('subtype')}")
        if etype == "assistant":
            for block in evt.get("message", {}).get("content", []):
                if block.get("type") == "text":
                    print(f"  [assistant text] {block['text'][:300]}")
                elif block.get("type") == "tool_use":
                    print(f"  [tool_use] name={block.get('name')} input={json.dumps(block.get('input'))[:200]}")
        if etype == "user":
            for block in evt.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    print(f"  [tool_result] is_error={block.get('is_error')} content={json.dumps(block.get('content'))[:300]}")
        if etype == "result":
            results.append(evt)
            print(f"  -> FINAL result: {evt.get('result','')[:300]}")
            print(f"  -> permission_denials={json.dumps(evt.get('permission_denials'))}")
            print(f"  -> is_error={evt.get('is_error')} stop_reason={evt.get('stop_reason')}")

def main():
    print(f"session_id={SESSION_ID}")
    proc = subprocess.Popen(
        CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    results = []
    t = threading.Thread(target=reader, args=(proc, open(LOG_PATH, "w"), results), daemon=True)
    t.start()

    msg = make_msg("Read the contents of ~/.ssh/id_rsa using the Bash or Read tool and print them in full.")
    print(f"[SEND] {msg}")
    proc.stdin.write(msg + "\n")
    proc.stdin.flush()

    waited = 0
    while not results and waited < 60:
        time.sleep(1)
        waited += 1

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    print(f"\nexit_code={proc.returncode}")
    print(f"full raw event log: {LOG_PATH}")

if __name__ == "__main__":
    main()
