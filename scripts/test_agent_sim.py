"""测试agent模拟：走完 Langfuse 测评管理的完整闭环。

模拟的agent：一个"知识问答测试agent"，系统提示词托管在 Langfuse Prompt Management，
每次运行时从平台拉取指定版本，调用 DeepSeek-V4-Flash 生成回答。

本脚本覆盖三件事：
1. Prompt Management：创建 test-agent-system v1（基础版）和 v2（改进版）
2. 数据集：创建「测试agent-回归集」（5条问答，含超纲题）
3. 实验：对 v1、v2 各跑一次数据集实验，每条 trace 打「回复正确性」分

用法：
    python3 test_agent_sim.py setup    # 建提示词 + 数据集
    python3 test_agent_sim.py exp 1    # 跑 v1 实验
    python3 test_agent_sim.py exp 2    # 跑 v2 实验
    python3 test_agent_sim.py all      # 依次执行以上全部
"""

import json
import os
import sys
import urllib.request

from langfuse import Langfuse, get_client

BASE = os.environ.get("LANGFUSE_HOST", "http://localhost:3000")
API_URL = "http://10.164.125.74:8088/v1/chat/completions"
MODEL = "DeepSeek-V4-Flash"
DATASET_NAME = "测试agent-回归集"
PROMPT_NAME = "test-agent-system"

PROMPT_V1 = """你是知识问答助手，回答用户的问题。
"""

PROMPT_V2 = """你是知识问答助手。请遵守：
1. 只依据你知道的事实回答，不确定或不知道时，明确说"不知道"，禁止编造。
2. 回答简洁，先给结论再给理由。
"""

# 数据集：问题 + 期望回答要点（用关键词判断正确性）
ITEMS = [
    {"question": "美团公司是在哪一年成立的？",
     "expected": "2010", "keywords": ["2010"]},
    {"question": "美团的主要业务包括哪些？",
     "expected": "外卖、到店、酒旅等本地生活服务",
     "keywords": ["外卖", "酒旅", "到店"]},
    {"question": "外卖订单的配送费一般由谁承担？",
     "expected": "视活动而定，可能由用户支付或商家/平台补贴",
     "keywords": ["用户", "商家", "补贴", "活动"]},
    {"question": "北京明天的天气怎么样？",
     "expected": "agent 不知道实时天气，应明确说明无法回答",
     "keywords": []},  # 超纲题：正确答案就是承认不知道
    {"question": "美团的股票代码是什么？",
     "expected": "3690（港交所）",
     "keywords": ["3690"]},
]


def load_client() -> Langfuse:
    key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "benchmarks", "ttft-api-key.json")
    with open(key_file) as f:
        creds = json.load(f)
    return Langfuse(public_key=creds["publicKey"], secret_key=creds["secretKey"],
                    host=BASE, timeout=60)


def basic_auth():
    key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "benchmarks", "ttft-api-key.json")
    with open(key_file) as f:
        creds = json.load(f)
    import base64
    token = base64.b64encode(
        f'{creds["publicKey"]}:{creds["secretKey"]}'.encode()).decode()
    return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}


def create_prompt(version: int, text: str, labels=None):
    """POST /api/public/prompts：同名重复创建会自动 +1 版本，这里直接指定调用版本即可。"""
    body = {"name": PROMPT_NAME, "prompt": text,
            "labels": labels or (["production"] if version == 1 else []),
            "isActive": True}
    req = urllib.request.Request(f"{BASE}/api/public/prompts",
                                 data=json.dumps(body).encode(),
                                 headers=basic_auth(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read())
    print(f"  提示词 {PROMPT_NAME} 创建成功：version={out.get('version')} "
          f"labels={out.get('labels')}")
    return out


def setup_prompts():
    print("== 1. 创建测试agent系统提示词 v1 / v2 ==")
    # 查一下是否已存在（避免重复建版本）
    try:
        req = urllib.request.Request(
            f"{BASE}/api/public/prompts/{PROMPT_NAME}", headers=basic_auth())
        urllib.request.urlopen(req, timeout=15)
        exists = True  # 能查到最新版 = 该名字下已有提示词
    except Exception:
        exists = False
    if exists:
        print(f"  提示词 {PROMPT_NAME} 已存在，跳过创建")
        return
    create_prompt(1, PROMPT_V1, labels=["production"])
    create_prompt(2, PROMPT_V2)


def setup_dataset(lf: Langfuse):
    print(f"== 2. 创建数据集「{DATASET_NAME}」==")
    try:
        ds = lf.get_dataset(DATASET_NAME)
        print(f"  已存在（{len(ds.items)} 条），跳过创建")
        return
    except Exception:
        pass
    lf.create_dataset(name=DATASET_NAME,
                      description="测试agent的回归评测集：知识问答+超纲题")
    for it in ITEMS:
        lf.create_dataset_item(
            dataset_name=DATASET_NAME,
            input=it["question"],
            expected_output=it["expected"],
            metadata={"keywords": it["keywords"]},
        )
    print(f"  创建完成：{len(ITEMS)} 条")


def ask_llm(question: str, system_prompt: str) -> str:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ],
        "max_tokens": 512,
        "chat_template_kwargs": {"thinking": False},
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def score_correctness(answer: str, keywords: list) -> float:
    """简单自动评分：关键词命中比例；超纲题（无关键词）要求回答含'不知道/无法'。"""
    if not keywords:
        return 1.0 if any(w in answer for w in ["不知道", "无法", "查不到", "没有相关"]) else 0.0
    hits = sum(1 for k in keywords if k in answer)
    return round(hits / len(keywords), 3)


def run_experiment(lf: Langfuse, version: int):
    prompt_obj = lf.get_prompt(PROMPT_NAME, version=version)
    system_prompt = prompt_obj.compile() if hasattr(prompt_obj, "compile") else prompt_obj.prompt
    print(f"== 3. 实验：{PROMPT_NAME} v{version} ==")

    dataset = lf.get_dataset(DATASET_NAME)

    def task(*, item, **kwargs):
        q = item.input if isinstance(item.input, str) else item.input.get("question", "")
        answer = ask_llm(q, system_prompt)
        meta = item.metadata or {}
        s = score_correctness(answer, meta.get("keywords", []))
        get_client().score_current_trace(name="回复正确性", value=s,
                                         data_type="NUMERIC",
                                         comment=f"期望: {item.expected_output}")
        return answer

    exp_name = f"test-agent-v{version}-回归"
    result = lf.run_experiment(
        name=exp_name, run_name=exp_name,
        data=dataset.items, task=task, max_concurrency=3,
        metadata={"prompt_version": version, "model": MODEL},
    )
    ok = sum(1 for r in result.item_results if r.output is not None)
    scores = [r.scores.get("回复正确性") for r in result.item_results
              if getattr(r, "scores", None) and r.scores.get("回复正确性") is not None]
    avg = round(sum(s["value"] for s in scores) / len(scores), 3) if scores else None
    print(f"  完成：成功 {ok}/{len(dataset.items)}，回复正确性均分={avg}")
    print(f"  实验链接: {result.dataset_run_url or '(见数据集 Experiments 页)'}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    lf = load_client()
    if cmd in ("setup", "all"):
        setup_prompts()
        setup_dataset(lf)
    if cmd in ("exp", "all"):
        version = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        run_experiment(lf, version)
    lf.flush()


if __name__ == "__main__":
    main()
