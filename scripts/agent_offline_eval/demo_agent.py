"""演示 Agent：智能办公助手（OfficeAgent）

一个"麻雀虽小五脏俱全"的 Agent，具备完整 Agent 的核心能力：
    1. 系统提示词托管在 Langfuse，运行时拉取 production 版本（改提示词不改代码）
    2. 多轮对话记忆（conversation history 跨轮保留）
    3. 工具调用循环（tool-use loop，最多 5 轮，支持一次响应多个工具）
    4. Langfuse 全链路观测：run / 每轮 LLM 调用 / 每次工具调用各自成 span
    5. 结构化运行结果：回答、工具调用日志、LLM 轮数、token 用量、耗时

内置 4 个工具：
    knowledge_base_search  本地知识库检索（美团相关事实）
    calculator             安全四则运算
    get_current_time       查询当前时间
    get_weather            查询城市天气（演示用模拟数据）

被测模型走 OpenAI 兼容接口，默认指向部署机 llama-server（DeepSeek-V4-Flash）。
单独运行本文件可手动体验：python3 demo_agent.py
"""

import ast
import json
import operator
import os
import time
import urllib.request
from datetime import datetime

from langfuse import Langfuse, get_client, observe

# ---------------- 模型接入配置（与 latency_eval.py 同一口径） ----------------
API_URL = os.environ.get(
    "LLM_API_URL", "http://10.164.125.74:8088/v1/chat/completions"
)
MODEL = os.environ.get("LLM_MODEL", "DeepSeek-V4-Flash")
MAX_TOOL_ROUNDS = 5  # 工具调用循环上限，防死循环

# 提示词在 Langfuse 上的名字；平台不存在时用本地兜底版本并自动建到平台上
PROMPT_NAME = "office-agent-system"

DEFAULT_SYSTEM_PROMPT = """你是一个智能办公助手，遵守以下规则：
1. 回答事实性问题时，优先调用 knowledge_base_search 检索知识库，不要凭印象编造。
2. 涉及数学计算时，必须调用 calculator，不要口算。
3. 涉及时间、天气时，调用对应工具获取，不要编造。
4. 知识库查不到、工具也无法回答的问题，明确回答"不知道"，禁止编造。
5. 回答简洁，先给结论再给必要说明。
"""

# ---------------- 工具的底层实现 ----------------

# 演示用本地知识库：真实场景替换成 RAG 检索
KNOWLEDGE_BASE = {
    "成立": "美团于 2010 年 3 月 4 日在北京成立，创始人是王兴。",
    "股票": "美团于 2018 年在香港联交所上市，股票代码 3690.HK。",
    "业务": "美团的主要业务包括外卖、到店餐饮、酒店旅游、美团优选、美团买菜、共享单车等本地生活服务。",
    "总部": "美团总部位于北京市朝阳区。",
    "创始人": "美团创始人是王兴，毕业于清华大学。",
}

# 演示用模拟天气：真实场景替换成天气 API
MOCK_WEATHER = {
    "北京": {"weather": "晴", "temp": "25°C", "wind": "北风3级"},
    "上海": {"weather": "多云", "temp": "27°C", "wind": "东风2级"},
    "杭州": {"weather": "小雨", "temp": "23°C", "wind": "南风2级"},
}

# calculator 的安全求值：只允许数字与四则/乘方/取余，拒绝任意代码执行
_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
    ast.USub: operator.neg,
}


def _safe_calc(expr: str):
    def _eval(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](_eval(node.operand))
        raise ValueError(f"不支持的表达式: {expr}")

    return _eval(ast.parse(expr, mode="eval").body)


# ---------------- 工具定义（OpenAI tools schema + 本地执行函数） ----------------

@observe(name="tool-knowledge_base_search")
def knowledge_base_search(query: str) -> str:
    for key, value in KNOWLEDGE_BASE.items():
        if key in query:
            return value
    return "知识库中没有找到相关信息。"


@observe(name="tool-calculator")
def calculator(expression: str) -> str:
    try:
        return str(_safe_calc(expression))
    except Exception as e:  # noqa: BLE001 - 工具要把错误喂回给模型而不是炸掉主流程
        return f"计算失败: {e}"


@observe(name="tool-get_current_time")
def get_current_time() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@observe(name="tool-get_weather")
def get_weather(city: str) -> str:
    info = MOCK_WEATHER.get(city)
    if not info:
        return f"暂无{city}的天气数据。"
    return f"{city}今天{info['weather']}，气温{info['temp']}，{info['wind']}。"


TOOL_FUNCS = {
    "knowledge_base_search": lambda args: knowledge_base_search(args["query"]),
    "calculator": lambda args: calculator(args["expression"]),
    "get_current_time": lambda args: get_current_time(),
    "get_weather": lambda args: get_weather(args["city"]),
}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "knowledge_base_search",
            "description": "检索公司知识库，查询企业相关事实（成立时间、股票代码、业务、总部、创始人等）",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "检索问题"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "计算数学表达式，支持 + - * / ** % 和括号",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string", "description": "数学表达式，如 (350+128)*2/4"}},
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "获取当前日期和时间",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市今天的天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "城市名，如 北京"}},
                "required": ["city"],
            },
        },
    },
]


# ---------------- Agent 主体 ----------------

class OfficeAgent:
    """智能办公助手：Langfuse 托管提示词 + 多轮记忆 + 工具调用循环 + 全链路观测。"""

    def __init__(self, lf: Langfuse):
        self.lf = lf
        # 耦合点 1：系统提示词从 Langfuse 拉 production 版本，本地 DEFAULT 兜底
        prompt_obj = lf.get_prompt(PROMPT_NAME, label="production", fallback=DEFAULT_SYSTEM_PROMPT)
        self.system_prompt = prompt_obj.prompt
        self.history = []  # 多轮对话记忆

    def reset(self):
        """清空记忆（离线测评时每条用例独立，避免串题）。"""
        self.history = []

    @observe(name="llm-chat", as_type="generation")
    def _chat(self, messages: list) -> dict:
        """单次 LLM 调用（非流式，工具循环里的每一步）。"""
        payload = {
            "model": MODEL,
            "messages": messages,
            "tools": TOOL_SCHEMAS,
            "tool_choice": "auto",
            "max_tokens": 1024,
            "chat_template_kwargs": {"thinking": False},
        }
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
        choice = data["choices"][0]
        # 把模型/token 信息挂到 generation span 上，平台里可直接看用量
        get_client().update_current_generation(
            model=MODEL,
            usage_details={
                "input": data.get("usage", {}).get("prompt_tokens"),
                "output": data.get("usage", {}).get("completion_tokens"),
            },
        )
        message = choice["message"]
        # llama-server 关思考时仍会吐一个空的 </think> 闭合标签，清掉
        if message.get("content"):
            message["content"] = message["content"].replace("</think>", "").strip()
        return message

    @observe(name="office-agent-run")
    def run(self, question: str) -> dict:
        """跑一次完整问答：LLM ↔ 工具 循环，直到模型给出最终回答。"""
        t0 = time.perf_counter()
        messages = [{"role": "system", "content": self.system_prompt}]
        messages += self.history
        messages.append({"role": "user", "content": question})

        tool_calls_log = []  # [(工具名, 参数, 结果)]
        rounds = 0
        answer = ""

        for _ in range(MAX_TOOL_ROUNDS):
            rounds += 1
            message = self._chat(messages)
            calls = message.get("tool_calls") or []

            if not calls:  # 模型不再要工具，输出最终回答
                answer = message.get("content") or ""
                break

            messages.append(message)  # assistant 的 tool_calls 消息必须回传
            for call in calls:
                name = call["function"]["name"]
                args = json.loads(call["function"]["arguments"] or "{}")
                result = TOOL_FUNCS[name](args) if name in TOOL_FUNCS else f"未知工具: {name}"
                tool_calls_log.append((name, args, result))
                messages.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": str(result)}
                )

        # 写入多轮记忆
        self.history.append({"role": "user", "content": question})
        self.history.append({"role": "assistant", "content": answer})

        latency = round(time.perf_counter() - t0, 3)
        # 根 span 的输入输出即 trace 的输入输出（SDK 4.x 无 update_current_trace）
        get_client().update_current_span(
            input=question,
            output=answer,
            metadata={"llm_rounds": rounds, "tool_calls": [c[0] for c in tool_calls_log]},
        )
        return {
            "answer": answer,
            "tool_calls": [c[0] for c in tool_calls_log],
            "llm_rounds": rounds,
            "latency_seconds": latency,
        }


def _load_client() -> Langfuse:
    """与 latency_eval.py 相同的密钥加载逻辑：环境变量 > benchmarks/ttft-api-key.json。"""
    key_file = os.environ.get(
        "LANGFUSE_KEY_FILE",
        os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "benchmarks", "ttft-api-key.json",
        ),
    )
    creds = {}
    try:
        with open(os.path.normpath(key_file)) as f:
            creds = json.load(f)
    except FileNotFoundError:
        pass
    return Langfuse(
        public_key=os.environ.get("LANGFUSE_PUBLIC_KEY") or creds.get("publicKey"),
        secret_key=os.environ.get("LANGFUSE_SECRET_KEY") or creds.get("secretKey"),
        host=os.environ.get("LANGFUSE_HOST", "http://localhost:3000"),
        timeout=60,
    )


if __name__ == "__main__":
    lf = _load_client()
    agent = OfficeAgent(lf)
    for q in ["美团是哪一年成立的？", "那到今年成立多少年了？"]:
        r = agent.run(q)  # 第二问依赖多轮记忆
        print(f"Q: {q}\nA: {r['answer']}\n   工具={r['tool_calls']} 轮数={r['llm_rounds']} 耗时={r['latency_seconds']}s\n")
    lf.flush()
