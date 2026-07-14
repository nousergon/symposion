#!/usr/bin/env python3
"""
Spike: does a single long-running `claude -p --input-format stream-json
--output-format stream-json` process accept a SECOND user message after
the first turn's `result` event, without needing --resume or a fresh
process? And does the second turn read from cache rather than rebuilding it?
"""
import json
import subprocess
import threading
import time
import uuid

LOG_PATH = "spike_multiturn_events.jsonl"
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
        if etype == "result":
            results.append(evt)
            print(f"  -> turn result: \"{evt.get('result','')[:120]}\"")
            print(f"  -> cache_read_input_tokens={evt['usage'].get('cache_read_input_tokens')} "
                  f"cache_creation_input_tokens={evt['usage'].get('cache_creation_input_tokens')} "
                  f"total_cost_usd={evt.get('total_cost_usd')}")

def wait_for_nth_result(results, n, timeout=60):
    waited = 0
    while len(results) < n and waited < timeout:
        time.sleep(1)
        waited += 1
    return len(results) >= n

def main():
    print(f"session_id={SESSION_ID}")
    proc = subprocess.Popen(
        CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    results = []
    t = threading.Thread(target=reader, args=(proc, open(LOG_PATH, "w"), results), daemon=True)
    t.start()

    msg1 = make_msg("Reply with exactly one word: first")
    print(f"[SEND #1] {msg1}")
    proc.stdin.write(msg1 + "\n")
    proc.stdin.flush()

    if not wait_for_nth_result(results, 1):
        print("!! Did not get a first result within timeout")
        proc.terminate()
        return

    print("\n--- Turn 1 done. Sending second message on the SAME live process/stdin. ---\n")

    msg2 = make_msg("Reply with exactly one word: second. Then in a new sentence, state the exact word I asked you to reply with last time.")
    print(f"[SEND #2] {msg2}")
    try:
        proc.stdin.write(msg2 + "\n")
        proc.stdin.flush()
    except BrokenPipeError:
        print("!! stdin already closed after turn 1 - process did NOT stay alive for a second turn.")
        proc.wait(timeout=5)
        print(f"exit_code={proc.returncode}")
        return

    if not wait_for_nth_result(results, 2):
        print("!! Did not get a second result within timeout")

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    print(f"\nexit_code={proc.returncode}")
    print(f"turns completed: {len(results)}")
    if len(results) >= 2:
        r1, r2 = results[0], results[1]
        print(f"turn1 cache_read={r1['usage'].get('cache_read_input_tokens')} cache_creation={r1['usage'].get('cache_creation_input_tokens')}")
        print(f"turn2 cache_read={r2['usage'].get('cache_read_input_tokens')} cache_creation={r2['usage'].get('cache_creation_input_tokens')}")
        print(f"turn2 result text: {r2.get('result')}")
    print(f"full raw event log: {LOG_PATH}")

if __name__ == "__main__":
    main()
