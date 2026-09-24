# 小程序接入自建服务器

默认入口：`https://sqt.org.cn/api`。服务器链路为 HTTPS Nginx → `127.0.0.1:1110` gateway → identity / business，保留原 `/api` 路径。Nacos 的 8848 端口只用于服务治理，不是小程序接口地址。

## 先确认域名确实到达新服务器

证书配置成功和域名可访问，不代表已连接新后端。2026-09-24 外网检查时，`sqt.org.cn` 的响应仍带有 `server: tcbgw` 和 `x-cloudbase-upstream-type: Tencent-CloudBaseRun`，请求仍经过云托管入口。切流时应核对 A / AAAA / CNAME 记录和 Nginx 的实际上游。

先在新服务器执行：

```bash
curl -i http://127.0.0.1:1110/tcb_probe
curl -i http://127.0.0.1:1110/api/me
```

前者应为 HTTP 200（空响应体）；后者未携带登录凭证时应为 HTTP 401 和未登录的 JSON。只检查 Nacos readiness 不能代替这两步。

已有 Nginx 时，将该域名的 HTTPS 上游配置为 `http://127.0.0.1:1110`，保留 `/api` 前缀。完整配置参考后端 `deploy/server/nginx-core-https.conf`，包括禁止公开 `/internal` 和 `/actuator`。应用端口保持回环监听，安全组和防火墙允许公网 HTTPS 443。

若没有已有 Nginx，在后端服务器 `server` 部署目录的 `.env.core` 中设置 `TRADEPASS_TLS_DIRECTORY`，指向包含 `fullchain.pem` 和 `privkey.pem` 的绝对目录，然后执行：

```bash
docker compose --env-file .env.core -f edge.core.compose.yml up -d
```

不要与现有占用 80 / 443 的 Nginx 同时启动。该 Compose 使用宿主机网络，不能替换成旧 `edge.compose.yml` 的 `gateway:8080` 上游。

改 DNS 前，可以在本机或另一台外网机器将下面的 `新服务器公网IP` 替换为实际地址，指定域名和目标 IP 检查证书及网关：

```bash
curl --resolve sqt.org.cn:443:新服务器公网IP -i https://sqt.org.cn/tcb_probe
curl --resolve sqt.org.cn:443:新服务器公网IP -i https://sqt.org.cn/api/me
```

验证通过后将域名指向新服务器，并检查普通访问的相同接口。不要用 `-k` 跳过证书校验。响应头可辅助排查，最终以新服务器 Nginx 访问日志确认请求落点。

## 微信后台和登录配置

- 在小程序后台「开发 → 开发设置 → 服务器域名」中配置 `request` 和 `uploadFile` 合法域名：`https://sqt.org.cn`，不加 `/api`。当前文件下载通过 request 获取 Base64 / 分片，不直接调用 `wx.downloadFile`；现有其他域名配置可以保留。
- 域名、HTTPS 证书和备案要求见 [微信网络文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)。正式验收时关闭开发者工具“不校验合法域名、TLS 版本及 HTTPS 证书”，并用真机体验版测试。
- 后端 `.env.core` 的 `WECHAT_APP_ID` 要与小程序一致（当前 `wxd6d1e93a3868253e`），`WECHAT_APP_SECRET` 使用对应小程序的真实密钥，只保存在后端。修改后用 `docker compose --env-file .env.core -f yudao.core.compose.yml up -d --no-deps identity` 重新创建 identity，使新环境变量生效。
- 普通登录、PC 微信登录使用 `wx.login` 取得 `code`；手机号快捷登录同时提交 `code` 与 `phoneCode`，后端分别换取 OpenID 和手机号。自建服务不依赖云托管自动注入的 OpenID。
- 如微信接口返回 IP 白名单错误，按微信后台要求添加服务器实际出口公网 IP；不要把 AppSecret 写进前端。

## 小程序发布和验收

1. 在微信开发者工具导入 `sqt-front`，确认 `miniprogram/app.js` 中 `USE_LOCAL_BACKEND = false`。开发者工具默认也连接服务器，登录使用当前微信账号；需要手机号授权时用手机测试。
2. 编译并重新登录；旧服务会话在新服务器可能无效，首次联调可清除开发者工具缓存。验证企业列表和切换、合同列表、文件上传和预览、手机号快捷登录。
3. 上传体验版，在手机关闭调试模式验收 HTTPS 和合法域名，再提交审核、发布。

修改本地源码不会改变已经发布的小程序。旧版本的普通请求仍走云托管，而上传使用 `sqt.org.cn`；直接修改这个域名可能使旧版本的业务请求与上传落在不同后端。正式切流需要协调小程序版本、旧入口转发和数据迁移。尚有用户使用旧版本时，不要仅改 DNS 就关闭旧云托管入口。
