# drizzle-http-driver

一个通过 HTTP 使用 PostgreSQL 的 Drizzle ORM driver。查询 API 与 Drizzle PostgreSQL 保持一致，并通过服务端绑定 `transaction_id` 的方式支持事务、嵌套事务和 savepoint。

## 安装

```bash
pnpm add drizzle-http-driver drizzle-orm
```

## 创建数据库实例

schema、logger 和 casing 等 Drizzle 配置仍然传给 `drizzle`：

```ts
import { drizzle, DrizzleProxyClient } from 'drizzle-http-driver';

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
服务端必须让这个 id 始终命中同一个 PostgreSQL connection。

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
释放连接，driver 不再重复调用 release。

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
pnpm publish
```

Vite 会在 `dist` 中生成 ESM、CommonJS、类型声明。
