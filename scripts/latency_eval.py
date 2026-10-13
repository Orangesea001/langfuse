"""用 Langfuse 原生实验功能测评 DeepSeek-V4-Flash 的延迟。

跑一次 = 平台上多一个实验（在数据集的 Experiments 页可看）。
每条测试项 = 一条 trace，自动打上 6 个指标分数：
    首响延迟(秒) / 预填充吞吐tok/s / 思考耗时(秒) / 思考token数 / 解码速度tok/s / 总耗时(秒)
总耗时会同时出现在实验表自带的 Latency 列；其余在条目详情的
Scores 里，也可以在 Scores 页和 Analytics 里看趋势。

两个题库：
    --dataset 模型评测-测试1     短上下文选择题（151条）：测裸解码速度、首响
    --dataset Agent长上下文-20k   长上下文+短输出（50条，~20k输入/300字输出）：测 agent 真实口径，
                                   看 KV cache 变大后的解码衰减与预填充吞吐

ShareGPT 压测题库（业界标准语料，由 sharegpt_ingest.py 建）：
    --dataset ShareGPT压测-短<1k / 中1k-4k / 长4k-20k / 超长>20k
    input 是多轮 messages 列表，自动按对话直传；配合 --metric-style industry
    打业界统一口径指标：TTFT(s) / TPOT(ms) / E2E(s) / Decode 吞吐 / Prefill 吞吐

用法：
    python3 latency_eval.py --limit 5        # 只跑前 5 条，快速验证（推荐先用这个）
    python3 latency_eval.py                  # 跑完整数据集
    python3 latency_eval.py --thinking off   # 关闭思考模式跑一轮，和默认(开)对比
    python3 latency_eval.py --name Q4-UD-Q4_K_XL-开思考-151题   # 自定义实验名

实验名默认为 "DeepSeek-V4-Flash-thinking-on/off"，跑完直接出现在
Langfuse 数据集的 Experiments 页，不带 SDK 追加的时间戳后缀。
"""

import argparse
import json
import os
import time
import urllib.request

from langfuse import Langfuse, get_client

# ---------------- 配置 ----------------
# 用 LLM_API_URL 环境变量可以指向别的实例（如测试实例 http://10.164.125.74:8089/v1/chat/completions）
API_URL = os.environ.get(
    "LLM_API_URL", "http://10.164.125.74:8088/v1/chat/completions"
)
MODEL = os.environ.get("LLM_MODEL", "DeepSeek-V4-Flash")  # 可用环境变量切换被测模型（如 Qwen3.8-Flash-Next）
# 思考开关的 chat_template_kwargs：DeepSeek 模板用 thinking(bool)，Qwen 用 enable_thinking(bool)，
# GLM-5.3 模板用 reasoning_effort(str)：默认 max，最低只能压到 low（无完全关闭开关，已冒烟实测）
if "qwen" in MODEL.lower():
    THINK_KW, THINK_VAL = "enable_thinking", True  # 值在 main 里按 THINKING 重设
elif "glm" in MODEL.lower():
    THINK_KW, THINK_VAL = "reasoning_effort", "low"
else:
    THINK_KW, THINK_VAL = "thinking", True
DATASET_NAME = "模型评测-测试1"  # 默认短上下文题库；agent 口径用 --dataset Agent长上下文-20k
MAX_TOKENS = 4096  # 仅当条目无参考输出长度时的兑底安全上限（vLLM 口径见 task()）
METRIC_STYLE = "legacy"  # legacy=中文旧口径（与历史实验可比）；industry=业界统一口径（TTFT/TPOT/E2E）

THINKING = True  # 由 --thinking 参数控制


def measure(messages, max_tokens: int = MAX_TOKENS):
    """发一次流式请求并掐表，返回 (指标字典, 回答文本)。messages 是 OpenAI 格式列表。"""
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},  # 末尾附 usage 块，拿 prompt_tokens 算预填吞吐
        "max_tokens": max_tokens,
        "chat_template_kwargs": {THINK_KW: THINK_VAL},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )

    t0 = time.perf_counter()
    ttft = None          # 首个 token 时刻（含思考 token）
    answer_start = None  # 正式回答开始时刻 = 思考耗时
    think_tokens = 0     # 思考 delta 块数 ≈ 思考 token 数
    answer_tokens = 0
    prompt_tokens = None # 末尾 usage 块里的输入 token 数
    answer = ""

    with urllib.request.urlopen(req, timeout=300) as resp:
        for line in resp:
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            usage = chunk.get("usage")
            if usage and usage.get("prompt_tokens"):
                prompt_tokens = usage["prompt_tokens"]
            delta = (chunk.get("choices") or [{}])[0].get("delta", {})
            if delta.get("reasoning_content"):
                think_tokens += 1
            if delta.get("content"):
                if answer_start is None:
                    answer_start = time.perf_counter() - t0
                answer_tokens += 1
                answer += delta["content"]
            if delta.get("content") or delta.get("reasoning_content"):
                if ttft is None:
                    ttft = time.perf_counter() - t0

    total = time.perf_counter() - t0
    tpot_ms = (
        (total - answer_start) * 1000 / (answer_tokens - 1)
        if answer_start and answer_tokens > 1
        else None
    )
    # 解码速度：回答阶段每秒产出多少 token
    decode_tps = (
        (answer_tokens - 1) / (total - answer_start)
        if answer_start and answer_tokens > 1
        else None
    )
    # 预填充吞吐：输入 token 数 / 首响延迟（首响主要来自预填充时有意义）
    prefill_tps = (
        prompt_tokens / ttft
        if prompt_tokens and ttft and ttft > 0.1
        else None
    )
    if METRIC_STYLE == "industry":
        # 业界统一口径（对齐 vLLM/SGLang benchmark_serving）+ 中文别名双报
        # 中文别名与 legacy 口径同名同算法，历史趋势图可直接对齐；
        # 思考类指标业界无对应概念且关思考下恒为 0，不上报
        metrics = {
            "TTFT(s)": ttft,                                # Time To First Token 首响
            "TPOT(ms)": tpot_ms,                            # Time Per Output Token 解码段每 token
            "E2E(s)": total,                                # 端到端总耗时
            "DecodeThroughput(tok/s)": decode_tps,          # 解码吞吐
            "PrefillThroughput(tok/s)": prefill_tps,        # 预填充吞吐 = 输入token/TTFT
            "InputTokens": prompt_tokens,                   # 输入 token 数
            "OutputTokens": answer_tokens,                  # 输出 token 数
            # ---- 中文别名 ----
            "首响延迟(秒)": ttft,
            "预填充吞吐tok/s": prefill_tps,
            "解码速度tok/s": decode_tps,
            "总耗时(秒)": total,
            "输出token数": answer_tokens,
        }
    else:
        metrics = {
            "首响延迟(秒)": ttft,
            "预填充吞吐tok/s": prefill_tps,
            "思考耗时(秒)": answer_start if THINKING else 0,  # 关思考时无思考阶段，上报 0 避免与首响混淆
            "思考token数": think_tokens or None,
            "解码速度tok/s": decode_tps,
            "总耗时(秒)": total,
            "输出token数": answer_tokens,  # 回答阶段生成的 token 数，决定解码段占比
            "解码耗时(秒)": round(total - answer_start, 3) if answer_start else None,  # 纯答题段耗时 = 总耗时 - 首答时刻
            "TPOT(ms)": tpot_ms,
        }
    return metrics, answer


def task(*, item, **kwargs):
    """Langfuse 对每条数据项自动建 trace；这里做单条请求并打分。

    max_tokens 口径对齐 vLLM benchmark_serving：每条请求的输出长度上限 =
    数据集参考回复的真实 token 数（metadata.output_tokens，由建集时 tokenizer 精确计数），
    模型可提前 EOS 停，统计用实际生成数；无该元数据时兑底 MAX_TOKENS。
    """
    # input 为字符串 -> 单轮 user；input 为 messages 列表（ShareGPT）-> 多轮直传
    if isinstance(item.input, list):
        messages = item.input
    elif isinstance(item.input, str):
        messages = [{"role": "user", "content": item.input}]
    else:
        messages = [{"role": "user", "content": json.dumps(item.input, ensure_ascii=False)}]
    ref_out = (item.metadata or {}).get("output_tokens")
    metrics, answer = measure(messages, max_tokens=int(ref_out) if ref_out else MAX_TOKENS)
    lf = get_client()
    for name, value in metrics.items():
        if value is not None:
            lf.score_current_trace(name=name, value=round(value, 3), data_type="NUMERIC")
    return answer


def load_client() -> Langfuse:
    """优先环境变量，其次密钥文件（默认脚本同目录 benchmarks/ttft-api-key.json）。"""
    default_key_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "benchmarks",
        "ttft-api-key.json",
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
        raise SystemExit(
            f"未找到 Langfuse 密钥：请设置 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY 环境变量，"
            f"或提供密钥文件 {key_file}"
        )
    return Langfuse(
        public_key=pk,
        secret_key=sk,
        host=os.environ.get("LANGFUSE_HOST", "http://localhost:3000"),
        timeout=60,  # 数据集接口一次要拉 151 条，默认超时太短
    )


def main():
    global THINKING, THINK_VAL, METRIC_STYLE
    ap = argparse.ArgumentParser(description="在 Langfuse 原生实验里测评模型延迟")
    ap.add_argument("--limit", type=int, help="只跑前 N 条（默认全部）")
    ap.add_argument("--thinking", choices=["on", "off"], default="on",
                    help="是否开启模型思考模式（默认 on）")
    ap.add_argument("--dataset", default=DATASET_NAME,
                    help="数据集名（默认 模型评测-测试1）")
    ap.add_argument("--concurrency", type=int, default=4, help="并发数（默认 4）")
    ap.add_argument(
        "--metric-style",
        choices=["legacy", "industry"],
        default="legacy",
        help="指标口径：legacy=中文旧口径（与历史实验可比），industry=业界统一口径 TTFT/TPOT/E2E",
    )
    ap.add_argument(
        "--name",
        help="实验名（默认 DeepSeek-V4-Flash-thinking-on/off），最终名不含时间戳后缀",
    )
    args = ap.parse_args()
    THINKING = args.thinking == "on"
    METRIC_STYLE = args.metric_style
    # 按 THINKING 重设各模板的思考开关值（GLM 无完全关闭：off→low，on→max）
    global_think_val = {"enable_thinking": THINKING, "reasoning_effort": ("low" if not THINKING else "max"), "thinking": THINKING}
    THINK_VAL = global_think_val[THINK_KW]

    lf = load_client()
    dataset = lf.get_dataset(args.dataset)
    items = dataset.items[: args.limit] if args.limit else dataset.items
    print(
        f"数据集「{args.dataset}」共 {len(dataset.items)} 条，"
        f"本次跑 {len(items)} 条，thinking={args.thinking}"
    )

    experiment_name = args.name or f"{MODEL}-thinking-{args.thinking}"
    result = lf.run_experiment(
        name=experiment_name,
        run_name=experiment_name,  # 传 run_name = 精确名，SDK 不再追加时间戳
        data=items,
        task=task,
        max_concurrency=args.concurrency,
        metadata={"model": MODEL, "thinking": args.thinking},
    )

    ok = sum(1 for r in result.item_results if r.output is not None)
    print(f"\n完成：成功 {ok}/{len(items)}")
    print(f"实验链接: {result.dataset_run_url or '(见数据集 Experiments 页)'}")
    lf.flush()


if __name__ == "__main__":
    main()
