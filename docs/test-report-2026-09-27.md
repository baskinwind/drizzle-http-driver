# drizzle-http-driver 三库验收报告

日期：2026-09-27。验收对象为本仓库 `0.2.0-rc.0` 工作区（基础提交 `a02e75f`，含本轮修复），不是已发布 npm 包。

## 结果

| 范围 | 通过 | 失败 |
| --- | ---: | ---: |
| 单元及生命周期回归 | 8 | 0 |
| postgresql 远程验收 | 23 | 0 |
| mysql 远程验收 | 18 | 0 |
| oracle 远程验收 | 16 | 0 |

类型检查、ESM/CJS 构建与导出加载、npm pack dry-run 和 git diff --check 均通过。非法 TEST_DIALECT 会失败，不再出现选择 PostgreSQL 却执行零用例的假成功。

## 本轮修复

- PostgreSQL/MySQL 的顶层及嵌套事务增加生命周期检查。原回归测试可复现已结束的嵌套事务继续通过外层连接执行 SQL；修复后直接执行、预编译查询以及再次创建嵌套事务都会在 HTTP 请求前被拒绝。成功和回滚两条路径均覆盖，外层事务仍可正常继续。
- 公共返回类型的 timing 改为可选，与 Oracle 实际响应一致。
- 统一三库远程入口；补充分类命令，校验数据库名称，并拒绝 MySQL/Oracle 零用例结果。
- 修正文档中的旧测试路径、Oracle 提交后的 release 行为和测试环境说明。

## 环境与复跑

Node.js 22.22.2、pnpm 9.15.4、Drizzle ORM 0.45.2。数据库账号由 drizzle-proxy 的测试连接文档提供；报告不包含密码。Oracle 使用 Thick 模式及本机 Instant Client。

```bash
pnpm typecheck
pnpm test
pnpm build
UV_THREADPOOL_SIZE=32 ORACLE_DRIVER_MODE=thick \
ORACLE_CLIENT_LIB_DIR=/absolute/path/to/instantclient \
TEST_REPORT=/absolute/path/to/results \
pnpm test:remote
```

PostgreSQL 复用相邻 drizzle-proxy/server/tests/postgresql/drizzle.ts，加载本包构建产物；MySQL/Oracle 使用本包源码和 tests/remote-integrity.ts。可用 DRIZZLE_PROXY_ROOT 指定代理仓库位置。测试使用独立 HTTP 服务、TCP 中继及唯一命名测试表，在 finally 中清理。

## 覆盖与边界

覆盖 CRUD、预编译占位符、重复绑定、Unicode/特殊字符、返回映射及数值/时间精度、事务提交/回滚、保存点、多层嵌套、隔离设置、并发、连接断开、超时、提交响应丢失及取消后的释放。PG/MySQL 额外覆盖 ORM 关系查询和分页；Oracle 覆盖 SQL 模板、LOB、RAW 和时间文本。

Oracle 是 SQL/事务适配器，没有原生 Oracle ORM 表定义或 select().from() 查询构建器。MySQL/Oracle 的 DDL 仍可能隐式提交。结果说明本轮环境和列出用例通过，不代表所有数据库版本、部署方式或长时间负载都已验证。尚未发布 npm 包。

## 逐项结果

### postgresql

| 用例 | 结果 | 耗时 ms |
| --- | --- | ---: |
| CRUD returning, aliases, nulls, upsert, delete | PASS | 3804 |
| prepared placeholders, repeated names and missing-value rejection | PASS | 3340 |
| SQL tagged interpolation, literal/comment tokens, reordered $n and JSON ? operator | PASS | 3512 |
| duplicate column names and nullable left join use ordered array rows | PASS | 1009 |
| relational findMany/findFirst, nested rows and empty results | PASS | 2665 |
| CTE, aggregate/count, limit/offset and SQL expression decoding | PASS | 4013 |
| timestamp Date mode and timestamptz decoding | PASS | 909 |
| date/string timestamp/interval preserve database text and microseconds | PASS | 872 |
| numeric/timestamp arrays, bigint and JSON decoding | PASS | 889 |
| parameter encoding for Date, bigint, arrays, JSON and null | PASS | 1705 |
| transaction commits, pins connection, returns callback value and expires handle | PASS | 2935 |
| callback throw rolls back through release and preserves original error | PASS | 1946 |
| tx.rollback rolls back all writes | PASS | 1918 |
| nested transaction success and savepoint rollback preserve outer transaction | PASS | 5407 |
| three nesting levels and inner SQL error recover with savepoint | PASS | 3837 |
| outer rollback also rolls back successfully released savepoint | PASS | 2637 |
| transaction configuration reaches PostgreSQL | PASS | 4012 |
| concurrent transactions remain isolated and release pool capacity | PASS | 5612 |
| statement timeout triggers driver rollback and connection recovery | PASS | 5745 |
| network loss rolls back and does not replay writes | PASS | 3193 |
| lost commit acknowledgement is reported without duplicate replay | PASS | 2124 |
| aborted signal still releases and rolls back transaction | PASS | 1903 |
| low-level client release is idempotent and rejects later queries | PASS | 661 |

### mysql

| 用例 | 结果 | 耗时 ms |
| --- | --- | ---: |
| mysql: transaction options protocol rejects invalid requests | PASS | 45 |
| mysql: CRUD, auto generated IDs, null, upsert and delete headers | PASS | 5718 |
| mysql: prepared repeated placeholders, reuse and missing rejection | PASS | 1600 |
| mysql: native binding preserves literal/comment question marks and injection text | PASS | 1705 |
| mysql: duplicate labels, left join nullability and ordered rows | PASS | 737 |
| mysql: relational findMany/findFirst and empty results | PASS | 3107 |
| mysql: CTE, count, limit/offset and expression decoder | PASS | 3316 |
| mysql: bigint, exact decimal, JSON, Date and microsecond timestamp roundtrip | PASS | 1594 |
| mysql: transaction commits, pins connection, callback result and stale handle | PASS | 2826 |
| mysql: callback throw and explicit rollback leave no rows | PASS | 3443 |
| mysql: nested success, nested rollback, three levels and SQL error recovery | PASS | 7945 |
| mysql: read-only transaction and isolation configuration on pinned connection | PASS | 9388 |
| mysql: concurrent transactions and pool reuse | PASS | 3843 |
| mysql: timeout destroys connection, rolls back and recovers | PASS | 4334 |
| mysql: TCP disconnect rolls back without replay | PASS | 2787 |
| mysql: lost commit response never retries writes | PASS | 1938 |
| mysql: aborted signal still releases and rolls back transaction | PASS | 1792 |
| mysql: release idempotency and post-release rejection | PASS | 519 |

### oracle

| 用例 | 结果 | 耗时 ms |
| --- | --- | ---: |
| oracle: transaction options protocol rejects invalid requests | PASS | 627 |
| oracle: SQL tagged CRUD, Unicode and exact numeric result | PASS | 9434 |
| oracle: prepared repeated placeholders, reuse, missing rejection and literal tokens | PASS | 6137 |
| oracle: ordered duplicate labels and native reordered/repeated binds | PASS | 7349 |
| oracle: typed RAW/CLOB/BLOB, timestamp text precision and bigint input | PASS | 8395 |
| oracle: commit, pinned session, callback value and stale transaction rejection | PASS | 8007 |
| oracle: callback error and tx.rollback remove writes | PASS | 12633 |
| oracle: nested savepoint success, rollback, three levels and SQL error recovery | PASS | 14682 |
| oracle: outer rollback includes successful nested transaction | PASS | 6950 |
| oracle: read-only/isolation settings and invalid combination rejection | PASS | 13470 |
| oracle: concurrent transactions remain isolated and release sessions | PASS | 9271 |
| oracle: call timeout rolls back a prior write and recovers | PASS | 11119 |
| oracle: TCP disconnect rolls back without replay and recovers | PASS | 6008 |
| oracle: lost commit response is surfaced without retry and releases session | PASS | 6777 |
| oracle: aborted signal still releases and rolls back transaction | PASS | 6459 |
| oracle: delete affected rows and empty result | PASS | 10189 |

机器可读结果见 [JSON 报告](test-results-2026-09-27.json)。

## 独立适配器入口调整复验

同日后续按不兼容方式拆分导出：根入口仅提供公共客户端和类型，`/postgresql`、`/mysql`、`/oracle` 各自导出 `drizzle`，源码按数据库目录组织。移除根入口的数据库工厂和 `DrizzleHttpConfig`；`/client` 提供独立公共传输入口。

调整后重新通过类型检查、8 项单元测试、构建、3 项包入口测试及 NodeNext 类型导入检查。入口测试验证 ESM/CJS 均可加载，根入口不含旧工厂，各适配器的构建依赖图不加载其他数据库代码；pack dry-run 确认五个入口的 ESM/CJS/声明文件齐全。

使用 `TEST_CASE=CRUD` 复跑三种数据库的远程冒烟测试，各 1 项通过，共 3 项。PostgreSQL 加载新 `dist/postgresql.js` 和 `dist/client.js`；MySQL/Oracle 使用新源码入口。上文 57 项完整验收发生在此次入口拆分之前，此次没有重复全部故障测试。

## 按职责拆分复验

后续将三个适配器目录的 index.ts 统一为纯导出文件；MySQL 拆出工厂、数据库、会话和事务模块，Oracle 拆出工厂、数据库、事务协议、绑定及类型模块。公开 API 和事务协议保持不变。

本次通过 pnpm typecheck、8 项单元/生命周期回归、pnpm build，以及 pnpm test:exports 的 3 项运行时入口测试和 NodeNext 类型导入检查。本次结构整理未重新运行远程数据库测试；前述远程结果属于之前的验收阶段。

## 业务契约口径补充

本报告中的远程通过数表示各数据库当时已实现的 API/协议用例通过，不代表三库业务代码只换 adapter 已完成。Oracle ORM 查询构建器仍缺失，PG/MySQL 的 schema 和部分返回接口仍有差异。统一目标与待完成项见 [业务契约](adapter-contract.md)。

契约核对后运行 pnpm test：10 项通过、0 项失败、1 项 TODO（Oracle 共享 ORM 契约）；pnpm typecheck 通过。本轮未重跑远程数据库测试。
