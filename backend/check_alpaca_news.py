"""
验证 Alpaca 免费账号是否具备「实时新闻流」权限。

用法：
  1) https://app.alpaca.markets 注册免费账号，拿到 API Key / Secret（Paper 账号即可）
  2) pip install websockets
  3) Windows PowerShell:
         $env:APCA_API_KEY_ID="PKxxxxxxxx"
         $env:APCA_API_SECRET_KEY="xxxxxxxx"
         python backend\\check_alpaca_news.py

结果判定：
  auth 成功且收到新闻        -> 免费账号可用，可做秒级推送
  401 / not authorized      -> 免费层不含实时新闻，需付费套餐
  auth 成功但 60 秒无新闻    -> 权限多半没问题，建议美股盘中再测一次
"""
import asyncio, json, os, sys

if sys.platform == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

KEY = os.getenv("APCA_API_KEY_ID", "")
SECRET = os.getenv("APCA_API_SECRET_KEY", "")
URL = "wss://stream.data.alpaca.markets/v1beta1/news"


async def main():
    if not KEY or not SECRET:
        print("[ERROR] 请先设置环境变量 APCA_API_KEY_ID 和 APCA_API_SECRET_KEY")
        return
    try:
        import websockets
    except ImportError:
        print("[ERROR] 缺少依赖，请先执行: pip install websockets")
        return

    print(f"连接 {URL} ...")
    async with websockets.connect(URL) as ws:
        await ws.send(json.dumps({"action": "auth", "key": KEY, "secret": SECRET}))
        print("auth ->", (await ws.recv())[:300])

        await ws.send(json.dumps({"action": "subscribe", "news": ["*"]}))
        print("sub  ->", (await ws.recv())[:300])

        print("等待新闻（最多 60 秒，建议美股盘中测试）...")
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=60)
            print("收到 ->", msg[:600])
            print("\n结论：免费账号有实时新闻权限，可以做秒级推送。")
        except asyncio.TimeoutError:
            print("\n60 秒内没有新闻。若未出现授权错误，多半是权限没问题，"
                  "建议在北京时间 21:30-04:00（美股盘中）再测一次。")


if __name__ == "__main__":
    asyncio.run(main())
