import { resolve } from 'node:path';

import dts from 'unplugin-dts/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: Object.fromEntries(['index', 'client', 'postgresql', 'mysql', 'oracle'].map(name => [name, resolve(import.meta.dirname, `src/${name}.ts`)])),
      fileName: (format, name) => `${name}.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [/^drizzle-orm(?:\/.*)?$/],
    },
    sourcemap: false,
  },
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src/**/*.ts'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
});
