"""模拟测试agent线上运行：产生 trace，供人工标注与在线评估使用。"""
import json, os, sys, urllib.request
from langfuse import Langfuse, observe

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
MODEL = "DeepSeek-V4-Flash"
API_URL = "http://10.164.125.74:8088/v1/chat/completions"

creds = json.load(open(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "benchmarks", "ttft-api-key.json")))
langfuse = Langfuse(public_key=creds["publicKey"], secret_key=creds["secretKey"],
                    host="http://localhost:3000", timeout=60)

SYSTEM_PROMPT = "你是一个知识问答助手。请遵守：1. 依据事实回答，不确定时明确说\"不知道\"，禁止编造。2. 回答简洁，先给结论再给理由。"

def ask_model(question):
    payload = {"model": MODEL, "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question}],
        "max_tokens": 512}
    req = urllib.request.Request(
        API_URL, json.dumps(payload).encode(),
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]

def simulate_online_traces(questions):
    print(f"模拟测试agent线上运行 {len(questions)} 次，产生 {len(questions)} 条 trace")
    for i, q in enumerate(questions):
        @observe(name="test-agent-online", capture_input=True, capture_output=True)
        def run_agent(question):
            return ask_model(question)

        answer = run_agent(q)
        print(f"  [{i+1}] Q: {q}")
        print(f"      A: {answer[:60]}...")
    langfuse.flush()

if __name__ == "__main__":
    questions = [
        "美团是在哪一年成立的？",
        "美团的使命是什么？",
        "今天上海的天气怎么样？",
    ]
    simulate_online_traces(questions)
