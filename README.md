# drizzle-http-driver

核心目标：**业务端无需直连数据库 TCP 端口，通过 HTTP/HTTPS 使用 Drizzle API，初始化时按数据库选择 adapter，业务端使用同一套查询和事务 API，由 adapter 封装数据库差异。** 代理端仍负责数据库原生连接。

当前尚未完全达到“三库只换 adapter”：PG/MySQL 已有 ORM 支持但存在 schema/返回接口差异；Oracle 目前只有 SQL/事务适配器，缺少同等 ORM 查询构建器。目标、分工和验收缺口见 [业务契约](docs/adapter-contract.md)。

通过 HTTP 使用 PostgreSQL / MySQL 的 Drizzle ORM driver，并提供 Oracle SQL 适配器。事务通过服务端固定连接的 `transaction_id` 实现，支持提交、回滚和嵌套保存点。

当前源码为 `0.2.0-rc.0`，尚未发布到 npm；npm 上的 `0.1.3` 只支持 PostgreSQL。

## 安装

```bash
pnpm add drizzle-http-driver drizzle-orm
```

## 模块入口

三个适配器提供独立入口，均导出 `drizzle` 工厂；公共 HTTP 客户端使用 `/client`：

```ts
import { DrizzleProxyClient } from 'drizzle-http-driver/client';
import { drizzle as drizzlePostgres } from 'drizzle-http-driver/postgresql';
import { drizzle as drizzleMySql } from 'drizzle-http-driver/mysql';
import { drizzle as drizzleOracle, oracleBind } from 'drizzle-http-driver/oracle';
```

每个入口只引入对应适配器和必要的共享代码。应用按需要选择一种或多种，不必同时导入三种。

| 入口 | 工厂 | 数据库类 / 配置 |
| --- | --- | --- |
| `/postgresql` | `drizzle` | `HttpPgDatabase` / `DrizzlePostgresConfig` |
| `/mysql` | `drizzle` | `HttpMySqlDatabase` / `DrizzleMySqlConfig` |
| `/oracle` | `drizzle` | `HttpOracleDatabase` / `DrizzleOracleConfig` |
| `/client` | `DrizzleProxyClient` | 公共请求、响应类型及 `DrizzleProxyError` |

根入口只导出公共客户端、错误和协议类型，与 `/client` 相同；不再导出任何数据库工厂。三个子入口均使用 `drizzle`，PostgreSQL 配置类型为 `DrizzlePostgresConfig`，移除旧的 `DrizzleHttpConfig`。这是不兼容的入口调整，调用方需要按上例修改 import。全部入口都提供 ESM、CommonJS 和类型声明。

源码按 `src/driver/postgresql/`、`src/driver/mysql/`、`src/driver/oracle/` 分组；共享传输层位于 `src/http/`。

各目录的 `index.ts` 只负责公开导出，`drizzle.ts` 负责创建数据库实例：

| 适配器 | 内部职责拆分 |
| --- | --- |
| PostgreSQL | `database.ts`、`session.ts`、`transaction.ts`、`prepared-query.ts`、`map-row.ts`、`types.ts` |
| MySQL | `database.ts`、`session.ts`、`transaction.ts`；预编译查询和行映射复用 Drizzle mysql-proxy |
| Oracle | `database.ts` 提供 SQL 执行和事务对象生命周期，`transaction.ts` 处理事务/保存点协议，`bindings.ts` 提供类型化绑定，`types.ts` 定义配置 |

文件按实际职责划分，不为统一数量添加空模块。Oracle 保留 SQL 适配器结构，没有额外模拟 ORM Session 层。


## 创建数据库实例

schema、logger 和 casing 等 Drizzle 配置仍然传给 `drizzle`：

```ts
import { DrizzleProxyClient } from 'drizzle-http-driver/client';
import { drizzle } from 'drizzle-http-driver/postgresql';

import * as schema from './schema';

const client = new DrizzleProxyClient({
  endpoint: process.env.DB_PROXY_ENDPOINT!,
  token: process.env.DB_PROXY_TOKEN!,
  key: process.env.DB_PROXY_KEY!,
});

export const db = drizzle(client, { schema });
```

配置按照 `endpoint → token → key` 的顺序定位数据库：

1. `endpoint`：接收 Drizzle 查询请求的 HTTP 端点。
2. `token`：租户级访问令牌，用于识别租户并验证该租户的访问权限。driver 会将它写入 `x-db-token` 请求头。
3. `key`：当前租户下已经配置好的完整数据库连接标识，例如 `dev`、`staging` 或 `prod`。它代表一套完整数据库连接配置，而不只是数据库名称。

因此，同一个 endpoint 可以服务多个租户；一个租户通过 token 完成权限校验后，再使用 key 选择该租户下具体的数据库连接。

之后直接使用标准 Drizzle API：

```ts
import { eq } from 'drizzle-orm';

const rows = await db.select().from(schema.users);

await db
  .update(schema.users)
  .set({ name: 'new name' })
  .where(eq(schema.users.id, userId));
```

## 事务

顶层事务会生成一个 `transaction_id`。事务内的所有 HTTP 请求都会携带相同的 id，
服务端必须让这个 id 始终命中同一条数据库连接。

```ts
await db.transaction(async (tx) => {
  const [user] = await tx
    .insert(schema.users)
    .values({ name: 'Ada' })
    .returning();

  await tx.insert(schema.profiles).values({ userId: user.id });

  await tx.transaction(async (nested) => {
    await nested.insert(schema.auditLogs).values({ userId: user.id });
  });
}, {
  accessMode: 'read write',
  isolationLevel: 'serializable',
});
```

成功时 driver 执行 `commit`；异常或 `tx.rollback()` 时调用 release 接口，由代理执行
`rollback` 并释放连接。嵌套事务使用 `savepoint`。

## HTTP 协议

`endpoint` 必须是完整的查询地址，例如 `https://example.com/api/query`。driver 先通过请求头中的 `token` 确认租户访问权限，再通过请求体中的 `key` 定位该租户下的数据库连接：

```http
POST <endpoint>
content-type: application/json
x-db-token: <tenant-access-token>
```

```json
{
  "key": "prod",
  "method": "all",
  "params": [1],
  "sql": "select * from users where id = $1",
  "transaction_id": "optional-transaction-id"
}
```

- `method: "all"`：服务端返回对象行。
- `method: "values"`：服务端必须按 SQL 列顺序返回数组行，供 Drizzle 完成字段解码。
- 非事务请求不发送 `transaction_id`；事务请求使用 driver 生成的同一个 id。
- `x-db-token` 携带租户访问令牌；`key` 只能在该 token 对应的租户范围内解析。

代理返回统一的成功响应，driver 会解包其中的 `data` 交给 Drizzle：

```json
{
  "success": true,
  "data": {
    "command": "SELECT",
    "fields": [],
    "oid": 0,
    "rowCount": 1,
    "rows": [{ "id": 1 }],
    "timing": {
      "coldStart": false,
      "startedAt": 1792600000000,
      "tokenStartedAt": 1792600000001,
      "dbConfigStartedAt": 1792600000002,
      "connectionStartedAt": 1792600000004,
      "connectionEstablishedAt": 1792600000006,
      "endedAt": 1792600000012
    }
  }
}
```

`timing` 是可选字段：PostgreSQL/MySQL 响应包含计时，Oracle 当前不返回。

任何非 2xx HTTP 状态码都会使整次请求失败。失败响应中的 `error` 会作为
`DrizzleProxyError` 的错误消息：

```json
{
  "success": false,
  "error": "permission denied for table users"
}
```

事务未正常结束时，driver 向 `${endpoint}/release`（即文档中的
`/api/query/release`）发送：

```json
{
  "key": "prod",
  "transaction_id": "transaction-uuid"
}
```

release 请求继续使用同一个租户 token 和数据库 key。代理即使找不到对应事务，也会返回
`{ "success": true, "data": null }`；driver 会校验这份统一响应。`commit` 成功后代理已经
释放连接（PostgreSQL/MySQL），driver 不再重复调用 release。Oracle 的 commit 保留固定会话，因此 driver 会继续调用 release。

## 请求配置

`DrizzleProxyConfig` 支持额外 headers 和共享 `requestInit`。请求固定使用 JSON，序列化时
会把 `bigint` 转成十进制字符串。

```ts
const client = new DrizzleProxyClient({
  endpoint: 'https://example.com/api/query',
  token: process.env.DB_PROXY_TOKEN!,
  key: 'prod',
  headers: { 'x-client-name': 'admin-api' },
});
```

## 构建和发布

```bash
pnpm install
pnpm build
pnpm test:exports
pnpm publish
```

Vite 会在 `dist` 中生成 ESM、CommonJS、类型声明。


## MySQL

使用 `drizzle-orm/mysql-core` 定义 schema，通过 `drizzleMySql` 创建实例：

```ts
import { DrizzleProxyClient } from 'drizzle-http-driver/client';
import { drizzle as drizzleMySql } from 'drizzle-http-driver/mysql';
import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { eq, sql } from 'drizzle-orm';

const users = mysqlTable('users', {
  id: int().primaryKey().autoincrement(),
  name: varchar({ length: 255 }).notNull(),
});
const db = drizzleMySql(new DrizzleProxyClient({ endpoint, token, key: 'mysql' }), {
  schema: { users },
});
const ids = await db.insert(users).values({ name: 'Ada' }).$returningId();
const byId = db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare();
await byId.execute({ id: ids[0].id });
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Grace' });
  await tx.transaction(async (nested) => {
    await nested.insert(users).values({ name: 'Katherine' });
  });
}, { isolationLevel: 'read committed', accessMode: 'read write' });
```

支持 CRUD、`$returningId()`、关联查询、预编译占位符、CTE、分页、事务及嵌套保存点。原始 `db.execute()` 返回 mysql2 风格的 `[rowsOrHeader, fields]`。MySQL 不支持 PostgreSQL 的 `.returning()`；HTTP 驱动不支持流式 `.iterator()`。保存点要求使用 InnoDB。

带事务配置的首次请求发送 `transaction_options`。服务端必须部署本轮更新：先在固定连接上执行 `SET TRANSACTION`，再执行 `START TRANSACTION`，避免修改连接池会复用的会话默认配置。旧版服务端不支持这个协议。

## Oracle SQL 适配器

Drizzle ORM 0.45.2 没有原生 Oracle dialect、Oracle table schema 或 Oracle ORM 查询构建器。本适配器提供 `sql` 模板、`sql.identifier()`、`sql.placeholder()`、`prepare().execute()`、`execute()`、`all()`、`values()`、`transaction()` 和 `rollback()`；**不提供 Oracle 的 `.select().from()`、`.insert()` 或关系查询**。

```ts
import { DrizzleProxyClient } from 'drizzle-http-driver/client';
import { drizzle as drizzleOracle, oracleBind } from 'drizzle-http-driver/oracle';
import { sql } from 'drizzle-orm';

const db = drizzleOracle(new DrizzleProxyClient({ endpoint, token, key: 'oracle' }));
const byId = db.prepare(sql`SELECT ID, NAME FROM USERS WHERE ID = ${sql.placeholder('id')}`);
const { rows } = await byId.execute({ id: 1 });
await db.transaction(async (tx) => {
  await tx.execute(sql`INSERT INTO USERS(ID, NAME) VALUES (${2}, ${'Ada'})`);
  try {
    await tx.transaction(async (nested) => {
      await nested.execute(sql`UPDATE USERS SET NAME=${'temporary'} WHERE ID=${2}`);
      nested.rollback();
    });
  } catch { /* outer transaction may continue after savepoint rollback */ }
});
// Oracle's RAW/BLOB parameters are hexadecimal; CLOB/NCLOB values are text.
await db.execute(sql`INSERT INTO FILES(ID, CONTENT) VALUES (${1}, ${oracleBind('CLOB', '正文')})`);
```

`sql` 的语法树直接编译为 `:1`, `:2` 等绑定，不对 SQL 字符串做占位符替换。`execute()` 返回完整代理结果，`all()` 返回对象行，`values()` 返回有序数组行；不会自动推断列类型或运行 ORM 列解码器。NUMBER 返回精确十进制字符串，RAW/BLOB 返回十六进制文本。DATE/TIMESTAMP 查询必须使用 `TO_CHAR` 显式保留格式/精度，写入使用 `TO_DATE` / `TO_TIMESTAMP`；裸时间列会返回 `TEMPORAL_TEXT_REQUIRED`。不要把非 Oracle 的表定义传给本适配器。

Oracle 支持 `read committed` / `serializable` 隔离级别，以及 `read only` / `read write` 访问模式。只读与隔离级别不能组合；`read write` 为默认写入模式，设置隔离级别时无需另外发出一条 `SET TRANSACTION`。嵌套事务使用 `SAVEPOINT` / `ROLLBACK TO`，成功时不发送 Oracle 不支持的 `RELEASE SAVEPOINT`。最外层提交之后主动调用 `/release` 回收固定连接。

Oracle 测试数据库要求 Thick 模式和 Oracle Instant Client；服务端还需满足原生网络加密要求。MySQL / Oracle 的 DDL 可能隐式提交，不能依赖事务回滚 DDL。

## 事务与故障边界

- 在回调中 await 所有工作；事务或保存点回调结束后，三种适配器都在本地拒绝继续使用该事务对象及其查询。嵌套事务按顺序 await，重叠的同级嵌套事务会被拒绝。
- `requestInit.signal` 取消查询后，清理请求使用独立的 30 秒超时信号，避免已取消的信号阻止回滚。
- 回调抛错或 `tx.rollback()` 会通过 `/release` 回滚并释放连接；清理也失败时用 `AggregateError` 保留两个错误。
- 网络失败、超时和提交响应丢失都不会自动重试写入。提交响应丢失时结果可能已提交，需要业务幂等键或查询确认。
- PostgreSQL 服务端保留时间、interval 及 numeric/时间数组原始文本供 Drizzle 解码；MySQL 参数采用原生绑定，保留字面量/注释中的问号，并兼容分页整数。

## 开发与远程验收

`tests/adapter-contract.test.ts` 验证共享业务调用：PG/MySQL 的模拟 HTTP 用例已覆盖，Oracle ORM 用例明确为 TODO。`pnpm test` 中 TODO 不计为已通过；完整目标仍需三库共享的真实数据库契约验收，详见 [业务契约](docs/adapter-contract.md)。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:exports
# drizzle-proxy 默认位于相邻目录；也可用 DRIZZLE_PROXY_ROOT 指定绝对路径。
pnpm test:postgresql
pnpm test:mysql
UV_THREADPOOL_SIZE=32 ORACLE_DRIVER_MODE=thick \
  ORACLE_CLIENT_LIB_DIR=/absolute/path/to/instantclient \
  pnpm test:oracle
```

远程测试依赖 `drizzle-proxy` 仓库和其中的 `docs/database-connections.md` 测试账号配置。脚本启动本地真实 HTTP 路由和独立线程 TCP 中继，使用唯一命名测试表并在 finally 中清理；测试报告不记录凭据。

`pnpm test:remote` 顺序执行 PostgreSQL、MySQL、Oracle，每种数据库使用独立进程；也可用 `TEST_DIALECT=postgresql|mysql|oracle` 或上述分类命令只运行一种。非法数据库名称会直接失败。运行 Oracle 前需设置示例中的 Thick 环境变量。

PostgreSQL 复用代理仓库的 `server/tests/postgresql/drizzle.ts`，默认加载本包 `dist/postgresql.js`，需先执行 `pnpm build`；可以用 `DRIZZLE_DRIVER_ENTRY` 指定其他构建入口。MySQL/Oracle 运行本仓库 `tests/remote-integrity.ts`，加载本包源码。

支持 `TEST_CASE` 正则过滤和 `TEST_REPORT` JSON 结果路径。单数据库写指定路径；三库聚合运行分别写 `<TEST_REPORT>.<dialect>.json`。报告目录必须存在，完整验收不要设置 `TEST_CASE`。

本轮实际验收结果见 [三库测试报告](docs/test-report-2026-09-27.md)。

显式事务外执行（需先部署支持 transaction_mode 的代理）：`await client.query({ text: 'VACUUM', transactionMode: 'none' })`。只能使用非事务 client，不能同时传 transactionOptions；普通 query 的默认行为保持不变。
