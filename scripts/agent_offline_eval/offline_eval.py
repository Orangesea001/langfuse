"""办公助手 Agent 离线测评全流程（Langfuse 实验 + 学城报告素材）

全流程四步：
    1. --init  在平台上准备测评资产：系统提示词（office-agent-system）+ 测评数据集
    2. run     对数据集逐条调 OfficeAgent，每条 trace 打 8 个指标分数
    3. 聚合    汇总本次 run 的各项指标均值、分类表现、失败用例
    4. 报告    生成 /tmp/agent_eval_report.md（可直接建为学城文档）+ summary JSON

8 个测评指标（每条用例都打分，无关维度跳过）：
    关键词命中(0-1)   答案对期望关键词的覆盖率（规则分）
    工具选择正确(0/1) 期望工具是否全部被调用（规则分）
    拒答正确(0/1)     超纲题是否明确拒答而非编造（规则分，仅超纲题）
    格式合规(0/1)     JSON 题可解析 / 简答题字数达标（规则分，仅格式题）
    LLM语义评分(1-5)  评委模型按准确性/完整性打分（模型分）
    总耗时(秒)        单条用例端到端耗时（性能分）
    LLM调用轮数       工具循环深度（效率分）
    工具调用次数      实际工具调用总数（效率分）

用法：
    python3 offline_eval.py --init                 # 只建提示词和数据集（幂等）
    python3 offline_eval.py --limit 3 --name smoke # 冒烟跑 3 条
    python3 offline_eval.py                        # 完整跑 12 条并生成报告
"""

import argparse
import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime

from langfuse import Langfuse, get_client

from demo_agent import (
    API_URL,
    DEFAULT_SYSTEM_PROMPT,
    MODEL,
    PROMPT_NAME,
    OfficeAgent,
    _load_client,
)

DATASET_NAME = "办公助手Agent-离线测评集"
REPORT_MD = "/tmp/agent_eval_report.md"
SUMMARY_JSON = "/tmp/agent_eval_summary.json"
# 学城报告默认创建的父目录（可用 --km-parent 覆盖，--no-km 关闭自动上传）
DEFAULT_KM_PARENT = "2791131015"
# 报告里实验链接统一替换成可共享域名（平台返回的是 localhost）
KM_HOST = "https://dev.evp.intel.sankuai.com"

# ---------------- 测评数据集（12 条，覆盖 6 类场景） ----------------
# metadata 字段说明：
#   category       用例类别（报告里按类别聚合）
#   keywords       期望答案包含的关键词（规则分）
#   expected_tools 期望被调用的工具（规则分）
#   expect_refusal 超纲题标记：正确行为是承认不知道
#   format         格式约束：json=必须输出可解析 JSON；brief=答案不超过 50 字
DATASET_ITEMS = [
    {
        "input": {"question": "美团是哪一年成立的？"},
        "expected_output": "2010年",
        "metadata": {"category": "知识问答", "keywords": ["2010"], "expected_tools": ["knowledge_base_search"]},
    },
    {
        "input": {"question": "美团的股票代码是什么？"},
        "expected_output": "3690.HK",
        "metadata": {"category": "知识问答", "keywords": ["3690"], "expected_tools": ["knowledge_base_search"]},
    },
    {
        "input": {"question": "美团的主要业务包括哪些？"},
        "expected_output": "外卖、到店、酒旅等本地生活服务",
        "metadata": {"category": "知识问答", "keywords": ["外卖", "到店"], "expected_tools": ["knowledge_base_search"]},
    },
    {
        "input": {"question": "帮我算一下 128*46+375 等于多少"},
        "expected_output": "6263",
        "metadata": {"category": "数学计算", "keywords": ["6263"], "expected_tools": ["calculator"]},
    },
    {
        "input": {"question": "(350+128)*2/4 的结果是多少？"},
        "expected_output": "239",
        "metadata": {"category": "数学计算", "keywords": ["239"], "expected_tools": ["calculator"]},
    },
    {
        "input": {"question": "现在几点了？"},
        "expected_output": "调用 get_current_time 返回当前时间",
        "metadata": {"category": "工具使用", "keywords": [], "expected_tools": ["get_current_time"]},
    },
    {
        "input": {"question": "北京今天天气怎么样？"},
        "expected_output": "调用 get_weather 返回北京今天晴、25°C",
        "metadata": {"category": "工具使用", "keywords": ["晴", "25"], "expected_tools": ["get_weather"]},
    },
    {
        "input": {"question": "先查一下美团成立于哪一年，再算一下到今年（2026年）成立多少年了"},
        "expected_output": "2010年成立，到2026年成立16年",
        "metadata": {"category": "多步推理", "keywords": ["2010", "16"], "expected_tools": ["knowledge_base_search", "calculator"]},
    },
    {
        "input": {"question": "美团明天的股价会涨吗？"},
        "expected_output": "应明确表示无法预测，禁止给出会涨/会跌的判断",
        "metadata": {"category": "超纲拒答", "keywords": [], "expected_tools": [], "expect_refusal": True},
    },
    {
        "input": {"question": "马斯克是哪家公司的创始人？"},
        "expected_output": "知识库无此信息，应明确回答不知道",
        "metadata": {"category": "超纲拒答", "keywords": [], "expected_tools": [], "expect_refusal": True},
    },
    {
        "input": {"question": "用 JSON 格式返回美团的成立年份和股票代码，字段名为 founded 和 stock_code"},
        "expected_output": '{"founded": "2010", "stock_code": "3690.HK"}',
        "metadata": {"category": "格式约束", "keywords": ["2010", "3690"], "expected_tools": ["knowledge_base_search"], "format": "json"},
    },
    {
        "input": {"question": "用不超过20个字介绍美团"},
        "expected_output": "简洁介绍，不超过20字，如：美团是本地生活服务平台",
        "metadata": {"category": "格式约束", "keywords": ["美团"], "expected_tools": [], "format": "brief"},
    },
]


# ---------------- 打分函数 ----------------

def keyword_score(answer: str, keywords: list) -> float | None:
    """关键词命中率：命中数 / 关键词总数；无关键词要求时跳过。"""
    if not keywords:
        return None
    hit = sum(1 for k in keywords if k in answer)
    return round(hit / len(keywords), 3)


def tool_score(called: list, expected: list) -> float | None:
    """期望工具是否全部被调用（0/1）；无期望工具时：没乱调工具得 1，乱调得 0。"""
    return 1.0 if set(expected) <= set(called) else 0.0


def refusal_score(answer: str, expect_refusal: bool) -> float | None:
    """超纲题是否拒答：出现拒答表述且不输出编造的具体结论。"""
    if not expect_refusal:
        return None
    refusal_words = ["不知道", "无法", "不能", "没有相关", "查不到", "不确定", "无可奉告"]
    return 1.0 if any(w in answer for w in refusal_words) else 0.0


def format_score(answer: str, fmt: str | None) -> float | None:
    """格式约束：json=可解析且非空；brief=不超过 50 字（留一倍余量）。"""
    if fmt == "json":
        text = answer.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            return 1.0 if json.loads(text) else 0.0
        except (json.JSONDecodeError, ValueError):
            return 0.0
    if fmt == "brief":
        return 1.0 if len(answer) <= 50 else 0.0
    return None


def llm_judge_score(question: str, answer: str, expected: str) -> float | None:
    """LLM 评委语义分（1-5）：用同一个部署实例做 judge，考察准确性与完整性。"""
    prompt = (
        "你是一个严格的评测员。请根据【问题】【参考答案】给【模型回答】打 1-5 分：\n"
        "5=完全正确且完整；4=正确但略不完整；3=部分正确；2=大部分错误；1=完全错误或答非所问。\n"
        "注意：正确拒答（明确说不知道/无法回答）在参考答案是拒答类时应给 5 分。\n"
        "只返回 JSON：{\"score\": <1-5>, \"reason\": \"<20字内理由>\"}\n\n"
        f"【问题】{question}\n【参考答案】{expected}\n【模型回答】{answer}"
    )
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 128,
        "chat_template_kwargs": {"thinking": False},
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = json.loads(resp.read())["choices"][0]["message"]["content"]
        text = text.replace("</think>", "").strip()
        start, end = text.find("{"), text.rfind("}")
        score = json.loads(text[start : end + 1])["score"]
        return float(min(max(score, 1), 5))
    except Exception:  # noqa: BLE001 - judge 失败不阻塞整条用例
        return None


# ---------------- 实验 task ----------------

_AGENT: OfficeAgent | None = None


def _agent(lf: Langfuse) -> OfficeAgent:
    global _AGENT
    if _AGENT is None:
        _AGENT = OfficeAgent(lf)
    return _AGENT


def make_task(lf: Langfuse):
    def task(*, item, **kwargs):
        meta = item.metadata or {}
        agent = _agent(lf)
        agent.reset()  # 每条用例独立会话，避免多轮记忆串题

        result = agent.run(item.input["question"])
        answer = result["answer"]

        scores = {
            "关键词命中(0-1)": keyword_score(answer, meta.get("keywords", [])),
            "工具选择正确(0/1)": tool_score(result["tool_calls"], meta.get("expected_tools", [])),
            "拒答正确(0/1)": refusal_score(answer, meta.get("expect_refusal", False)),
            "格式合规(0/1)": format_score(answer, meta.get("format")),
            "LLM语义评分(1-5)": llm_judge_score(item.input["question"], answer, item.expected_output or ""),
            "总耗时(秒)": result["latency_seconds"],
            "LLM调用轮数": float(result["llm_rounds"]),
            "工具调用次数": float(len(result["tool_calls"])),
        }
        client = get_client()
        for name, value in scores.items():
            if value is not None:
                client.score_current_trace(name=name, value=value, data_type="NUMERIC")

        # 返回值作为实验条目输出，报告聚合时直接用
        return {
            "question": item.input["question"],
            "category": meta.get("category", "未分类"),
            "answer": answer,
            "expected": item.expected_output,
            "scores": {k: v for k, v in scores.items() if v is not None},
        }

    return task


# ---------------- 资产初始化（幂等） ----------------

def init_assets(lf: Langfuse):
    """建提示词（production 标签）和数据集（跳过已存在的用例）。"""
    try:
        lf.get_prompt(PROMPT_NAME, label="production")
        print(f"提示词 {PROMPT_NAME} 已存在，跳过创建")
    except Exception:  # noqa: BLE001 - 不存在则创建
        lf.create_prompt(name=PROMPT_NAME, prompt=DEFAULT_SYSTEM_PROMPT, labels=["production"])
        print(f"已创建提示词 {PROMPT_NAME}（production）")

    lf.create_dataset(
        name=DATASET_NAME,
        description="办公助手 Agent 离线测评集：知识问答/数学计算/工具使用/多步推理/超纲拒答/格式约束，共12条",
    )
    # create_dataset 返回对象不含 items，需 get_dataset 重新拉取
    dataset = lf.get_dataset(DATASET_NAME)
    existing = {json.dumps(i.input, ensure_ascii=False, sort_keys=True) for i in dataset.items}
    created = 0
    for item in DATASET_ITEMS:
        key = json.dumps(item["input"], ensure_ascii=False, sort_keys=True)
        if key in existing:
            continue
        lf.create_dataset_item(dataset_name=DATASET_NAME, **item)
        created += 1
    print(f"数据集「{DATASET_NAME}」：已有 {len(existing)} 条，新增 {created} 条")


# ---------------- 报告生成 ----------------

def build_report(run_name: str, outputs: list, run_url: str, elapsed: float) -> tuple[str, dict]:
    """把本次 run 的结果聚合成 Markdown 报告 + summary JSON。"""
    metric_names = [
        "关键词命中(0-1)", "工具选择正确(0/1)", "拒答正确(0/1)", "格式合规(0/1)",
        "LLM语义评分(1-5)", "总耗时(秒)", "LLM调用轮数", "工具调用次数",
    ]
    # 指标总览：均值 + 参与打分的用例数（无关维度会跳过，分母不同）
    overview = {}
    for name in metric_names:
        values = [o["scores"][name] for o in outputs if name in o["scores"]]
        if values:
            overview[name] = {"mean": round(sum(values) / len(values), 3), "n": len(values)}

    # 分类聚合（以 LLM 语义分为主，关键词命中为辅）
    by_category: dict[str, dict] = {}
    for o in outputs:
        cat = by_category.setdefault(o["category"], {"n": 0, "judge": [], "keyword": [], "latency": []})
        cat["n"] += 1
        if "LLM语义评分(1-5)" in o["scores"]:
            cat["judge"].append(o["scores"]["LLM语义评分(1-5)"])
        if "关键词命中(0-1)" in o["scores"]:
            cat["keyword"].append(o["scores"]["关键词命中(0-1)"])
        cat["latency"].append(o["scores"]["总耗时(秒)"])

    # 失败用例：语义分 <=3 或关键词命中 <1 或工具选择错误
    failures = [
        o for o in outputs
        if o["scores"].get("LLM语义评分(1-5)", 5) <= 3
        or o["scores"].get("关键词命中(0-1)", 1) < 1
        or o["scores"].get("工具选择正确(0/1)", 1) == 0
    ]

    judge_mean = overview.get("LLM语义评分(1-5)", {}).get("mean", "-")
    tool_mean = overview.get("工具选择正确(0/1)", {}).get("mean", "-")
    latency_mean = overview.get("总耗时(秒)", {}).get("mean", "-")

    lines = [
        f"# 办公助手 Agent 离线测评报告（{run_name}）",
        "",
        f"测评时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}　被测模型：{MODEL}　测评耗时：{elapsed:.0f} 秒",
        "",
        f"实验链接：[{run_name}]({run_url})（Langfuse Experiments 页，可逐条查看 trace）" if run_url else "",
        "",
        "## 一、测评对象与数据集",
        "",
        "被测对象是智能办公助手 OfficeAgent（demo_agent.py）：系统提示词托管在 Langfuse（office-agent-system，production 版本），"
        "具备多轮记忆、工具调用循环（知识库检索/计算器/时间/天气 4 个工具）、全链路 trace 观测能力。",
        "",
        f"测评数据集「{DATASET_NAME}」共 {len(outputs)} 条用例，覆盖 6 类场景：知识问答、数学计算、工具使用、多步推理、超纲拒答、格式约束。",
        "",
        "## 二、指标总览（均值）",
        "",
        "| 指标 | 均值 | 打分条数 |",
        "| --- | --- | --- |",
    ]
    for name, stat in overview.items():
        lines.append(f"| {name} | {stat['mean']} | {stat['n']} |")

    lines += [
        "",
        "## 三、分类表现",
        "",
        "| 用例类别 | 条数 | LLM语义评分均值 | 关键词命中均值 | 平均总耗时(秒) |",
        "| --- | --- | --- | --- | --- |",
    ]
    for cat, stat in by_category.items():
        j = round(sum(stat["judge"]) / len(stat["judge"]), 2) if stat["judge"] else "-"
        k = round(sum(stat["keyword"]) / len(stat["keyword"]), 2) if stat["keyword"] else "-"
        lat = round(sum(stat["latency"]) / len(stat["latency"]), 2)
        lines.append(f"| {cat} | {stat['n']} | {j} | {k} | {lat} |")

    lines += [
        "",
        "## 四、逐条用例明细",
        "",
        "| 用例 | 类别 | 关键词命中 | 工具正确 | LLM评分 | 总耗时(秒) | Agent 回答（截断） |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for o in outputs:
        s = o["scores"]
        ans = o["answer"].replace("|", "\\|").replace("\n", " ")[:60]
        lines.append(
            f"| {o['question'][:30]} | {o['category']} | {s.get('关键词命中(0-1)', '-')} | "
            f"{s.get('工具选择正确(0/1)', '-')} | {s.get('LLM语义评分(1-5)', '-')} | "
            f"{s.get('总耗时(秒)', '-')} | {ans} |"
        )

    lines += ["", "## 五、失败用例分析", ""]
    if failures:
        for o in failures:
            s = o["scores"]
            lines.append(
                f"- **{o['question'][:40]}**（{o['category']}）：关键词命中 {s.get('关键词命中(0-1)', '-')}，"
                f"工具正确 {s.get('工具选择正确(0/1)', '-')}，LLM 评分 {s.get('LLM语义评分(1-5)', '-')}。"
                f"回答：{o['answer'][:120]}"
            )
    else:
        lines.append("本次 run 无失败用例。")

    lines += [
        "",
        "## 六、结论与建议",
        "",
        f"本轮测评 LLM 语义评分均值 {judge_mean}/5，工具选择正确率 {tool_mean}，单条平均耗时 {latency_mean} 秒。"
        + (
            f"共 {len(failures)} 条失败用例，建议优先排查失败用例的 trace（工具选择与回答生成环节），"
            "修正后重新跑本数据集对比，得分不下降再切 production 发布。"
            if failures
            else "全部用例通过，本轮变更可进入发布流程（production 标签切换）。"
        ),
        "",
    ]
    summary = {
        "run_name": run_name,
        "run_url": run_url,
        "model": MODEL,
        "n_items": len(outputs),
        "metrics_overview": overview,
        "failures": len(failures),
        "by_category": {k: v["n"] for k, v in by_category.items()},
    }
    return "\n".join(lines), summary


def upload_report_to_km(run_name: str, km_parent: str) -> str | None:
    """把报告自动建为学城文档：去重 H1 标题、替换链接域名，调 citadel CLI 创建。

    返回学城文档链接；失败返回 None（不阻塞主流程）。
    """
    with open(REPORT_MD) as f:
        lines = f.readlines()
    # 第一行 H1 与 --title 重复，去掉；链接换成可共享域名
    body = "".join(lines[1:]).replace("http://localhost:3000", KM_HOST)
    km_md = "/tmp/agent_eval_report_km.md"
    with open(km_md, "w") as f:
        f.write(body)

    title = f"办公助手 Agent 离线测评报告（{run_name}）"
    proc = subprocess.run(
        ["oa-skills", "citadel", "createDocument", "--title", title,
         "--file", km_md, "--parentId", km_parent],
        capture_output=True, text=True, timeout=120,
    )
    output = proc.stdout + proc.stderr
    match = re.search(r"https://km\.sankuai\.com/collabpage/\d+", output)
    if proc.returncode == 0 and match:
        return match.group(0)
    print(f"⚠️ 学城上传失败（报告仍在 {REPORT_MD}）：\n{output[-500:]}")
    return None


# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser(description="办公助手 Agent 离线测评全流程")
    ap.add_argument("--init", action="store_true", help="只初始化提示词和数据集，不跑实验")
    ap.add_argument("--limit", type=int, help="只跑前 N 条（冒烟用）")
    ap.add_argument("--name", help="实验名（默认 office-agent-eval-YYYYMMDD-HHMM）")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--km-parent", default=DEFAULT_KM_PARENT,
                    help=f"学城报告父目录 contentId（默认 {DEFAULT_KM_PARENT}）")
    ap.add_argument("--no-km", action="store_true", help="只跑测评，不自动建学城报告")
    args = ap.parse_args()

    lf = _load_client()
    init_assets(lf)
    if args.init:
        return

    dataset = lf.get_dataset(DATASET_NAME)
    items = dataset.items[: args.limit] if args.limit else dataset.items
    run_name = args.name or f"office-agent-eval-{datetime.now().strftime('%Y%m%d-%H%M')}"
    print(f"数据集「{DATASET_NAME}」共 {len(dataset.items)} 条，本次跑 {len(items)} 条，实验名 {run_name}")

    t0 = time.perf_counter()
    result = lf.run_experiment(
        name=DATASET_NAME,
        run_name=run_name,
        data=items,
        task=make_task(lf),
        max_concurrency=args.concurrency,
        metadata={"agent": "OfficeAgent", "model": MODEL, "prompt": PROMPT_NAME},
    )
    elapsed = time.perf_counter() - t0
    lf.flush()

    outputs = [r.output for r in result.item_results if r.output]
    run_url = result.dataset_run_url or ""
    print(f"\n完成：成功 {len(outputs)}/{len(items)}，实验链接: {run_url}")

    report_md, summary = build_report(run_name, outputs, run_url, elapsed)
    with open(REPORT_MD, "w") as f:
        f.write(report_md)
    with open(SUMMARY_JSON, "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"报告已生成: {REPORT_MD}\n汇总数据: {SUMMARY_JSON}")

    if not args.no_km:
        km_url = upload_report_to_km(run_name, args.km_parent)
        if km_url:
            print(f"学城报告已创建: {km_url}")


if __name__ == "__main__":
    main()
