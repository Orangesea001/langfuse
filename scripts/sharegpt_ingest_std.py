"""按 vLLM 官方 benchmark_serving 标准口径重建 ShareGPT 压测数据集。

严格对齐 vllm/benchmarks/benchmark_serving.py 的 sample_sharegpt_requests：
    1. 只取每段对话的前两轮（human 提问 + gpt 参考回复），单轮请求
    2. 固定 seed（vLLM 默认 0）shuffle 后顺序取满
    3. 长度过滤：prompt_len >= 4 且 <= 1024，output_len >= 4，prompt+output <= 2048
    4. num_prompts 默认 1000（vLLM DEFAULT_NUM_PROMPTS）
    5. 每条 item 的 metadata 记录参考回复 token 数，压测时作为该条的 max_tokens
       （vLLM 语义：max_tokens = 参考回复长度，模型可提前 EOS 停）

token 计数用被测模型自身 tokenizer（llama-server /tokenize），与 vLLM 用
transformers tokenizer 计数的语义一致。

用法：
    python3 sharegpt_ingest_std.py                # 建 1000 条标准数据集
    python3 sharegpt_ingest_std.py --num 500      # 自定义条数
"""

import argparse
import json
import os
import random
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from langfuse import Langfuse

# ---------------- 与 vLLM 对齐的常量 ----------------
DEFAULT_NUM_PROMPTS = 1000          # vLLM DEFAULT_NUM_PROMPTS
VLLM_DEFAULT_SEED = 0               # vLLM BenchmarkDataset.DEFAULT_SEED
MIN_LEN = 4                         # prompt/output 最短 token 数
MAX_PROMPT_LEN = 1024               # prompt 最长 token 数
MAX_TOTAL_LEN = 2048                # prompt+output 最长 token 数

DATA_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "benchmarks", "sharegpt", "ShareGPT_V3_unfiltered_cleaned_split.json",
)
DATASET_NAME = "ShareGPT压测-标准-vLLM口径"

LLM_BASE = os.environ.get("LLM_BASE_URL", "http://10.164.125.74:8088")


def tokenize_len(text: str) -> int:
    """用被测模型的 tokenizer 精确计数（对齐 vLLM 的 len(tokenizer(text).input_ids)）。"""
    req = urllib.request.Request(
        f"{LLM_BASE}/tokenize",
        data=json.dumps({"content": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return len(json.load(resp)["tokens"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--num", type=int, default=DEFAULT_NUM_PROMPTS,
                    help=f"抽样条数（vLLM 默认 {DEFAULT_NUM_PROMPTS}）")
    ap.add_argument("--seed", type=int, default=VLLM_DEFAULT_SEED,
                    help=f"随机种子（vLLM 默认 {VLLM_DEFAULT_SEED}）")
    args = ap.parse_args()

    print("加载 ShareGPT V3 全量数据...")
    with open(DATA_PATH) as f:
        dataset = json.load(f)

    # 1. 过滤少于 2 轮的对话，只取前两轮（human, gpt）—— vLLM 原样逻辑
    dataset = [d for d in dataset if len(d["conversations"]) >= 2]
    dataset = [(d["conversations"][0]["value"], d["conversations"][1]["value"])
               for d in dataset]

    # 2. 固定 seed shuffle —— vLLM 原样逻辑
    random.seed(args.seed)
    random.shuffle(dataset)
    print(f"候选对话 {len(dataset)} 段，开始按 vLLM 过滤规则计数（前 {args.num} 条）...")

    # 3+4. 逐条 tokenize 并按 vLLM 规则过滤，顺序取满 num 条
    filtered = []
    with ThreadPoolExecutor(8) as pool:
        # 分批处理，命中 num 条即停，避免全量 18 万次 tokenize
        BATCH = 256
        for i in range(0, len(dataset), BATCH):
            if len(filtered) >= args.num:
                break
            batch = dataset[i:i + BATCH]
            lens = list(pool.map(
                lambda p: (tokenize_len(p[0]), tokenize_len(p[1])), batch))
            for (prompt, completion), (prompt_len, output_len) in zip(batch, lens):
                if prompt_len < MIN_LEN or output_len < MIN_LEN:
                    continue  # 剪太短
                if prompt_len > MAX_PROMPT_LEN or prompt_len + output_len > MAX_TOTAL_LEN:
                    continue  # 剪太长
                filtered.append((prompt, completion, prompt_len, output_len))
                if len(filtered) >= args.num:
                    break
            print(f"  已扫描 {min(i + BATCH, len(dataset))} 段，命中 {len(filtered)} 条")

    print(f"最终样本 {len(filtered)} 条")

    # 5. 写入 Langfuse（数据集不存在则创建；SDK 在 events_only 下无条目删除接口，
    #    换口径重建时用新数据集名）
    import base64
    creds = json.load(open(os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "benchmarks", "ttft-api-key.json")))

    def _exists(name: str) -> bool:
        auth = base64.b64encode(
            f"{creds['publicKey']}:{creds['secretKey']}".encode()).decode()
        url = ("http://localhost:3000/api/public/datasets/"
               + urllib.parse.quote(name, safe=""))
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
        try:
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=60)
            return True
        except Exception:
            return False

    lf = Langfuse(
        public_key=creds["publicKey"],
        secret_key=creds["secretKey"],
        host=os.environ.get("LANGFUSE_HOST", "http://localhost:3000"),
        timeout=120,
    )
    if not _exists(DATASET_NAME):
        lf.create_dataset(
            name=DATASET_NAME,
            description=f"vLLM benchmark_serving 标准口径 ShareGPT 压测集（seed={args.seed}, n={args.num}）",
        )
    for prompt, completion, p_len, o_len in filtered:
        lf.create_dataset_item(
            dataset_name=DATASET_NAME,
            input=[{"role": "user", "content": prompt}],
            expected_output=completion,
            metadata={"source": "ShareGPT_V3", "prompt_tokens": p_len,
                      "output_tokens": o_len, "method": "vLLM-benchmark_serving"},
        )
    lf.flush()
    print(f"数据集「{DATASET_NAME}」写入完成：{len(filtered)} 条")


def _exists(lf, name) -> bool:
    try:
        lf.get_dataset(name)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    main()
