# HTTP Drizzle 业务契约

## 核心目标

业务端通过 HTTP/HTTPS 使用 Drizzle API，不建立到数据库的原生 TCP 连接，不安装 pg、mysql2 或 oracledb 原生数据库客户端。业务初始化时选择 PostgreSQL、MySQL 或 Oracle adapter；共同能力范围内，查询、写入、预编译参数、事务和回滚使用同一套业务调用方式。

```text
业务代码 → Drizzle adapter → HTTP/HTTPS → drizzle-proxy → 数据库原生连接 → 数据库
```

“不通过 TCP”指业务端不直连数据库的 TCP 端口。HTTP/HTTPS 自身可能使用 TCP，代理到数据库仍使用原生 TCP/TLS/Oracle Net 连接；项目不承诺整条链路没有 TCP。

## 两个项目的职责

- `drizzle-http-driver`：对业务暴露 Drizzle API，将查询编译为目标数据库语句和参数，经 HTTP 发送；处理结果映射、事务 ID、保存点和清理。方言和 HTTP 协议细节应封装在 adapter 内。
- `drizzle-proxy`：提供 HTTP 执行接口，负责鉴权、租户/Key 路由、原生驱动连接池、固定事务连接和资源回收。TCP 断连测试针对这一端的数据库连接，不代表业务端必须使用 TCP 驱动。

业务代码不应手写 `$1`/`?`/`:1`、transaction_id 或 release 请求来实现普通 ORM 操作。手写 SQL 的 Query API 是底层接口和排错工具，不能代替统一 ORM 能力的交付。

## 目标与当前差距

| 验收项 | PostgreSQL | MySQL | Oracle |
| --- | --- | --- | --- |
| 业务端经 HTTP 调用 | 已实现 | 已实现 | 已实现 |
| 独立 adapter，统一 drizzle 工厂 | 已实现 | 已实现 | 已实现 |
| select / insert / update / delete 链式 API | 已实现 | 已实现 | 未实现 |
| ORM 预编译参数与行映射 | 已实现 | 已实现 | 仅 SQL 模板绑定，缺少 ORM 映射 |
| transaction / 嵌套事务 / rollback | 已实现 | 已实现 | 已实现 |
| 完全只换 adapter，业务及 schema 写法不变 | 尚未完整验收 | 尚未完整验收 | 未满足 |

PG/MySQL 的常见 CRUD 和事务调用可以共享，但仍使用各自的 schema 定义。返回接口也存在差异，例如 PostgreSQL returning、MySQL $returningId，以及原始 execute() 返回形状。这些差异须在统一契约中明确或由 adapter 层收敛，不能笼统宣称完全可替换。

Oracle 当前实现的是 SQL/事务适配器，要求业务编写 SQL，缺少 ORM 表定义和查询构建器。这是相对于核心目标的待完成项，不能视为已经满足“仅换 adapter”。不应通过让业务分支判断 Oracle 并改写 SQL 来完成这项验收。

## 测试验收口径

1. 共享业务用例只写一份；数据库准备、adapter 和 schema 组装位于测试初始化层。若目标还要求同一份 schema，则需要单独验证，不能把不同 schema 工厂视为已满足。
2. 三个 adapter 都应执行相同的业务 CRUD、预编译参数、结果断言、事务成功/失败、显式回滚、保存点和并发用例。普通业务用例中不按数据库类型分支。
3. SQL 占位符、原生连接、类型编码、服务端故障注入放在 adapter/代理专属测试中。
4. 文档和报告分别标注 HTTP 传输、单库 API 和跨库业务契约的结果；三库原生 SQL 测试全部通过不等于跨库业务契约完成。

当前 driver 的 `tests/adapter-contract.test.ts` 对 PG/MySQL 使用同一份业务函数，在模拟 HTTP 下验证 CRUD、预编译参数和事务协议；Oracle 同等 ORM 用例明确标记 TODO。该测试验证调用/协议，不代替真实数据库持久化与隔离验证，也不证明完整 TypeScript/schema 互换。现有远程套件仍按各自支持的 API 验证实际数据库。

后续要完成核心目标，需补齐 Oracle ORM 编译与结果映射，确定跨库 schema、返回结果和方言专属功能的统一边界，再让三库运行同一组真实数据库业务契约测试。TODO 和这些未覆盖项全部解决前，不标记“三库只换 adapter”验收完成。
