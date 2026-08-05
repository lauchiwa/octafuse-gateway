# 交接说明（2026-08-06）

跨设备继续工作用。仓库已推送，`main` 在 github/gitee 与本地三方一致。

---

## 1. 环境准备（新设备）

```bash
git clone git@github.com:lauchiwa/octafuse-gateway.git   # 或 gitee
cd octafuse-gateway
npm install
npx wrangler login          # OAuth，交互式
```

**必须手动补的文件**（被 gitignore，不在仓库里）：

`cloudflare-worker/production.env`
```env
PROXY_WORKER_NAME=my-octafuse-prod-proxy
ADMIN_WORKER_NAME=my-octafuse-prod-admin
D1_DATABASE_NAME=my-octafuse-prod
D1_DATABASE_ID=397093b6-f805-448e-9fa3-40ac1c31b2d9
D1_MIGRATIONS_WORKER_NAME=my-octafuse-prod-d1-migrations
PROXY_CUSTOM_DOMAIN=api.qiwa.dpdns.org
ADMIN_CUSTOM_DOMAIN=admin.qiwa.dpdns.org
```

验证连通：
```bash
npx dotenv -e ./cloudflare-worker/production.env -- npm run -s db:query:remote -- "SELECT COUNT(*) FROM providers;"
```

Cloudflare 账号 `118b7d91db35f9199dfe2e4addf9ab2e`（chiwalau@163.com）。Worker secret 只有 `ADMIN_PASSWORD`。

---

## 2. 生产现状

| 项 | 值 |
|---|---|
| proxy | `2edf53ea-3bd5-4a0e-9ad1-0db0552459cd` |
| admin | `045a47df-c639-4822-aba9-f529aeb61fef` |
| 版本 | 2.1.1（全 package 一致） |
| D1 迁移 | `0018`，无待应用 |
| 主入口 | `api.qiwa.dpdns.org` / `admin.qiwa.dpdns.org`（国内免代理直连可用） |
| 备用入口 | `*.chiwalau.workers.dev`（需代理），`preview_urls: false` |

`main` HEAD = `6b69040`。回滚锚点：tag `pre-v2.1.1-merge` → `58f5fd6`（v2.0.0 时期）。

---

## 3. 本次会话完成的事

按时间顺序，均已部署并验证：

| 提交 | 内容 |
|---|---|
| `c8346b1`…`492137e` | 合并上游正式标签 v2.1.1（29 提交/166 文件/19 冲突），排除 6 个未发布提交 |
| `7e11f79` | 依赖 CVE 分诊：升 hono 4.13.0 / next 16.3.0 / postcss 8.5.23 / wrangler 4.118 |
| `9d3d9d6` | **移除 Responses→Chat 翻译层**（-3119 行），改为同协议进出 |
| `362514c` | **修复 Error 1102**：日志 body 脱敏提出后台闭包 |

三份沉淀文档（新设备请先读）：
- `.trellis/spec/guides/upstream-merge-thinking-guide.md` — 合并陷阱，含本次新增 4 条
- `docs/developers/upstream-sync.md` §5 — **fork 独有面清单**，下次合并必读
- `.trellis/workspace/chiwalau/journal-1.md` — 完整过程记录

---

## 4. 待办（按优先级）

### 4.1 观察 Error 1102 是否复现（进行中）

判断信号**不是错误率**，而是 `api_key_request_logs` 出现分钟级缺口——isolate 被终止时写不进日志：

```bash
npx dotenv -e ./cloudflare-worker/production.env -- npm run -s db:query:remote -- \
"SELECT substr(created_at,1,16) m, COUNT(*) n, MAX(input_tokens) max_in
 FROM api_key_request_logs WHERE created_at >= datetime('now','-6 hours')
 GROUP BY m ORDER BY m;"
```

持续流量期间出现空缺分钟 = 复现。

已修复的是「大 body 随后台闭包多存活最长 5 分钟」。**残余风险**：`/v1/messages` 仍无 body 大小上限，输入 token 峰值已达 619,554。并发再上台阶仍可能触顶。

### 4.2 未做的两项优化（需决策）

**a. 缩短 `USAGE_SAFETY_TIMEOUT_MS`**：当前 5 分钟（四条路由各自定义）。作用是等上游补发 usage，但实测上游截断集中在 27–32 秒，5 分钟远超需要。缩到 90s 能进一步降低闭包存活期。**代价**：慢上游的计费准确性。

**b. 请求体大小上限 + 413**：把「isolate 崩溃连带所有并发请求」降级为「单个超大请求被拒」，即故障隔离。建议 2MB。

### 4.3 上游渠道问题（网关侧无解）

- **千刀** `api.zzzcoding.org`：nginx 直接拒绝 POST，连正确的 `/v1/responses` 也回 405。需联系对方或停用该路由。
- **林夕** `k40.shengqainbang.cn`：HTTP 200 后开 SSE 流，27–32 秒空关闭，不发 `message_stop` 也不发 usage → 客户端报 `Anthropic stream ended without a stop reason`，网关记 `Stream ended before usage available`。8-04 起激增，当日峰值 54% 截断率，已自行回落到约 10%。
- **百倍** `sub.100xlabs.space`：近一周 161 次 HTTP 502（43.8%），8-04 04:00 后停止。502 属可 failover 的硬失败，比林夕的截断好处理。

### 4.4 遗留清理

- **2 个 `ofk1.` 密文 provider**：`pipi公益站`（active 但路由 inactive）、`君の公益`（provider disabled）。都不承接流量，不阻塞。补真 key 或删行。
- **`gpt-5.6-sol` 无健康路由**：3 条路由全部 responses-only，千刀 405 / 无名曾 403 / 君の公益 disabled。**不要加 chat 渠道翻译兜底**（已删除该能力，且会掩盖配置错误）；应加原生支持 `/v1/responses` 的渠道。`api.42w.shop` 已正确声明 responses 但未挂到该模型，是候选（未验证可用性）。
- **轮换 gateway API key**：`sk-P13si…` 在会话中多次明文出现，包括验证命令。

---

## 5. 关键设计约束（改代码前必读）

1. **同协议进出**。`/v1/responses` 只服务显式声明 `endpoints.openai.endpoints.responses` 的 provider，其余过滤后 502 并列出待配置名单。已删除翻译降级——翻译会静默丢 `reasoning`/`prompt_cache_key`（表现为"模型变笨"而非报错），且会掩盖 endpoint URL 配错。

2. **`responses` capability 不从 `base` 派生**（`chat` 会派生）。因为 `listConfiguredCapabilities` 对配了 `base` 的 provider 返回全部能力，派生会让 42 个预设中 10 个仅配 base 的被误判为支持 Responses。配置必须填**完整 URL**（`https://host/v1/responses`）。

3. **日志 body 脱敏必须在 `scheduleBackgroundWork` 之前算**。否则闭包捕获整个 body，大请求并发时撞 128MB。回归测试：`packages/proxy/src/services/request-log-body-hoist.test.ts`（变异验证过）。

4. **fork 独有面无人替你迁移**。`/v1/responses`、`custom_headers`、`sk-` 哈希、admin HMAC、层内路由偏好都是 fork 独有，上游至今没有 Responses 入站。上游重构共享服务时这些是静默腐坏点——v2.1.1 就漏了 `/v1/responses` 的 `markUserModelSuccess()`。清单见 `docs/developers/upstream-sync.md` §5。

5. **`@opennextjs/cloudflare` 精确 pin 在 1.19.4**，`npm audit` 会建议降到 1.8.4 —— **不要接受**，那会重新引入 middleware-manifest 500。

---

## 6. 未随仓库转移的本地文件

| 文件 | 说明 |
|---|---|
| `~/Backups/octafuse/d1-prod-20260805-154808.sql.gz` | 部署前 D1 备份（17MB 原始/986KB 压缩，12 表，sha256 前缀 `87ef14c1f29a`）。**新设备如需备份请重新导出** |
| `cloudflare-worker/production.env` | 见 §1 |

重新导出 D1：
```bash
npx dotenv -e ./cloudflare-worker/production.env -- npx wrangler d1 export my-octafuse-prod \
  --config packages/core/wrangler.d1.jsonc --remote --output ./d1-backup.sql
```

---

## 7. 常用命令

```bash
# 全量验证（435 测试）
npm run test:unit
npm run typecheck -w @octafuse/proxy && npm run typecheck -w @octafuse/admin

# 部署
npm run deploy:cloudflare -- production

# 迁移状态
npx dotenv -e ./cloudflare-worker/production.env -- npm run db:migrate:remote

# 查生产 D1（注意：必须带 dotenv，否则报 D1_DATABASE_ID is required）
npx dotenv -e ./cloudflare-worker/production.env -- npm run -s db:query:remote -- "<SQL>"

# Trellis
python ./.trellis/scripts/get_context.py
python ./.trellis/scripts/task.py list
```

`db:query:remote` 的输出混了脚本日志，解析时用 `re.search(r'\[\s*\{.*\}\s*\]', raw, re.S)` 提取 JSON。

---

## 8. 当前路由状态（`claude-opus-5`）

```
p=10 w=3  百倍-qxiaobu / -chiwalau / -xiaoqbu   可调度
p= 5 w=1  林夕-xiaoqbu / -chiwalau              可调度
p= 5 w=1  gorouter.app                          停用（provider disabled）
p= 0 w=1  agentrouter.org                       可调度
p= 0 w=1  anyrouter.top                         可调度
p= 0 w=1  pipi公益站                             停用（route inactive）
```

> **注意**：这与我会话中的改动不完全一致。我当时设的是林夕 `p=10 w=1`（留同层兜底）、agentrouter `inactive`。当前林夕在 `p=5`、agentrouter `active`，说明之后经 Admin 调整过。**以上表为准。**
>
> 若要恢复我当时的配置（百倍触顶时林夕可同层立即接管，而非等整层失败）：
> ```sql
> UPDATE model_routes SET priority=10 WHERE id IN
>   ('987b655d-7c87-4136-a64f-101a1ee44723','70712c36-12a7-41c0-9893-8bf8b1bb5767');
> UPDATE model_routes SET status='inactive' WHERE id='fa4c0f95-3bd8-432a-bcd1-13305c26a082';
> ```
> 取舍：`priority` 是硬序，林夕在 `p=5` 意味着只有 `p=10` 全层失败才启用；百倍历史峰值仅 34 次/小时而林夕达 207 次/小时，容量未经验证。

全局策略 `ROUTE_STRATEGY=affinity`。**单用户场景下 affinity 是确定性排序，不按权重分散**——权重只改变该用户的固定顺序，不要用蒙特卡洛模拟去推断分布。

---

## 9. 无名 provider 的 endpoints 修复（已应用）

`398b66e8-f008-4cfa-b133-65242e6b29c2`，`/v1` → `/v1/responses`。

回滚 SQL（原 `/tmp` 副本已丢失，此处留存）：
```sql
UPDATE providers
SET endpoints='{"openai":{"endpoints":{"responses":"https://welfare.0xpsyche.me/v1"}}}'
WHERE id='398b66e8-f008-4cfa-b133-65242e6b29c2';
```
不建议回滚：`/v1` 会 301 重定向，POST 跟随重定向丢 body，上游回 403。
