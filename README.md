# 价格监控面板

本地网页面板，用来添加、暂停、恢复、删除商品价格监控，并通过 Telegram 发送提醒。

## 启动

```bash
node server.js
```

打开：

```text
http://localhost:4173
```

如果你在 Finder 里操作，也可以双击 `start.command` 启动。

## 数据

- 监控列表保存在 `data/monitors.json`
- Telegram 设置保存在 `data/settings.json`
- 这两个文件已经被 `.gitignore` 排除
- 也可以用环境变量 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`

## 支持

- adidas.ca 货号，例如 `JZ3168`
- 直接粘贴商品链接
- 手动立即检查
- 暂停、恢复、删除监控
- Telegram 测试消息

## 连接 GitHub

先在 GitHub 创建一个空仓库，然后在本目录运行：

```bash
git add .gitignore README.md package.json server.js start.command public/
git commit -m "Add price monitor dashboard"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

不要添加 `data/settings.json` 或 `data/monitors.json`，里面有本机配置和监控清单。
