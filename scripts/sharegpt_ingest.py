"""把业界标准压测语料 ShareGPT V3 灌进 Langfuse，按输入长度分桶建数据集。

业界口径（vLLM benchmark_serving / SGLang bench_serving 同款做法）：
    语料 ShareGPT_V3_unfiltered_cleaned_split.json（真实用户多轮对话，~9 万条）
    取样方式：每条对话截到最后一个 human 轮 = prompt，其后的 gpt 轮 = expected_output
    分桶依据：用被测 llama-server 的 /tokenize 端点算精确输入 token 数

分桶（对齐 vLLM latency profile 的长度档位）：
    ShareGPT压测-短<1k      ~100 条   覆盖主流短对话
    ShareGPT压测-中1k-4k    ~100 条   中长上下文
    ShareGPT压测-长4k-20k   ~50 条    长上下文（>20k 在 ShareGPT 里极稀少，并入长桶）

用法：
    python3 sharegpt_ingest.py --dry-run          # 只看长度分布，不建数据集
    python3 sharegpt_ingest.py                    # 正式建数据集
"""

import argparse
import json
import os
import random
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from langfuse import Langfuse

SHAREGPT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "benchmarks",
    "sharegpt",
    "ShareGPT_V3_unfiltered_cleaned_split.json",
)
LLM_BASE = os.environ.get("LLM_API_URL", "http://10.164.125.74:8088/v1/chat/completions").rsplit(
    "/v1/", 1
)[0]

SAMPLE_POOL = 6000  # 短/中桶采样池大小
LONG_CHAR_PREFILTER = 12000  # 长桶粗筛：拼接文本超过该字符数才 tokenize（~4k token）
SEED = 42
BUCKETS = [
    ("ShareGPT压测-短<1k", 0, 1000, 100),
    ("ShareGPT压测-中1k-4k", 1000, 4000, 100),
    ("ShareGPT压测-长4k-20k", 4000, 20000, 50),
    ("ShareGPT压测-超长>20k", 20000, 10**9, 10**9),  # 有多少收多少
]
MIN_ITEMS = 3  # 少于 3 条的桶不建数据集
ROLE_MAP = {"human": "user", "gpt": "assistant", "system": "system", "bing": "assistant"}


def load_client() -> Langfuse:
    """与 latency_eval.py 相同的密钥加载逻辑。"""
    default_key_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "benchmarks", "ttft-api-key.json"
    )
    key_file = os.environ.get("LANGFUSE_KEY_FILE", default_key_file)
    creds = {}
    try:
        with open(key_file) as f:
            creds = json.load(f)
    except FileNotFoundError:
        pass
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY") or creds.get("publicKey")
    sk = os.environ.get("LANGFUSE_SECRET_KEY") or creds.get("secretKey")
    if not pk or not sk:
        raise SystemExit("未找到 Langfuse 密钥（环境变量或 ttft-api-key.json）")
    return Langfuse(
        public_key=pk,
        secret_key=sk,
        host=os.environ.get("LANGFUSE_HOST", "http://localhost:3000"),
        timeout=60,
    )


def tokenize_len(text: str) -> int:
    """调 llama-server /tokenize 拿精确 token 数（与被测模型同一分词器）。"""
    req = urllib.request.Request(
        f"{LLM_BASE}/tokenize",
        data=json.dumps({"content": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.loads(resp.read())
        return len(out.get("tokens") or out.get("ids") or [])
    except Exception as e:
        print(f"  tokenize 失败: {e}")
        return 0


def build_sample(conv):
    """一条对话 -> (messages, expected_output, 拼接文本)。截到最后一个 human 轮。"""
    turns = conv.get("conversations") or []
    # 找最后一个 human 轮且其后紧跟 gpt 轮的位置
    cut = None
    for i in range(len(turns) - 2, -1, -1):
        if turns[i].get("from") == "human" and turns[i + 1].get("from") == "gpt":
            cut = i
            break
    if cut is None:
        return None
    msgs = []
    for t in turns[: cut + 1]:
        role = ROLE_MAP.get(t.get("from"))
        value = (t.get("value") or "").strip()
        if role and value:
            msgs.append({"role": role, "content": value})
    expected = (turns[cut + 1].get("value") or "").strip()
    if len(msgs) < 1 or not expected:
        return None
    joined = "\n".join(m["content"] for m in msgs)
    if len(joined) > 200000:  # 超长离群样本丢弃
        return None
    return msgs, expected[:4000], joined


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印长度分布，不写 Langfuse")
    args = ap.parse_args()

    print(f"加载 {SHAREGPT_PATH} ...")
    with open(SHAREGPT_PATH) as f:
        data = json.load(f)
    print(f"共 {len(data)} 条对话，采样池 {SAMPLE_POOL} 条（seed={SEED}）")

    rng = random.Random(SEED)
    pool = rng.sample(data, min(SAMPLE_POOL, len(data)))

    # 长桶候选从全量里字符粗筛（长对话在 ShareGPT 里仅 ~0.2%，采样池里捞不够）
    print("全量扫描长对话候选（字符粗筛）...")
    long_candidates = []
    for conv in data:
        s = build_sample(conv)
        if s and len(s[2]) > LONG_CHAR_PREFILTER:
            long_candidates.append(s)
    print(f"长对话候选 {len(long_candidates)} 条")

    samples = [s for s in (build_sample(c) for c in pool) if s and len(s[2]) <= LONG_CHAR_PREFILTER]
    print(f"短/中采样池有效样本 {len(samples)} 条，开始 tokenize（调 {LLM_BASE}/tokenize）...")

    with ThreadPoolExecutor(max_workers=8) as ex:
        tok_lens = list(
            ex.map(lambda s: tokenize_len(s[2]), samples + long_candidates)
        )
    tok_map = {id(s): n for s, n in zip(samples + long_candidates, tok_lens)}
    samples = samples + long_candidates
    tok_lens = [tok_map[id(s)] for s in samples]

    # 分桶统计 + 选择
    selected = {name: [] for name, *_ in BUCKETS}
    for s, n in zip(samples, tok_lens):
        if n == 0:
            continue
        for name, lo, hi, cap in BUCKETS:
            if lo <= n < hi:
                if len(selected[name]) < cap:
                    selected[name].append((s[0], s[1], n))
                break

    print("\n长度分布（采样池全量）：")
    total = sum(1 for n in tok_lens if n > 0)
    for name, lo, hi, _ in BUCKETS:
        cnt = sum(1 for n in tok_lens if lo <= n < hi)
        print(f"  {name}: {cnt} 条 ({cnt / max(total, 1):.1%})，入选 {len(selected[name])} 条")

    if args.dry_run:
        print("\n[dry-run] 未写入 Langfuse。")
        return

    lf = load_client()
    for name, lo, hi, _ in BUCKETS:
        items = selected[name]
        if len(items) < MIN_ITEMS:
            print(f"\n跳过 {name}（仅 {len(items)} 条 < {MIN_ITEMS}）")
            continue
        desc = (
            f"业界标准压测语料 ShareGPT V3（hf: anon8231489123/ShareGPT_Vicuna_unfiltered），"
            f"输入长度 {lo}-{hi} token（llama-server /tokenize 精确计量），"
            f"input=多轮 messages，expected_output=真实下一轮回复。"
            f"跑延迟实验用 latency_eval.py --dataset {name} --metric-style industry"
        )
        lf.create_dataset(name=name, description=desc)
        for msgs, expected, n in items:
            lf.create_dataset_item(
                dataset_name=name,
                input=msgs,
                expected_output=expected,
                metadata={"source": "ShareGPT_V3", "prompt_tokens": n},
            )
        print(f"\n已建数据集「{name}」：{len(items)} 条")
    lf.flush()
    print("\n完成。")


if __name__ == "__main__":
    main()
