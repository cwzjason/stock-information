"""
美股实时监控 — 华尔街见闻 + 美联储
- 7x24 全球财经快讯
- FOMC 决议、CPI、非农、财报
- 英文自动翻译中文
- 企业微信实时推送
"""
import json, hashlib, os, re, sys, time, random
from datetime import datetime
import requests

# Fix Windows console encoding
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo(os.getenv("MONITOR_TZ", "Asia/Shanghai"))
except Exception:
    _TZ = None

def now_cn():
    """统一北京时间，避免云端机器是 UTC 导致推送时间戳差 8 小时"""
    return datetime.now(_TZ) if _TZ else datetime.now()

def _load_dotenv():
    """本机用：从 backend/.env 读密钥（.env 已 gitignore，不会进仓库）"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path): return
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    except Exception: pass

_load_dotenv()

# ==================== 配置 ====================
# 优先级：GitHub Actions Secrets（环境变量） > backend/.env（本机） > 空
WECOM_WEBHOOK_URL = os.getenv("WECOM_WEBHOOK_URL", "")

# ==================== Supabase 云端去重（未配置则回退本地文件） ====================
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")        # anon key 或 service_role key
DEDUP_TABLE = os.getenv("SUPABASE_DEDUP_TABLE", "news_dedup")
DEDUP_LOOKBACK = int(os.getenv("DEDUP_LOOKBACK", "5000"))       # 每次载入内存的去重条数
DEDUP_RETENTION_DAYS = int(os.getenv("DEDUP_RETENTION_DAYS", "30"))  # 云端记录保留天数
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)

# 企业微信机器人限频 20 条/分钟：推送间隔 + 单轮上限，避免被限流
PUSH_MIN_INTERVAL = float(os.getenv("PUSH_MIN_INTERVAL", "3"))
MAX_PUSH_PER_RUN = int(os.getenv("MAX_PUSH_PER_RUN", "25"))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# ==================== 关键词分级 ====================
URGENT_KEYWORDS = [
    "美联储加息", "美联储降息", "Fed raises", "Fed cuts", "Fed hikes",
    "FOMC statement", "FOMC decision", "紧急降息", "emergency rate cut",
    "rate hike", "rate cut", "interest rate decision", "联邦基金利率", "federal funds rate",
    "circuit breaker", "熔断", "flash crash", "black swan", "市场崩盘", "暴跌熔断",
    "禁止做空", "short selling ban", "无限QE", "unlimited QE",
]

IMPORTANT_KEYWORDS = [
    "CPI", "核心CPI", "core CPI", "PCE", "core PCE",
    "非农", "nonfarm payrolls", "NFP", "GDP", "ISM制造业", "ISM services",
    "初请失业金", "initial jobless claims", "零售销售", "retail sales",
    "鲍威尔", "Powell", "hawkish", "dovish", "鹰派", "鸽派",
    "taper", "缩表", "quantitative tightening", "dot plot", "点阵图",
    "贸易战升级", "tariff escalation", "制裁升级", "sanctions escalate",
    "中东局势", "Middle East tension", "VIX飙升", "VIX surge",
    "NVIDIA财报", "Apple财报", "Tesla财报", "Microsoft财报",
    "earnings beat", "earnings miss", "guidance cut",
    # SEC 披露
    "sec 8-k", "sec 6-k", "sc 13d", "sc 13g", "sec 10-k", "sec 10-q",
]

GENERAL_KEYWORDS = [
    "美股", "US stock", "nasdaq", "dow jones", "s&p 500", "S&P",
    "道琼斯", "纳斯达克", "标普", "科技股", "tech stocks", "中概股",
    "芯片股", "semiconductor", "AI股", "油价", "oil price", "黄金", "gold price",
]

# ==================== 去重 ====================
_seen_hashes = set()
_pending_hashes = []            # 本次运行新增、待写入 Supabase 的 hash
_supabase_ok = USE_SUPABASE     # 云端不可用时自动降级为本地文件
DEDUP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dedup_cache.json")
MAX_DEDUP = 5000

def _fingerprint(title):
    return hashlib.md5(re.sub(r'\s+', ' ', title.lower().strip()).encode()).hexdigest()

# ---------- 本地文件（兜底） ----------
def _load_local():
    try:
        if os.path.exists(DEDUP_FILE):
            with open(DEDUP_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f).get("hashes", []))
    except Exception: pass
    return set()

def _save_local():
    try:
        with open(DEDUP_FILE, "w", encoding="utf-8") as f:
            json.dump({"hashes": list(_seen_hashes)[-MAX_DEDUP:], "updated": now_cn().isoformat()}, f)
    except Exception: pass

# ---------- Supabase（PostgREST） ----------
def _sb_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
         "Content-Type": "application/json"}
    if extra: h.update(extra)
    return h

def _sb_load():
    global _supabase_ok
    hashes, page, per_page = set(), 0, 1000
    try:
        while len(hashes) < DEDUP_LOOKBACK:
            r = requests.get(f"{SUPABASE_URL}/rest/v1/{DEDUP_TABLE}",
                headers=_sb_headers(),
                params={"select": "hash", "order": "created_at.desc",
                        "limit": str(per_page), "offset": str(page * per_page)},
                timeout=10)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            batch = r.json()
            hashes.update(x["hash"] for x in batch if "hash" in x)
            if len(batch) < per_page: break
            page += 1
        return hashes
    except Exception as e:
        print(f"  [Supabase] 读取失败，本次回退本地缓存: {e}")
        _supabase_ok = False
        return _load_local()

def _sb_insert(hashes):
    if not hashes: return True
    try:
        r = requests.post(f"{SUPABASE_URL}/rest/v1/{DEDUP_TABLE}",
            headers=_sb_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=[{"hash": h} for h in hashes], timeout=15)
        if r.status_code not in (200, 201, 204):
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        return True
    except Exception as e:
        print(f"  [Supabase] 写入失败: {e}")
        return False

def _sb_prune():
    """清理过期记录，防止表无限增长"""
    try:
        requests.post(f"{SUPABASE_URL}/rest/v1/rpc/prune_dedup", headers=_sb_headers(),
                      json={"retention_days": DEDUP_RETENTION_DAYS}, timeout=15)
    except Exception as e:
        print(f"  [Supabase] 清理失败: {e}")

# ---------- 统一入口 ----------
def dedup_load():
    global _seen_hashes
    _seen_hashes = _sb_load() if USE_SUPABASE else _load_local()
    print(f"  Dedup cache: {len(_seen_hashes)} entries "
          f"[{'Supabase' if (_supabase_ok and USE_SUPABASE) else 'local'}]")
    return _seen_hashes

def dedup_save():
    if _supabase_ok and USE_SUPABASE:
        if _sb_insert(_pending_hashes):
            _pending_hashes.clear()
            _sb_prune()
            return
    _save_local()      # 云端不可用 → 落本地，保证下次运行不会重复推送

def _is_duplicate(title):
    fp = _fingerprint(title)
    if fp in _seen_hashes: return True
    _seen_hashes.add(fp)
    _pending_hashes.append(fp)
    return False

def classify_news(title, default="skip"):
    """default: 未命中任何关键词时的级别。
    美股频道/美联储这类已经筛过的内容传 general，保证能推送出去。"""
    t = title.lower()
    for kw in URGENT_KEYWORDS:
        if kw.lower() in t: return "urgent"
    for kw in IMPORTANT_KEYWORDS:
        if kw.lower() in t: return "important"
    for kw in GENERAL_KEYWORDS:
        if kw.lower() in t: return "general"
    return default

# ==================== 翻译 ====================
def _is_english(text):
    if not text: return False
    alpha = sum(1 for c in text if c.isalpha())
    chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    return alpha > chinese * 2 if alpha > 0 else False

def translate_to_chinese(text):
    if not _is_english(text): return text
    try:
        r = requests.get("https://translate.googleapis.com/translate_a/single",
            params={"client":"gtx","sl":"en","tl":"zh-CN","dt":"t","q":text[:500]},
            headers=HEADERS, timeout=8)
        if r.status_code == 200:
            return "".join(p[0] for p in r.json()[0] if p[0])
    except: pass
    return text

# ==================== 推送 ====================
def send_wecom(title, content, level, link=""):
    try:
        emoji = {"urgent":"🔴🔴","important":"🟡","general":"🟢"}.get(level,"📊")
        level_cn = {"urgent":"紧急","important":"重要","general":"一般"}.get(level,level)
        display_title = translate_to_chinese(title)
        display_content = translate_to_chinese(content) if content else ""

        text = f"""{emoji} **{level_cn}** | {display_title}

{display_content}

{'> 原文: ' + title if _is_english(title) else ''}
{'> 来源: ' + link if link else ''}
`{now_cn().strftime('%Y-%m-%d %H:%M:%S')}`"""

        r = requests.post(WECOM_WEBHOOK_URL,
            json={"msgtype":"markdown","markdown":{"content":text}}, timeout=10)
        return r.status_code == 200 and r.json().get("errcode") == 0
    except Exception as e:
        print(f"[Push Error] {e}")
        return False

# ==================== 数据源 ====================

# 注意：原来的 global-channel 现在返回的是国内新闻（频道已失效），
# 真正的美股/全球市场内容在 us-stock-channel 与 hk-stock-channel。
WALLSTREET_CHANNELS = os.getenv("WALLSTREET_CHANNELS", "us-stock-channel,hk-stock-channel").split(",")

def fetch_wallstreetcn():
    """华尔街见闻 7x24 快讯（美股频道 + 港美股/全球市场频道）"""
    items = []
    for ch in WALLSTREET_CHANNELS:
        try:
            r = requests.get(
                "https://api-one.wallstcn.com/apiv1/content/lives",
                params={"channel": ch.strip(), "client": "pc", "limit": 30},
                headers={**HEADERS, "Referer": "https://wallstreetcn.com/"}, timeout=10)
            if r.status_code != 200:
                print(f"  [WallStreetCN {ch}] HTTP {r.status_code}"); continue
            for item in r.json().get("data",{}).get("items",[])[:30]:
                title = item.get("title","") or item.get("content_text","")
                content = item.get("content_text","") or item.get("content","")
                if title and len(title) > 6:
                    items.append({"title":title[:200],"content":content[:500] if content!=title else "",
                        "link":f"https://wallstreetcn.com/livenews/item/{item.get('id','')}",
                        "source":"华尔街见闻","always_push":True})
        except Exception as e: print(f"  [WallStreetCN {ch} Error] {e}")
    return items

def fetch_fed():
    """美联储官网 RSS"""
    items = []
    try:
        r = requests.get("https://www.federalreserve.gov/feeds/press_all.xml", headers=HEADERS, timeout=10)
        if r.status_code == 200:
            for block in re.findall(r'<item>(.*?)</item>', r.text, re.DOTALL)[:10]:
                tm = re.search(r'<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', block, re.DOTALL)
                dm = re.search(r'<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</description>', block, re.DOTALL)
                lm = re.search(r'<link>(.*?)</link>', block)
                if tm:
                    items.append({"title":f"[Fed] {re.sub(r'<[^>]+>','',tm.group(1)).strip()}",
                        "content":re.sub(r'<[^>]+>','',dm.group(1)).strip()[:300] if dm else "",
                        "link":lm.group(1).strip() if lm else "","source":"Federal Reserve","always_push":True})
    except Exception as e: print(f"[Fed Error] {e}")
    return items

# ==================== SEC EDGAR（免费官方，无需 Key） ====================
# 合规：必须带身份声明的 User-Agent，且不超过 10 次/秒（我们每轮只请求 1 次）
# https://www.sec.gov/about/developer-resources
SEC_USER_AGENT = os.getenv("SEC_USER_AGENT", "USStockMonitor/1.0 (admin@example.com)")
SEC_FORM_TYPES = [t.strip() for t in os.getenv(
    "SEC_FORM_TYPES", "8-K,6-K,SC 13D,SC 13D/A,SC 13G,SC 13G/A,425,10-K,10-Q").split(",")]
SEC_PER_TYPE = int(os.getenv("SEC_PER_TYPE", "20"))   # 每种表单取最新多少条
SEC_MAX_ITEMS = int(os.getenv("SEC_MAX_ITEMS", "60")) # 单轮总量上限

def fetch_sec_edgar():
    """SEC EDGAR 最新披露：官方 Atom 流，披露后约 1 秒内更新。
    按表单类型分别请求，否则会被海量的内部人持股申报（Form 3/4）淹没。
    覆盖财报、并购、重大事项、大股东举牌等公司公告（不含媒体快讯）"""
    items = []
    for form in SEC_FORM_TYPES:
        try:
            r = requests.get("https://www.sec.gov/cgi-bin/browse-edgar",
                params={"action": "getcurrent", "type": form, "output": "atom",
                        "count": str(SEC_PER_TYPE), "owner": "include"},
                headers={**HEADERS, "User-Agent": SEC_USER_AGENT}, timeout=15)
            if r.status_code != 200:
                print(f"  [SEC {form}] HTTP {r.status_code}"); continue
            for block in re.findall(r"<entry>(.*?)</entry>", r.text, re.DOTALL):
                tm = re.search(r"<title>(.*?)</title>", block, re.DOTALL)
                lm = re.search(r'<link[^>]*href="([^"]+)"', block)
                um = re.search(r"<updated>(.*?)</updated>", block, re.DOTALL)
                if not tm: continue
                raw = re.sub(r"\s+", " ", tm.group(1)).strip()
                company = raw.split(" - ", 1)[1].strip() if " - " in raw else raw
                href = lm.group(1) if lm else ""
                link = "https://www.sec.gov" + href if href.startswith("/") else href
                items.append({"title": f"[SEC {form}] {company}",
                    "content": f"披露时间: {um.group(1).strip()}" if um else "",
                    "link": link, "source": "SEC EDGAR", "always_push": True})
                if len(items) >= SEC_MAX_ITEMS: return items
            time.sleep(0.2)      # 温和限速，远低于官方 10 次/秒上限
        except Exception as e: print(f"  [SEC {form} Error] {e}")
    return items

# ==================== 主流程 ====================

def collect_all_news():
    all_items = []
    for name, fetcher in [("华尔街见闻",fetch_wallstreetcn),("Federal Reserve",fetch_fed),
                          ("SEC EDGAR",fetch_sec_edgar)]:
        try:
            print(f"  [Fetching] {name}...")
            items = fetcher()
            print(f"  [{name}] Got {len(items)} items")
            all_items.extend(items)
        except Exception as e: print(f"  [{name}] Error: {e}")
    return all_items

def process_and_push(items, dry_run=False):
    stats = {"total":len(items),"urgent":0,"important":0,"general":0,"skipped":0,"pushed":0}
    for item in items:
        title = item.get("title","")
        if not title or len(title) < 8: stats["skipped"] += 1; continue
        if _is_duplicate(title): stats["skipped"] += 1; continue
        level = classify_news(title, default="general" if item.get("always_push") else "skip")
        if level == "skip": stats["skipped"] += 1; continue
        stats[level] += 1
        if not dry_run:
            if send_wecom(title, item.get("content","")[:500], level, item.get("link","")):
                stats["pushed"] += 1
                print(f"  [PUSHED] [{level}] {title[:60]}")
                if stats["pushed"] >= MAX_PUSH_PER_RUN:
                    print(f"  [LIMIT] 本轮已达上限 {MAX_PUSH_PER_RUN} 条，剩余留到下轮")
                    break
                time.sleep(PUSH_MIN_INTERVAL)
    return stats

def run_once(dry_run=False):
    print(f"\n{'='*60}\n  US Market Monitor - {now_cn().strftime('%Y-%m-%d %H:%M:%S')} "
          f"({'Supabase' if (_supabase_ok and USE_SUPABASE) else 'local'})\n{'='*60}")
    if dry_run: print("  [DRY RUN MODE]")
    dedup_load()
    items = collect_all_news()
    print(f"  Total collected: {len(items)}")
    stats = process_and_push(items, dry_run)
    dedup_save()
    print(f"\n  Results: {stats}\n{'='*60}\n")
    return stats

# ==================== 定时方案 ====================

def start_scheduler(interval=180, dry_run=False):
    try:
        from apscheduler.schedulers.blocking import BlockingScheduler
        from apscheduler.triggers.interval import IntervalTrigger
    except ImportError:
        print("  [WARN] 未安装 apscheduler，自动回退到内置 simple loop")
        return run_loop_simple(interval, dry_run)
    scheduler = BlockingScheduler(timezone="Asia/Shanghai")
    def job():
        try: run_once(dry_run)
        except Exception as e: print(f"  [JOB ERROR] {e}")
    job()
    scheduler.add_job(job, IntervalTrigger(seconds=interval), id="us_monitor", misfire_grace_time=30)
    print(f"\n  APScheduler started — every {interval}s | Ctrl+C to stop\n")
    try: scheduler.start()
    except KeyboardInterrupt: print("\n  Stopped"); _save_dedup()

def run_loop_simple(interval=180, dry_run=False):
    print(f"\n  Simple loop — every {interval}s | Ctrl+C to stop\n")
    fails = 0
    while True:
        try:
            run_once(dry_run); fails = 0
        except KeyboardInterrupt:
            print("\n  Stopped"); dedup_save(); break
        except Exception as e:
            fails += 1
            print(f"  [ERROR] {e}")
            dedup_save()
            if fails >= 10:
                print("  [FATAL] 连续失败 10 次，退出（由计划任务重新拉起）"); break
            time.sleep(60)
            continue
        time.sleep(interval)

def run_and_exit(dry_run=False):
    return run_once(dry_run)

# ==================== CLI ====================

if __name__ == "__main__":
    import sys
    interval, dry_run, mode = 180, False, "scheduler"
    args = sys.argv[1:]; i = 0
    while i < len(args):
        if args[i] == "--interval" and i+1 < len(args): interval = int(args[i+1]); i += 2
        elif args[i] == "--dry-run": dry_run = True; i += 1
        elif args[i] == "--once": mode = "once"; i += 1
        elif args[i] == "--simple": mode = "simple"; i += 1
        elif args[i] == "--scheduler": mode = "scheduler"; i += 1
        elif args[i] == "--help":
            print("""
US Market Monitor | 华尔街见闻 + 美联储
  --scheduler   APScheduler (default)
  --simple      time.sleep loop
  --once        run once & exit
  --interval N  seconds (default 180)
  --dry-run     no push
"""); sys.exit(0)
        else: i += 1

    if not WECOM_WEBHOOK_URL and not dry_run:
        print("  [FATAL] 未配置 WECOM_WEBHOOK_URL（GitHub Secrets 或 backend/.env）")
        sys.exit(2)

    if mode == "once": run_and_exit(dry_run)
    elif mode == "simple": run_loop_simple(interval, dry_run)
    else: start_scheduler(interval, dry_run)
