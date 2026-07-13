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
  key: process.env.DB_PROXY_KEY!,
  token: process.env.DB_PROXY_TOKEN!,
});

export const db = drizzle(pool, { schema });
```

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

查询请求发送到 `endpoint`：

```json
{
  "key": "database-key",
  "method": "all",
  "params": [1],
  "sql": "select * from users where id = $1",
  "transaction_id": "optional-uuid"
}
```

- `method: "all"`：服务端返回对象行。
- `method: "values"`：服务端必须按 SQL 列顺序返回数组行，供 Drizzle 完成字段解码。
- 非事务请求不包含有效的 `transaction_id`。
- 请求头包含 `content-type: application/json` 和 `x-db-token`。

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
  "key": "database-key",
  "transaction_id": "transaction-uuid"
}
```

可通过 `releasePath` 修改追加路径。release 接口应释放并删除服务端保存的 connection。

## 自定义传输

`DrizzleProxyConfig` 支持自定义 `fetch`、额外 headers、动态 token、共享
`requestInit`、序列化与响应解析。默认序列化会把 `bigint` 转成十进制字符串。

```ts
const pool = new DrizzleProxyPool({
  endpoint: 'https://example.com/drizzle',
  key: 'main',
  token: async () => getShortLivedToken(),
  headers: async () => ({ 'x-tenant-id': await getTenantId() }),
  releasePath: 'release',
});
```

## 构建和发布

```bash
pnpm install
pnpm build
pnpm publish
```

Vite 会在 `dist` 中生成 ESM、CommonJS、类型声明和 source map。
