import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import dayjs from 'dayjs'
import Components from "unplugin-vue-components/vite";
import { createHtmlPlugin } from 'vite-plugin-html'
import { AntDesignVueResolver } from "unplugin-vue-components/resolvers";

// Build the webview as a self-contained bundle with relative asset paths so the
// extension can load it from disk and rewrite URLs to webview URIs.
// ant-design-vue components are auto-imported on demand (tree-shaken) via
// unplugin-vue-components, so we don't ship the whole library.
export default defineConfig({
  plugins: [
    vue(),
    // 压缩首页html
    createHtmlPlugin({
      minify: true,
      pages: [
        {
          template: 'index.html',
          filename: 'index.html',
          injectOptions: {
            data: {
              buildTime: dayjs().format('YYYY-MM-DD HH:mm:ss'), // 这里就是记录的当前打包的时间。前面的键位名称'buildTime'需要个index.html文件中的相对应
            }
          }
        }
      ]
    }),
    Components({
      dts: false,
      resolvers: [
        AntDesignVueResolver({
          importStyle: false, // v4 uses cssinjs; styles inject at runtime
        }),
      ],
    }),
  ],
  base: "./",
  build: {
      outDir: "dist", //导出目录
      emptyOutDir: true, //是否清空目录
      brotliSize: false, // 设置为false将禁用构建的brotli压缩大小报告。可以稍微提高构建速度
      rollupOptions: {
        treeshake: true, // 开启 Tree Shaking，消除未使用的代码，减小最终的包大小
        onwarn(warning, warn) {
          // 自动过滤空 chunk 警告
          if (warning.code === 'EMPTY_BUNDLE') return
          warn(warning)
        },
        output: {
          // 文件名添加时间戳
          entryFileNames: `assets/[name]-[hash]-${dayjs().format('YYYYMMDDHHmmss')}.js`,
          chunkFileNames: `assets/[name]-[hash]-${dayjs().format('YYYYMMDDHHmmss')}.js`,
          assetFileNames: `assets/[name]-[hash]-${dayjs().format('YYYYMMDDHHmmss')}.[ext]`,
          // 自动拆分 node_modules 中的依赖包
          manualChunks(id) {
            if (id.includes('node_modules')) {
              const match = id.match(/node_modules\/(.+?)(\/|$)/)
              if (match) {
                const packageName = match[1].replace('@', '').replace('/', '-')
                return `vendor-${packageName}`
              }
            }
          },
        },
        // 构建后自动过滤空 chunk
        plugins: [{
          name: 'remove-empty-chunks',
          generateBundle(_, bundle) {
            for (const [key, chunk] of Object.entries(bundle)) {
              if (chunk.type === 'chunk' && chunk.code.trim() === '') {
                delete bundle[key]
              }
            }
          }
        }]
      },
      minify: "terser", //默认为esbuild无法去除生产环境console、debugger
      terserOptions: {
        compress: {
          drop_console: true, // 生产环境删除console
          drop_debugger: true, // 生产环境删除debugger
        },
      },
      chunkSizeWarningLimit: 1000
    },
    generate: {
      favicon: false
    },
});
