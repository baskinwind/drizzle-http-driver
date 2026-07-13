# drizzle-http-driver

一个通过 HTTP 使用 PostgreSQL 的 Drizzle ORM driver。查询 API 与 Drizzle PostgreSQL 保持一致，并通过服务端绑定 `transaction_id` 的方式支持事务、嵌套事务和 savepoint。

## 安装

```bash
pnpm add drizzle-http-driver drizzle-orm
```

## 创建数据库实例

入口写法与 `node-postgres` driver 一致，schema、logger、casing 和 cache 等配置仍然传给
`drizzle`：

```ts
import { drizzle, DrizzleProxyPool } from 'drizzle-http-driver';

import * as schema from './schema';

const pool = new DrizzleProxyPool({
  endpoint: process.env.DB_PROXY_ENDPOINT!,
  token: process.env.DB_PROXY_TOKEN!,
  key: process.env.DB_PROXY_KEY!,
});

export const db = drizzle(pool, { schema });
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

成功时 driver 执行 `commit`，异常或 `tx.rollback()` 时执行 `rollback`。嵌套事务使用
`savepoint`。无论事务结果如何，driver 最后都会等待 release 请求完成。

## HTTP 协议

查询请求发送到 `endpoint`。driver 先通过请求头中的 `token` 确认租户访问权限，再通过请求体中的 `key` 定位该租户下的数据库连接：

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
  "transaction_id": "optional-uuid"
}
```

- `method: "all"`：服务端返回对象行。
- `method: "values"`：服务端必须按 SQL 列顺序返回数组行，供 Drizzle 完成字段解码。
- 非事务请求不包含有效的 `transaction_id`。
- `x-db-token` 携带租户访问令牌；`key` 只能在该 token 对应的租户范围内解析。

查询响应：

```json
{
  "command": "SELECT",
  "fields": [],
  "oid": 0,
  "rowCount": 1,
  "rows": [{ "id": 1 }]
}
```

事务结束后，driver 默认向 `${endpoint}/release` 发送：

```json
{
  "key": "prod",
  "transaction_id": "transaction-uuid"
}
```

release 请求继续使用同一个租户 token 和数据库 key。可通过 `releasePath` 修改追加路径；
release 接口应释放并删除服务端保存的 connection。

## 自定义传输

`DrizzleProxyConfig` 支持自定义 `fetch`、额外 headers、动态租户 token、共享 `requestInit`、序列化与响应解析。默认序列化会把 `bigint` 转成十进制字符串。

```ts
const pool = new DrizzleProxyPool({
  endpoint: 'https://example.com/drizzle',
  token: async () => getTenantAccessToken(),
  key: 'prod',
  headers: { 'x-client-name': 'admin-api' },
  releasePath: 'release',
});
```

## 构建和发布

```bash
pnpm install
pnpm build
pnpm publish
```

Vite 会在 `dist` 中生成 ESM、CommonJS、类型声明。
