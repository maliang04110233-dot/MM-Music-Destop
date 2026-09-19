# 验证步骤（请按顺序执行）

## 1. 切到项目目录

```powershell
cd "C:\Users\59443\WorkBuddy\2026-06-06-19-21-10\music-downloader"
```

## 2. 确认在正确目录（看到 package.json 在列）

```powershell
ls package.json
```

## 3. 重装依赖（因为 package.json 里我们加了 eslint devDep + 删了 3 个未用依赖）

```powershell
rmdir /s /q node_modules
del package-lock.json
npm install
```

## 4. 跑单测（应该看到 21 个用例全过）

```powershell
npm test
```

## 5. 跑 lint（应该看到一堆 warning / 少量 error，但项目仍能跑）

```powershell
npm run lint
```

## 6. 启动应用

```powershell
npm start
```

应用应该正常启动，UI 完整（CSS 通过 5 个 link 加载）。

---

# 预期输出

## npm test 预期

```
> music-downloader@1.0.0 test
> node --test test/

✔ cookie > pickCookieField: 抽取第一个命中的字段 (XX ms)
✔ cookie > pickCookieField: 跳过空格 (XX ms)
...（共 9 个 cookie 用例）
✔ parseFilename > parseFilename: 标准 " - " 分割 (XX ms)
...（共 7 个 parseFilename 用例）
✔ request > request: 成功响应直接返回解析后的 JSON (XX ms)
...（共 5 个 request 用例）
# tests 21
# pass 21
# fail 0
```

## 常见问题

### npm test 报 "test/xxx.test.js 找不到"

说明 `node --test test/` 找不到文件，可能 `test/` 目录没建。
先检查：

```powershell
ls test/
```

应该看到：
- `test/cookie.test.js`
- `test/parseFilename.test.js`
- `test/request.test.js`

### npm test 报 cookie 工具导入失败

可能是 utils/cookie.js 没建好。检查：

```powershell
cat src\utils\cookie.js | Select-Object -First 5
```

### npm test 报 request 失败

可能是 request.js 改了 API 形态，单测还停留在旧版本。
重新跑 `npm test` 看具体哪条失败，把失败信息发我。

### npm start 启动后白屏 / 没样式

F12 打开 DevTools 看 Console。
如果是 CSS 404，检查 `src/renderer/styles/` 目录下 5 个文件都在。
如果 renderer 报错，看 main process 日志。
