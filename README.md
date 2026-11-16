# 璀璨宝石 · 宝可梦

HTML、CSS 和 JavaScript 实现的本机对战桌。在主菜单选择「开始新局」，可以和电脑小茂对战，也可以选择 2–4 人同屏轮流操作。

[GitHub Pages 版](https://zqpei.github.io/game/splendor-pokemon/)提供单人、同屏对战和卡牌列表。联机房间使用下方的 Node.js 服务。

## 运行

从 workspace 启动静态服务，无需安装前端依赖或构建。

```sh
cd /Users/bytedance/workspace/game
python3 -m http.server 8765 --bind 127.0.0.1
```

打开 [宝可梦对战桌](http://127.0.0.1:8765/splendor-pokemon/dist/)。如果已有服务在 8765 端口提供 game 目录，直接打开即可。

当前对局和跨局图鉴自动保存在浏览器。重新打开网页后，点击「继续对局」即可续玩。开新局前会提示覆盖本局存档，图鉴保留。

「卡牌列表」可以搜索宝可梦名称或图鉴编号。每个卡牌版本直接显示捕捉费用、分数和进化所需的永久加成。点开宝可梦还能查看捕捉后获得的永久加成。对局内的普通卡详情也可跳转到该宝可梦的进化链。

## 联机对战

联机需要 Node.js 22 或更新版本。房主创建房间并复制邀请链接，朋友在自己的设备打开链接填写昵称。2–4 人到齐后由房主开局。

同一网络里的设备可使用局域网地址。以下命令适用于 Wi‑Fi 接口为 `en0` 的 Mac。

```sh
cd /Users/bytedance/workspace/game/splendor-pokemon
pokemon_lan_ip=$(ipconfig getifaddr en0)
BIND_HOST=0.0.0.0 PUBLIC_ORIGIN="http://$pokemon_lan_ip:8766" node server.mjs
```

房主打开 [联机大厅](http://127.0.0.1:8766/?online=1)。系统生成的邀请链接采用 `PUBLIC_ORIGIN`。只在本机测试时，可以直接运行 `node server.mjs` 并在各浏览器会话使用同一个服务。

异地朋友需要能访问服务器。把此目录放到公开可达的 Node.js 主机上，或把独立游戏端口 8766 接到支持 HTTPS 的反向代理或临时隧道，再从公开 HTTPS 地址打开大厅创建房间。可选地设置 `PUBLIC_ORIGIN` 来指定邀请链接地址。 [Cloudflare 临时隧道说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

房间状态由服务端保存于内存。同一浏览器刷新邀请链接会重新加入原座位。关闭服务或房间连续 24 小时没有操作会结束该房间。单人与同屏模式仍使用浏览器里的原存档。

## 规则与素材

- [宝可梦版规则书（日语译本）](https://eapelly.com/wp-content/uploads/2024/03/Splendor-Pokemon-Japanese.pdf)
- 规则引擎、电脑策略和 90 张社区转录卡牌数据改编自 [LeonJoeeee/splendor-pokemon](https://github.com/LeonJoeeee/splendor-pokemon)，MIT 许可见 [LICENSE-engine.txt](dist/LICENSE-engine.txt)。卡牌数值尚未逐张与实体牌校对。
- 宝可梦插画来自 [PokéAPI Sprites](https://github.com/PokeAPI/sprites)，按图鉴编号存为本地 WebP。
