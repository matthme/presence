import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      // ...
      'simple-peer': '@matthme/simple-peer/simplepeer.min.js',
    },
  },
  plugins: [
    checker({
      typescript: true,
      // eslint: {
      //   lintCommand: 'eslint --ext .ts,.html . --ignore-path .gitignore',
      // },
    }),
    viteStaticCopy({
      targets: [
        {
          src: "icon.png",
          dest: ".",
        },
        {
          src: "public",
          dest: "."
        }
      ]
    })
  ],
  define: {
    '__APP_VERSION__': JSON.stringify(process.env.npm_package_version),
}
});
