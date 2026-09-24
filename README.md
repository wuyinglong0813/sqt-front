# sqt-front · 商签通小程序

独立前端目录，从原 TradePass 当前工作区复制。页面、业务交互、请求封装、资源和测试保持原样。

## 目录

- `miniprogram/`：小程序源码、页面、组件、图片、测试。
- `project.config.json`：微信开发者工具项目配置，指向 `miniprogram/`。
- `scripts/generate-invite-cover.py`：邀请分享图片生成脚本。
- `.github/workflows/frontend-ci.yml`：前端独立回归流水线。

## 使用

微信开发者工具导入本目录 `sqt-front`，也可以直接导入 `miniprogram/`。AppID 保持原值，本机工具偏好配置已复制并加入 Git 忽略。

测试要求 Node.js 18 及以上；项目 `.nvmrc` 和 CI 统一使用 Node.js 22。

```bash
npm ci
npm test
```

开发者工具、真机和 PC 微信默认都请求 `https://sqt.org.cn/api`，通过 HTTPS 网关连接自建服务器。普通请求使用 `wx.request`，文件上传使用 `wx.uploadFile`，不再依赖旧云托管 `callContainer`。

本地联调时，在 `miniprogram/app.js` 将 `USE_LOCAL_BACKEND` 改为 `true`，并按实际本地网关端口调整 `LOCAL_API`（默认 `http://127.0.0.1:9999/api`）。此开关仅在开发者工具中生效，开启后可使用原模拟账号；发布前恢复 `false`。连接服务器时，即使在开发者工具中也使用真实微信登录，不发送模拟凭证。

服务器切流和微信后台配置见 [接入自建服务器](docs/server-cutover.md)。

后端位于同级 `../sqt-backend/`；前端测试不需要读取或启动该目录。后端服务与业务说明见 [后端仓库](https://github.com/wuyinglong0813/sqt)。

本目录使用独立 Git 仓库 [sqt-front](https://github.com/wuyinglong0813/sqt-front)。初始提交保留迁移后的小程序源码及自建服务器接入改动；原 TradePass 仓库的历史保存在迁移前备份中。私有开发工具配置、环境文件和证书不纳入版本管理。
