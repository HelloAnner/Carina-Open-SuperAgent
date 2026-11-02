Carina
====================================================================

面向企业的多团队智能协作平台。核心链路：

  Source -> Trigger -> Thread
    -> Fast Path: 已订阅 -> Worker Inbox
    -> Slow Path: Router Batch -> Task -> Assignment
    -> DSH Worker Session -> Report -> Outbox -> Channel

文档：
  docs/prd.md                 产品需求
  docs/architecture.md        逻辑架构
  docs/tech-architecture.txt  技术方案与实现状态


快速开始（stub 运行时，不需要模型凭证）
--------------------------------------------------------------------

  cp .env.example .env
  docker compose -f docker/compose.yml --env-file .env up --build

  web      http://localhost:3000
  api      http://localhost:8080/api/health

打开页面，在输入框发一条事件。链路会走到：

  trigger -> router -> task -> worker -> outbox

也可以在 API 里直接模拟：

  curl -X POST http://localhost:8080/api/dev/simulate \
    -H 'content-type: application/json' \
    -d '{"domainId":"demo","text":"支付回调增加自动重试"}'

如果设置了 CARINA_API_KEY，请带上：
  -H "x-carina-key: $CARINA_API_KEY"


本地开发
--------------------------------------------------------------------

  pnpm install
  docker run -d --name carina-pg -p 5432:5432 \
    -e POSTGRES_USER=carina -e POSTGRES_PASSWORD=carina -e POSTGRES_DB=carina \
    postgres:16-alpine
  docker run -d --name carina-redis -p 6379:6379 redis:7-alpine

  DATABASE_URL=postgres://carina:carina@127.0.0.1:5432/carina pnpm migrate
  pnpm dev:api
  pnpm dev:worker
  pnpm dev:web

检查：
  pnpm typecheck
  pnpm test
  pnpm build:web


使用 DSH 真实 Agent Loop
--------------------------------------------------------------------

worker 通过 @deepseek-ai/dsh-sdk-client 拉起 dsh --profile sdk 子进程。

  DSH_RUNTIME=dsh
  WORKER_RUNTIME=dsh
  DSH_PROVIDER=deepseek-official
  DSH_MODEL=deepseek-v4-flash
  DSH_HOME=/root/.dsh

模型凭证按 DSH 的 provider 要求在 DSH_HOME 中配置。compose 已把
dshhome volume 挂到 worker。

每个 Assignment 使用独立子进程，并生成权限 patch：
  read-only / workspace-write 由 allowedActions 决定
  无人值守，approval policy 固定 never
  首期关闭 web；未授予 run_command 时关闭 bash

DSH SDK 没有 mid-turn cancel；取消会关闭该 Assignment 的子进程。


扩展点
--------------------------------------------------------------------

新增 Trigger 来源：
  1 packages/sources 实现 SourceKind（verify / parse / normalize）
  2 注册到 SourceRegistry
  3 管理端创建 source_instance
  core、API、worker loop 均不需要改

新增 Worker Session 实现：
  1 实现 WorkerRuntime（start / send / cancel / events / dispose）
  2 注册到 WorkerRuntimeRegistry
  3 Task 创建时选择 runtime_type


目录
--------------------------------------------------------------------

  apps/api            Fastify 入口、webhook、查询、SSE
  apps/worker         Router / Executor / Outbox / Watchdog 循环
  apps/web            React 控制台
  packages/contracts  域类型与 SPI
  packages/core       纯域逻辑与状态机
  packages/persistence Drizzle schema、Store、迁移、artifact
  packages/queue      Redis 租约、wakeup、事件总线
  packages/sources    来源适配器与注册表
  packages/agent      DSH SDK 适配与权限 patch
  packages/runtime    WorkerRuntime 注册表与 stub
  packages/channels   出站 Channel
  packages/application 应用服务
  docker              compose、Dockerfile、nginx
