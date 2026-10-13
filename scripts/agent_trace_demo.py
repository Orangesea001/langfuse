"""极简 demo：把一个"带工具调用的 agent"接入 Langfuse，产生带树的 trace。

跑完在平台的 Traces 页能看到 5 条 trace，每条里面是：
    demo-agent (trace 根节点)
      └─ answer (一次模型调用，generation，带 token 数)
           └─ retrieve (模拟检索的工具调用，span)

用途：给 Evaluators / Rules 评测流程提供真实数据。

用法（和 latency_eval.py 同目录、同密钥）：
    python3 agent_trace_demo.py
"""

import json
import urllib.request

from langfuse import get_client, observe

from latency_eval import API_URL, MODEL, load_client

# 模拟的"知识库"（agent 检索用）
DOCS = [
    "Langfuse 是开源的 LLM 可观测平台，核心功能是 tracing、评估和数据集实验。",
    "本平台部署的模型是 DeepSeek-V4-Flash，跑在 llama.cpp 上，端口 8088。",
    "评估器（Evaluator）可以用 LLM 当裁判给 trace 自动打分。",
    "规则（Rule）可以按筛选条件对线上 trace 自动触发评估器。",
    "评分（Score）会挂在 trace 上，可在 Analytics 页看趋势。",
]

QUESTIONS = [
    "这个平台部署的模型是什么，跑在什么框架上？",
    "Langfuse 的核心功能有哪些？",
    "模型服务暴露在哪个端口？",
    "怎么对 trace 自动打分？",
    "北京明天的天气怎么样？",  # 超出知识库范围，看 judge 能不能识破
]


def chat(messages, max_tokens=256):
    """非流式调一次模型，并给当前 generation 补模型名和 token 数。"""
    payload = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"thinking": False},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    usage = data.get("usage", {})
    get_client().update_current_generation(
        model=MODEL,
        usage_details={
            "input": usage.get("prompt_tokens"),
            "output": usage.get("completion_tokens"),
            "total": usage.get("total_tokens"),
        },
    )
    return data["choices"][0]["message"]["content"]


@observe()
def retrieve(query: str) -> str:
    """模拟检索工具：按关键词匹配文档。"""
    hits = [d for d in DOCS if any(w in d for w in query[:2])]
    return "\n".join(hits[:2]) if hits else DOCS[0]


@observe(as_type="generation")
def answer(question: str) -> str:
    context = retrieve(question)
    return chat(
        [
            {
                "role": "system",
                "content": "根据参考资料回答问题，只依据资料内容回答。\n\n参考资料：\n"
                + context,
            },
            {"role": "user", "content": question},
        ]
    )


@observe(name="demo-agent")
def run_agent(question: str) -> str:
    # 把检索到的参考资料挂到 root span 的 metadata，供 groundedness 评估器使用
    get_client().update_current_span(
        metadata={"retrieved_context": retrieve(question)}
    )
    return answer(question)


def main():
    load_client()  # 复用 latency_eval 的密钥逻辑，并注册全局 client
    for q in QUESTIONS:
        out = run_agent(q)
        print(f"Q: {q}\nA: {out[:80]}\n")
    get_client().flush()
    print("完成，去平台 Traces 页看 demo-agent 的 trace 树")


if __name__ == "__main__":
    main()
